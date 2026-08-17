import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DB } from '../db/index.js';
import type { Mailer } from './mailer.js';

vi.mock('../db/member-queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/member-queries.js')>();
  return {
    ...actual,
    getUserByEmail: vi.fn(),
    getMemberById: vi.fn(),
  };
});

vi.mock('../db/user-queries.js', () => ({
  updateUserPassword: vi.fn(),
}));

vi.mock('../repositories/auth-email-token-repository.js', () => ({
  issueAuthEmailToken: vi.fn(),
  consumeAuthEmailToken: vi.fn(),
}));

vi.mock('../repositories/refresh-token-repository.js', () => ({
  revokeAllUserTokens: vi.fn(),
}));

vi.mock('../utils/password.js', () => ({
  hashPassword: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getMemberById, getUserByEmail } from '../db/member-queries.js';
import { updateUserPassword } from '../db/user-queries.js';
import {
  consumeAuthEmailToken,
  issueAuthEmailToken,
} from '../repositories/auth-email-token-repository.js';
import { revokeAllUserTokens } from '../repositories/refresh-token-repository.js';
import { hashPassword } from '../utils/password.js';
import { logger } from '../utils/logger.js';
import {
  PasswordResetService,
  dispatchPasswordResetEmail,
} from './password-reset-service.js';

const member = {
  id: 7,
  username: 'jane@example.com',
  email: 'jane@example.com',
  password_hash: 'old-hash',
  role_id: 3,
  role_name: 'member',
  is_system_role: true,
  status: 'active' as const,
  email_verified_at: '2026-08-14T00:00:00Z',
  created_at: '2026-08-14T00:00:00Z',
};

describe('PasswordResetService', () => {
  let db: DB;
  let sentMail: Array<{ to: string; subject: string; text: string; html?: string }>;
  let mailer: Mailer;
  let service: PasswordResetService;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_WEB_ORIGIN = 'http://localhost:3000';
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    db = {
      query,
      transaction: vi.fn(async (callback) => callback({ query })),
    } as unknown as DB;
    sentMail = [];
    mailer = {
      send: vi.fn(async (message) => {
        sentMail.push(message);
      }),
    };
    service = new PasswordResetService(db, mailer);
    vi.mocked(hashPassword).mockResolvedValue('new-hash');
  });

  describe('sendPasswordResetEmail', () => {
    it('sends a reset link to a Member after normalizing the email', async () => {
      vi.mocked(getUserByEmail).mockResolvedValue(member);
      vi.mocked(issueAuthEmailToken).mockResolvedValue('raw-reset-token');

      await service.sendPasswordResetEmail(' Jane@Example.com ');

      expect(getUserByEmail).toHaveBeenCalledWith(db, 'jane@example.com');
      expect(issueAuthEmailToken).toHaveBeenCalledWith(db, 7, 'password_reset');
      expect(sentMail).toHaveLength(1);
      expect(sentMail[0].to).toBe('jane@example.com');
      expect(sentMail[0].subject).toMatch(/reset/i);
      expect(sentMail[0].text).toContain('/reset-password?token=raw-reset-token');
      expect(sentMail[0].text).toContain('30 minutes');
      expect(logger.info).toHaveBeenCalledWith(
        'Password reset email sent',
        expect.objectContaining({ userId: 7, emailHash: expect.any(String) }),
      );
    });

    it('does not send a reset email to Staff', async () => {
      vi.mocked(getUserByEmail).mockResolvedValue({
        ...member,
        role_name: 'admin',
        email: 'admin@example.com',
      });

      await service.sendPasswordResetEmail('admin@example.com');

      expect(issueAuthEmailToken).not.toHaveBeenCalled();
      expect(sentMail).toHaveLength(0);
      expect(logger.info).toHaveBeenCalledWith(
        'Password reset request ignored',
        expect.objectContaining({ reason: 'not_member', emailHash: expect.any(String) }),
      );
    });

    it('does not send a reset email for an unknown address', async () => {
      vi.mocked(getUserByEmail).mockResolvedValue(undefined);

      await service.sendPasswordResetEmail('nobody@example.com');

      expect(issueAuthEmailToken).not.toHaveBeenCalled();
      expect(sentMail).toHaveLength(0);
    });
  });

  describe('confirmPasswordReset', () => {
    it('changes the password, revokes every Session, and sends confirmation mail', async () => {
      vi.mocked(consumeAuthEmailToken).mockResolvedValue(7);
      vi.mocked(getMemberById).mockResolvedValue(member);

      await expect(service.confirmPasswordReset('raw-reset-token', 'NewPass123!')).resolves.toBe(true);

      expect(consumeAuthEmailToken).toHaveBeenCalledWith(expect.objectContaining({ query: expect.any(Function) }), 'raw-reset-token', 'password_reset');
      expect(hashPassword).toHaveBeenCalledWith('NewPass123!');
      expect(updateUserPassword).toHaveBeenCalledWith(expect.objectContaining({ query: expect.any(Function) }), 7, 'new-hash');
      expect(revokeAllUserTokens).toHaveBeenCalledWith(expect.objectContaining({ query: expect.any(Function) }), 7);
      expect(sentMail).toHaveLength(1);
      expect(sentMail[0].to).toBe('jane@example.com');
      expect(sentMail[0].subject).toMatch(/password.*changed/i);
      expect(sentMail[0].text).not.toContain('raw-reset-token');
    });

    it('rejects an unknown, expired, or already-used token without changing a password', async () => {
      vi.mocked(consumeAuthEmailToken).mockResolvedValue(null);

      await expect(service.confirmPasswordReset('stale-token', 'NewPass123!')).resolves.toBe(false);

      expect(getMemberById).not.toHaveBeenCalled();
      expect(updateUserPassword).not.toHaveBeenCalled();
      expect(revokeAllUserTokens).not.toHaveBeenCalled();
    });

    it('rejects a token that no longer belongs to a Member', async () => {
      vi.mocked(consumeAuthEmailToken).mockResolvedValue(7);
      vi.mocked(getMemberById).mockResolvedValue(undefined);

      await expect(service.confirmPasswordReset('staff-token', 'NewPass123!')).resolves.toBe(false);

      expect(updateUserPassword).not.toHaveBeenCalled();
      expect(revokeAllUserTokens).not.toHaveBeenCalled();
    });

    it('validates password strength before consuming the token', async () => {
      await expect(service.confirmPasswordReset('raw-reset-token', 'weak')).rejects.toThrow(
        'Password must be at least 8 characters',
      );

      expect(consumeAuthEmailToken).not.toHaveBeenCalled();
    });

    it('keeps a successful reset successful when confirmation mail fails', async () => {
      vi.mocked(consumeAuthEmailToken).mockResolvedValue(7);
      vi.mocked(getMemberById).mockResolvedValue(member);
      vi.mocked(mailer.send).mockRejectedValue(new Error('SMTP down'));

      await expect(service.confirmPasswordReset('raw-reset-token', 'NewPass123!')).resolves.toBe(true);

      expect(updateUserPassword).toHaveBeenCalled();
      expect(revokeAllUserTokens).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Password reset confirmation email failed',
        expect.objectContaining({ userId: 7 }),
      );
    });
  });

  describe('dispatchPasswordResetEmail', () => {
    it('is fire-and-forget and logs infrastructure failures', async () => {
      vi.mocked(getUserByEmail).mockRejectedValue(new Error('token store down'));

      expect(() => dispatchPasswordResetEmail(db, 'jane@example.com')).not.toThrow();

      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          'Password reset email dispatch failed',
          expect.objectContaining({ email: 'jane@example.com' }),
        );
      });
    });
  });
});

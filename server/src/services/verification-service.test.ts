import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DB } from '../db/index.js';
import type { Mailer } from './mailer.js';

vi.mock('../db/member-queries.js', () => ({
  getUserByEmail: vi.fn(),
}));

vi.mock('../repositories/auth-email-token-repository.js', () => ({
  issueAuthEmailToken: vi.fn(),
  consumeAuthEmailToken: vi.fn(),
}));

import { VerificationService } from './verification-service.js';
import { getUserByEmail } from '../db/member-queries.js';
import {
  issueAuthEmailToken,
  consumeAuthEmailToken,
} from '../repositories/auth-email-token-repository.js';

describe('VerificationService', () => {
  let mockDb: DB;
  let sentMail: Array<{ to: string; subject: string; text: string; html?: string }>;
  let mailer: Mailer;
  let service: VerificationService;

  const unverifiedMember = {
    id: 7,
    username: 'jane@example.com',
    email: 'jane@example.com',
    password_hash: 'hash',
    role_id: 3,
    role_name: 'member',
    is_system_role: true,
    status: 'unverified' as const,
    email_verified_at: null,
    created_at: '2026-08-14T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) } as unknown as DB;
    sentMail = [];
    mailer = { send: vi.fn(async (m) => { sentMail.push(m); }) };
    service = new VerificationService(mockDb, mailer);
  });

  describe('sendVerificationEmail', () => {
    it('issues a token and sends the verification link to an unverified Member', async () => {
      vi.mocked(getUserByEmail).mockResolvedValue(unverifiedMember);
      vi.mocked(issueAuthEmailToken).mockResolvedValue('raw-token-abc');

      await service.sendVerificationEmail('Jane@Example.com');

      // Lookup is normalized (trim + lowercase).
      expect(getUserByEmail).toHaveBeenCalledWith(mockDb, 'jane@example.com');
      expect(issueAuthEmailToken).toHaveBeenCalledWith(mockDb, 7, 'email_verification');
      expect(sentMail).toHaveLength(1);
      expect(sentMail[0].to).toBe('jane@example.com');
      expect(sentMail[0].subject).toMatch(/confirm/i);
      expect(sentMail[0].text).toContain('/verify?token=raw-token-abc');
      expect(sentMail[0].html).toContain('/verify?token=raw-token-abc');
      // The token lifetime policy is stated in the copy.
      expect(sentMail[0].text).toContain('30 minutes');
    });

    it('sends nothing when the email belongs to no user', async () => {
      vi.mocked(getUserByEmail).mockResolvedValue(undefined);

      await service.sendVerificationEmail('nobody@example.com');

      expect(issueAuthEmailToken).not.toHaveBeenCalled();
      expect(sentMail).toHaveLength(0);
    });

    it('sends nothing to a Staff account (email-keyed flows are Member-only)', async () => {
      vi.mocked(getUserByEmail).mockResolvedValue({
        ...unverifiedMember,
        role_name: 'admin',
        email: 'admin@example.com',
      });

      await service.sendVerificationEmail('admin@example.com');

      expect(issueAuthEmailToken).not.toHaveBeenCalled();
      expect(sentMail).toHaveLength(0);
    });

    it('sends nothing to an already-verified Member', async () => {
      vi.mocked(getUserByEmail).mockResolvedValue({
        ...unverifiedMember,
        status: 'active',
        email_verified_at: '2026-08-14T01:00:00Z',
      });

      await service.sendVerificationEmail('jane@example.com');

      expect(issueAuthEmailToken).not.toHaveBeenCalled();
      expect(sentMail).toHaveLength(0);
    });

    it('swallows a mailer failure (best-effort send never throws)', async () => {
      vi.mocked(getUserByEmail).mockResolvedValue(unverifiedMember);
      vi.mocked(issueAuthEmailToken).mockResolvedValue('raw-token-abc');
      mailer = { send: vi.fn(async () => { throw new Error('SMTP down'); }) };
      service = new VerificationService(mockDb, mailer);

      await expect(service.sendVerificationEmail('jane@example.com')).resolves.toBeUndefined();
    });
  });

  describe('verifyEmail', () => {
    it('marks the Member verified and active for a valid token', async () => {
      vi.mocked(consumeAuthEmailToken).mockResolvedValue(7);

      const ok = await service.verifyEmail('raw-token-abc');

      expect(ok).toBe(true);
      expect(consumeAuthEmailToken).toHaveBeenCalledWith(
        mockDb,
        'raw-token-abc',
        'email_verification',
      );
      const [sql, params] = vi.mocked(mockDb.query).mock.calls[0];
      expect(String(sql)).toContain('email_verified_at = NOW()');
      // unverified → active; a suspended Member stays suspended.
      expect(String(sql)).toContain("WHEN status = 'unverified' THEN 'active'");
      expect(params).toEqual([7]);
    });

    it('rejects an unknown token', async () => {
      vi.mocked(consumeAuthEmailToken).mockResolvedValue(null);

      expect(await service.verifyEmail('bogus')).toBe(false);
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('rejects an empty token without hitting the store', async () => {
      expect(await service.verifyEmail('')).toBe(false);
      expect(consumeAuthEmailToken).not.toHaveBeenCalled();
    });
  });
});

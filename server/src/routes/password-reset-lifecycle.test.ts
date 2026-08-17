process.env.JWT_SECRET = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { DB } from '../db/index.js';
import authRouter from './auth.js';
import { errorHandler } from '../middleware/error-handler.js';

vi.mock('../middleware/rate-limit.js', () => {
  const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    authLimiter: passThrough,
    registerLimiter: passThrough,
    verificationLimiter: passThrough,
    passwordResetLimiter: passThrough,
    passwordResetEmailLimiter: passThrough,
  };
});

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/permission.js', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../services/session-service.js', () => ({ SessionService: class {} }));
vi.mock('../services/auth-service.js', () => ({ AuthService: class {} }));
vi.mock('../services/verification-service.js', () => ({
  VerificationService: class {},
  dispatchVerificationEmail: vi.fn(),
  getPublicWebOrigin: () => 'http://localhost:3000',
}));
vi.mock('../db/member-queries.js', () => ({
  getUserByEmail: vi.fn(),
  getMemberById: vi.fn(),
}));
vi.mock('../db/user-queries.js', () => ({ updateUserPassword: vi.fn() }));
vi.mock('../repositories/auth-email-token-repository.js', () => ({
  issueAuthEmailToken: vi.fn(),
  consumeAuthEmailToken: vi.fn(),
}));
vi.mock('../repositories/refresh-token-repository.js', () => ({ revokeAllUserTokens: vi.fn() }));
vi.mock('../utils/password.js', () => ({ hashPassword: vi.fn() }));
vi.mock('../services/mailer.js', () => ({
  getMailer: () => ({ send: vi.fn().mockResolvedValue(undefined) }),
}));

import { getMemberById } from '../db/member-queries.js';
import { updateUserPassword } from '../db/user-queries.js';
import { consumeAuthEmailToken } from '../repositories/auth-email-token-repository.js';
import { revokeAllUserTokens } from '../repositories/refresh-token-repository.js';
import { hashPassword } from '../utils/password.js';

describe('Password reset route lifecycle', () => {
  const query = vi.fn();
  const db = {
    query,
    transaction: vi.fn(async (callback) => callback({ query })),
  } as unknown as DB;
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.set('db', db);
    app.use('/api/auth', authRouter);
    app.use(errorHandler);
    vi.clearAllMocks();
    vi.mocked(hashPassword).mockResolvedValue('new-hash');
  });

  it('revokes every Session through the public confirmation route', async () => {
    vi.mocked(consumeAuthEmailToken).mockResolvedValue(7);
    vi.mocked(getMemberById).mockResolvedValue({
      id: 7,
      username: 'jane@example.com',
      email: 'jane@example.com',
      password_hash: 'old-hash',
      role_id: 3,
      role_name: 'member',
      is_system_role: true,
      status: 'active',
      email_verified_at: '2026-08-14T00:00:00Z',
      created_at: '2026-08-14T00:00:00Z',
    });

    const response = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token: 'raw-token', newPassword: 'NewPass123!' });

    expect(response.status).toBe(200);
    expect(updateUserPassword).toHaveBeenCalledWith(expect.objectContaining({ query }), 7, 'new-hash');
    expect(revokeAllUserTokens).toHaveBeenCalledWith(expect.objectContaining({ query }), 7);
  });
});

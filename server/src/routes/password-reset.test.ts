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

vi.mock('../services/session-service.js', () => ({
  SessionService: class {},
}));

vi.mock('../services/auth-service.js', () => ({
  AuthService: class {},
}));

vi.mock('../services/verification-service.js', () => ({
  VerificationService: class {},
  dispatchVerificationEmail: vi.fn(),
}));

vi.mock('../services/password-reset-service.js', () => {
  const sendPasswordResetEmail = vi.fn();
  const confirmPasswordReset = vi.fn();
  const dispatchPasswordResetEmail = vi.fn();
  return {
    PasswordResetService: class {
      sendPasswordResetEmail = sendPasswordResetEmail;
      confirmPasswordReset = confirmPasswordReset;
    },
    dispatchPasswordResetEmail,
    __mockSendPasswordResetEmail: sendPasswordResetEmail,
    __mockConfirmPasswordReset: confirmPasswordReset,
    __mockDispatchPasswordResetEmail: dispatchPasswordResetEmail,
  };
});

describe('Password reset routes', () => {
  const db = { query: vi.fn() } as unknown as DB;
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.set('db', db);
    app.use('/api/auth', authRouter);
    app.use(errorHandler);
    vi.clearAllMocks();
  });

  it('returns the same successful response for known and unknown email addresses', async () => {
    const known = await request(app)
      .post('/api/auth/password-reset/request')
      .send({ email: 'jane@example.com' });
    const unknown = await request(app)
      .post('/api/auth/password-reset/request')
      .send({ email: 'nobody@example.com' });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(known.body.data.message).toMatch(/reset link/i);
  });

  it('dispatches reset email work after accepting a request', async () => {
    const { __mockDispatchPasswordResetEmail } = await import('../services/password-reset-service.js');

    await request(app)
      .post('/api/auth/password-reset/request')
      .send({ email: 'jane@example.com' })
      .expect(200);

    expect(__mockDispatchPasswordResetEmail).toHaveBeenCalledWith(db, 'jane@example.com');
  });

  it('returns 200 for a request without an email and does not dispatch', async () => {
    const { __mockDispatchPasswordResetEmail } = await import('../services/password-reset-service.js');

    const response = await request(app)
      .post('/api/auth/password-reset/request')
      .send({});

    expect(response.status).toBe(200);
    expect(__mockDispatchPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('confirms a valid reset and returns the login redirect contract', async () => {
    const { __mockConfirmPasswordReset } = await import('../services/password-reset-service.js');
    __mockConfirmPasswordReset.mockResolvedValue(true);

    const response = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token: 'raw-token', newPassword: 'NewPass123!' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: {
        message: 'Password reset successfully. Please sign in again.',
      },
    });
    expect(__mockConfirmPasswordReset).toHaveBeenCalledWith('raw-token', 'NewPass123!');
  });

  it('rejects an expired, unknown, or reused token with one generic message', async () => {
    const { __mockConfirmPasswordReset } = await import('../services/password-reset-service.js');
    __mockConfirmPasswordReset.mockResolvedValue(false);

    const response = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token: 'stale-token', newPassword: 'NewPass123!' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: 'This password reset link is invalid or has expired',
    });
  });

  it('rejects missing confirmation fields before calling the service', async () => {
    const { __mockConfirmPasswordReset } = await import('../services/password-reset-service.js');

    const response = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token: 'raw-token' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Reset token and new password are required');
    expect(__mockConfirmPasswordReset).not.toHaveBeenCalled();
  });
});

// Exercises the REAL rate-limit middleware (not mocked away like the sibling
// route tests): the password-reset request endpoint's two-axis throttle
// (per-IP + per-email, ADR 0006 sub-decision 6) and the confirm endpoint's
// shared-IP budget on the auth (failed-attempt) limiter.
//
// The env overrides below must run before the auth router (and through it
// the rate-limit middleware) is imported, so the router is imported
// dynamically after them — vi.mock calls are hoisted above everything and
// still apply.
process.env.JWT_SECRET = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6';

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { DB } from '../db/index.js';
import { errorHandler } from '../middleware/error-handler.js';

const ENV_OVERRIDES = {
  RATE_LIMIT_PASSWORD_RESET_MAX: '2',
  RATE_LIMIT_PASSWORD_RESET_EMAIL_MAX: '2',
  RATE_LIMIT_AUTH_MAX: '2',
} as const;

const savedEnv = new Map<string, string | undefined>(
  Object.keys(ENV_OVERRIDES).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, ENV_OVERRIDES);

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
}));

vi.mock('../services/password-reset-service.js', () => {
  const confirmPasswordReset = vi.fn();
  return {
    PasswordResetService: class {
      confirmPasswordReset = confirmPasswordReset;
    },
    dispatchPasswordResetEmail: vi.fn(),
    __mockConfirmPasswordReset: confirmPasswordReset,
  };
});

const { default: authRouter } = await import('./auth.js');
const { __mockConfirmPasswordReset } = await import('../services/password-reset-service.js');

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('Password reset rate limiting (real middleware)', () => {
  const db = { query: vi.fn() } as unknown as DB;
  let app: express.Application;

  beforeEach(() => {
    app = express();
    // Trust X-Forwarded-For so each request can simulate a distinct source IP.
    app.set('trust proxy', true);
    app.use(express.json());
    app.set('db', db);
    app.use('/api/auth', authRouter);
    app.use(errorHandler);
    vi.clearAllMocks();
  });

  it('throttles the request route per source IP across different emails', async () => {
    const statuses: number[] = [];
    for (const email of ['spray-a@example.com', 'spray-b@example.com', 'spray-c@example.com']) {
      const response = await request(app)
        .post('/api/auth/password-reset/request')
        .set('X-Forwarded-For', '198.51.100.1')
        .send({ email });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([200, 200, 429]);
  });

  it('throttles the request route per email across rotating source IPs', async () => {
    const statuses: number[] = [];
    for (const ip of ['198.51.100.10', '198.51.100.11', '198.51.100.12']) {
      const response = await request(app)
        .post('/api/auth/password-reset/request')
        .set('X-Forwarded-For', ip)
        .send({ email: 'bombed@example.com' });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([200, 200, 429]);
    // The blocked response still carries the standard rate-limit headers.
    const blocked = await request(app)
      .post('/api/auth/password-reset/request')
      .set('X-Forwarded-For', '198.51.100.13')
      .send({ email: 'bombed@example.com' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['ratelimit-limit']).toBe('2');
  });

  it('throttles the confirm route per IP after repeated failures', async () => {
    vi.mocked(__mockConfirmPasswordReset).mockResolvedValue(false);

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await request(app)
        .post('/api/auth/password-reset/confirm')
        .set('X-Forwarded-For', '203.0.113.10')
        .send({ token: 'guess', newPassword: 'NewPass123!' });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([400, 400, 429]);
  });

  it('does not let successful confirms consume the shared budget', async () => {
    vi.mocked(__mockConfirmPasswordReset).mockResolvedValue(true);

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await request(app)
        .post('/api/auth/password-reset/confirm')
        .set('X-Forward-For', '203.0.113.20')
        .send({ token: 'raw-token', newPassword: 'NewPass123!' });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([200, 200, 200]);
  });
});

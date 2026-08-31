import { errorHandler } from '../middleware/error-handler.js';
process.env.JWT_SECRET = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import meNotificationsRouter from './me-notifications.js';
import { MEMBER_ONLY_ENDPOINT_MESSAGE } from '../types/role.js';
import type { Response } from 'express';

const mockAttach = vi.fn(
  (memberId: number, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    // The real bridge keeps the stream open; end res so supertest completes.
    res.end();
    return () => {};
  },
);

vi.mock('../services/sse-bridge.js', () => ({
  attachMemberNotificationStream: (...args: Parameters<typeof mockAttach>) => mockAttach(...args),
}));

vi.mock('../services/member-notification-tracker.js', () => ({
  memberNotificationTracker: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    getListenerCount: vi.fn(() => 1),
  },
}));

vi.mock('../middleware/rate-limit.js', () => ({
  protectedLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request & { user?: { id: number; role_name: string } }, res: express.Response, next: express.NextFunction) => {
    const token = req.headers['x-test-auth'];
    if (!token) {
      return res.status(401).json({ success: false, error: 'Authentication required. No token provided.' });
    }
    req.user = {
      id: Number(req.headers['x-test-user-id'] ?? 7),
      role_name: req.headers['x-test-role'] === 'admin' ? 'admin' : 'member',
    };
    next();
  },
  requireMember: (req: express.Request & { user?: { role_name: string } }, res: express.Response, next: express.NextFunction) => {
    if (req.user?.role_name !== 'member') {
      return res.status(403).json({ success: false, error: MEMBER_ONLY_ENDPOINT_MESSAGE });
    }
    next();
  },
}));

const app = express();
app.use(express.json());
app.set('db', {});
app.use('/api/me/notifications', meNotificationsRouter);
app.use(errorHandler);

describe('GET /api/me/notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unauthenticated connects before any stream is opened', async () => {
    const response = await request(app).get('/api/me/notifications');

    expect(response.status).toBe(401);
    expect(mockAttach).not.toHaveBeenCalled();
  });

  it('rejects Staff connects (Member-only stream)', async () => {
    const response = await request(app)
      .get('/api/me/notifications')
      .set('x-test-auth', 'token')
      .set('x-test-role', 'admin');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe(MEMBER_ONLY_ENDPOINT_MESSAGE);
    expect(mockAttach).not.toHaveBeenCalled();
  });

  it('attaches the Member’s response to the per-member keyed sink', async () => {
    const response = await request(app)
      .get('/api/me/notifications')
      .set('x-test-auth', 'token')
      .set('x-test-user-id', '7');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(mockAttach).toHaveBeenCalledOnce();
    const [memberId] = mockAttach.mock.calls[0];
    expect(memberId).toBe(7);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import membersRouter from './members.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { DB } from '../db/internal/client.js';

// Mock dependencies
vi.mock('../db/internal/client.js', () => ({
  db: {
    query: vi.fn(),
    // The transaction client shares the outer `query` mock, so in-transaction
    // query mocks are observable through the same spy.
    transaction: vi.fn(async (callback: (client: { query: unknown }) => Promise<unknown>) =>
      callback({ query: vi.fn() }),
    ),
  },
}));
vi.mock('../db/member-queries.js');
vi.mock('../db/user-queries.js');
vi.mock('../repositories/refresh-token-repository.js', () => ({
  revokeAllUserTokens: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('../middleware/auth.js', async () => {
  const { mockAuthTokenMap } = await import('../test-utils/auth.js');
  return mockAuthTokenMap({
    'valid-admin-token': { id: 1, username: 'admin' },
    'valid-user-token':  { id: 2, username: 'user1' },
  });
});
vi.mock('../middleware/permission.js', async () => {
  const { mockPermissionContext } = await import('../test-utils/permission.js');
  return mockPermissionContext([1]);
});
vi.mock('../middleware/rate-limit.js', async () => {
  const { mockRateLimits } = await import('../test-utils/rate-limit.js');
  return mockRateLimits();
});

import * as memberQueries from '../db/member-queries.js';
import * as userQueries from '../db/user-queries.js';
import { revokeAllUserTokens } from '../repositories/refresh-token-repository.js';
import { db } from '../db/internal/client.js';

const makeMember = (overrides: Partial<memberQueries.MemberAdminRow> = {}): memberQueries.MemberAdminRow => ({
  id: 7,
  username: 'member@example.com',
  email: 'member@example.com',
  role_name: 'member',
  status: 'active',
  email_verified_at: '2026-01-02T00:00:00Z',
  appearance: 'light',
  selection_count: 3,
  submission_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const activeLifecycle = { id: 7, role_name: 'member', status: 'active' as const, email_verified_at: '2026-01-02T00:00:00Z' };

describe('Admin Member management routes', () => {
  let app: express.Application;
  const mockDb: DB = db as DB;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.set('db', mockDb);
    app.use('/api/members', membersRouter);
    app.use(errorHandler);
    vi.clearAllMocks();
    vi.mocked(db.transaction).mockImplementation(
      async (callback: (client: { query: unknown }) => Promise<unknown>) => callback({ query: vi.fn() }),
    );
  });

  describe('GET /api/members', () => {
    it('should return the Member list without credentials (200)', async () => {
      const members = [makeMember(), makeMember({ id: 8, email: 'other@example.com' })];
      vi.mocked(memberQueries.listMembers).mockResolvedValue(members);

      const response = await request(app)
        .get('/api/members')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(members);
      expect(memberQueries.listMembers).toHaveBeenCalledWith(db, { limit: 100, offset: 0 });
    });

    it('should return 401 for unauthenticated requests', async () => {
      const response = await request(app).get('/api/members');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    it('should return 403 without members:list (operators untouched)', async () => {
      const response = await request(app)
        .get('/api/members')
        .set('Authorization', 'Bearer valid-user-token');

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Permission denied');
    });

    it('should clamp the limit and reject invalid pagination', async () => {
      vi.mocked(memberQueries.listMembers).mockResolvedValue([]);

      const clamped = await request(app)
        .get('/api/members?limit=500')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(clamped.status).toBe(200);
      expect(memberQueries.listMembers).toHaveBeenLastCalledWith(db, { limit: 100, offset: 0 });

      const invalid = await request(app)
        .get('/api/members?limit=abc')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toBe('Invalid limit parameter');

      const invalidOffset = await request(app)
        .get('/api/members?offset=-1')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(invalidOffset.status).toBe(400);
    });
  });

  describe('GET /api/members/:id', () => {
    it('should return one Member (200)', async () => {
      const member = makeMember();
      vi.mocked(memberQueries.getMemberAdminDetail).mockResolvedValue(member);

      const response = await request(app)
        .get('/api/members/7')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(member);
      expect(memberQueries.getMemberAdminDetail).toHaveBeenCalledWith(db, 7);
    });

    it('should return 404 for a missing Member (Staff ids are indistinguishable)', async () => {
      vi.mocked(memberQueries.getMemberAdminDetail).mockResolvedValue(undefined);

      const response = await request(app)
        .get('/api/members/99')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Member not found');
    });

    it('should return 400 for a non-integer id', async () => {
      const response = await request(app)
        .get('/api/members/not-an-id')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid member ID');
    });
  });

  describe('POST /api/members/:id/suspend', () => {
    it('should suspend an active Member and revoke all Sessions in the transaction (200)', async () => {
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(activeLifecycle);
      vi.mocked(memberQueries.setMemberStatus).mockResolvedValue(true);
      vi.mocked(revokeAllUserTokens).mockResolvedValue(undefined);
      const suspended = makeMember({ status: 'suspended' });
      vi.mocked(memberQueries.getMemberAdminDetail).mockResolvedValue(suspended);

      const response = await request(app)
        .post('/api/members/7/suspend')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('suspended');
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(userQueries.getMemberLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ query: expect.any(Function) }),
        7,
        { forUpdate: true },
      );
      expect(memberQueries.setMemberStatus).toHaveBeenCalledWith(
        expect.objectContaining({ query: expect.any(Function) }),
        7,
        'suspended',
      );
      // Same mechanism as password-change revocation, on the transaction client.
      expect(revokeAllUserTokens).toHaveBeenCalledTimes(1);
      expect(revokeAllUserTokens).toHaveBeenCalledWith(
        expect.objectContaining({ query: expect.any(Function) }),
        7,
      );
    });

    it('should return 409 when the Member is already suspended', async () => {
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue({ ...activeLifecycle, status: 'suspended' });

      const response = await request(app)
        .post('/api/members/7/suspend')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Member is already suspended');
      expect(memberQueries.setMemberStatus).not.toHaveBeenCalled();
      expect(revokeAllUserTokens).not.toHaveBeenCalled();
    });

    it('should return 409 when the Member is unverified (reinstatement must not bypass verification)', async () => {
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue({ ...activeLifecycle, status: 'unverified', email_verified_at: null });

      const response = await request(app)
        .post('/api/members/7/suspend')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Only active members can be suspended');
    });

    it('should return 404 for a missing Member or a Staff id', async () => {
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/members/99/suspend')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(response.status).toBe(404);
      expect(revokeAllUserTokens).not.toHaveBeenCalled();
    });

    it('should return 403 without members:update', async () => {
      const response = await request(app)
        .post('/api/members/7/suspend')
        .set('Authorization', 'Bearer valid-user-token');

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/members/:id/reinstate', () => {
    it('should reinstate a suspended Member to active (200)', async () => {
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue({ ...activeLifecycle, status: 'suspended' });
      vi.mocked(memberQueries.setMemberStatus).mockResolvedValue(true);
      const reinstated = makeMember({ status: 'active' });
      vi.mocked(memberQueries.getMemberAdminDetail).mockResolvedValue(reinstated);

      const response = await request(app)
        .post('/api/members/7/reinstate')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('active');
      expect(memberQueries.setMemberStatus).toHaveBeenCalledWith(
        expect.objectContaining({ query: expect.any(Function) }),
        7,
        'active',
      );
      // Reinstatement restores access; it never touches Sessions.
      expect(revokeAllUserTokens).not.toHaveBeenCalled();
    });

    it('should return 409 when the Member is not suspended', async () => {
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(activeLifecycle);

      const response = await request(app)
        .post('/api/members/7/reinstate')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Member is not suspended');
      expect(memberQueries.setMemberStatus).not.toHaveBeenCalled();
    });

    it('should return 404 for a missing Member', async () => {
      vi.mocked(userQueries.getMemberLifecycle).mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/members/99/reinstate')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/members/:id', () => {
    it('should delete the Member and cascade Member-owned data (204)', async () => {
      vi.mocked(memberQueries.getMemberAdminDetail).mockResolvedValue(makeMember());
      vi.mocked(userQueries.deleteUser).mockResolvedValue(true);

      const response = await request(app)
        .delete('/api/members/7')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(response.status).toBe(204);
      expect(userQueries.deleteUser).toHaveBeenCalledWith(db, 7);
    });

    it('should return 404 when deleting a missing Member (or a Staff id)', async () => {
      vi.mocked(memberQueries.getMemberAdminDetail).mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/members/99')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(response.status).toBe(404);
      expect(userQueries.deleteUser).not.toHaveBeenCalled();
    });

    it('should return 403 without members:delete', async () => {
      const response = await request(app)
        .delete('/api/members/7')
        .set('Authorization', 'Bearer valid-user-token');

      expect(response.status).toBe(403);
    });
  });
});

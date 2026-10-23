import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

describe('requireAuth (multi-secret verification)', () => {
  const VALID_SECRET = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6';
  const OLD_SECRET = 'b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7';

  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = VALID_SECRET;
    delete process.env.JWT_PREVIOUS_SECRETS;
  });

  it('should accept token from access_token cookie', async () => {
    process.env.JWT_PREVIOUS_SECRETS = OLD_SECRET;

    const { requireAuth } = await import('./auth.js');
    const token = jwt.sign({ id: 1, username: 'test' }, VALID_SECRET, { algorithm: 'HS256' });
    const req = { headers: {}, cookies: { access_token: token } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    requireAuth(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.user?.id).toBe(1);
  });

  it('should prefer access_token cookie over Authorization header', async () => {
    process.env.JWT_PREVIOUS_SECRETS = OLD_SECRET;

    const { requireAuth } = await import('./auth.js');
    const cookieToken = jwt.sign({ id: 1, username: 'cookie-user' }, VALID_SECRET, { algorithm: 'HS256' });
    const headerToken = jwt.sign({ id: 2, username: 'header-user' }, VALID_SECRET, { algorithm: 'HS256' });
    const req = {
      headers: { authorization: `Bearer ${headerToken}` },
      cookies: { access_token: cookieToken },
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    requireAuth(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.user?.id).toBe(1);
    expect(req.user?.username).toBe('cookie-user');
  });

  it('should reject request without Authorization header', async () => {
    const { requireAuth } = await import('./auth.js');
    const req = { headers: {} } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    requireAuth(req, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should accept token signed with current secret', async () => {
    process.env.JWT_PREVIOUS_SECRETS = OLD_SECRET;

    const { requireAuth } = await import('./auth.js');
    const token = jwt.sign({ id: 1, username: 'test' }, VALID_SECRET, { algorithm: 'HS256' });
    const req = { headers: { authorization: `Bearer ${token}` } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    requireAuth(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.user?.id).toBe(1);
  });

  it('should accept token signed with previous secret', async () => {
    process.env.JWT_PREVIOUS_SECRETS = OLD_SECRET;

    const { requireAuth } = await import('./auth.js');
    const token = jwt.sign({ id: 2, username: 'rotated' }, OLD_SECRET, { algorithm: 'HS256' });
    const req = { headers: { authorization: `Bearer ${token}` } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    requireAuth(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.user?.id).toBe(2);
  });

  it('should reject token signed with unknown secret', async () => {
    process.env.JWT_PREVIOUS_SECRETS = OLD_SECRET;

    const { requireAuth } = await import('./auth.js');
    const token = jwt.sign({ id: 3, username: 'hacker' }, 'unknown-secret-min-32-chars-long-here!', { algorithm: 'HS256' });
    const req = { headers: {}, cookies: { access_token: token } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    requireAuth(req, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('isAdminUser', () => {
  it('should return true for system admin (role_name=admin, is_system_role=true)', async () => {
    const { isAdminUser } = await import('./auth.js');
    const user = { id: 1, username: 'admin', role_name: 'admin', is_system_role: true, permissions: [] };
    expect(isAdminUser(user)).toBe(true);
  });

  it('should return false for non-system role named admin (role_name=admin, is_system_role=false)', async () => {
    const { isAdminUser } = await import('./auth.js');
    const user = { id: 2, username: 'fakeadmin', role_name: 'admin', is_system_role: false, permissions: [] };
    expect(isAdminUser(user)).toBe(false);
  });

  it('should return false for regular user (role_name=operator, is_system_role=false)', async () => {
    const { isAdminUser } = await import('./auth.js');
    const user = { id: 3, username: 'operator', role_name: 'operator', is_system_role: false, permissions: ['theaters:read'] };
    expect(isAdminUser(user)).toBe(false);
  });

  it('should return false for null user', async () => {
    const { isAdminUser } = await import('./auth.js');
    expect(isAdminUser(null)).toBe(false);
  });

  it('should return false for undefined user', async () => {
    const { isAdminUser } = await import('./auth.js');
    expect(isAdminUser(undefined)).toBe(false);
  });
});

describe('requireMember (lifecycle re-check)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6';
  });

  async function runWithLifecycle(row: unknown, roleName = 'member') {
    const query = vi.fn().mockResolvedValue({ rows: row === undefined ? [] : [row] });
    const { requireMember } = await import('./auth.js');
    const req = {
      user: { id: 7, username: 'm@example.com', role_name: roleName, is_system_role: true, permissions: [] },
      app: { get: () => ({ query }) },
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    await requireMember(req, res as any, next);
    return { query, res, next };
  }

  it('rejects a non-member role with 403 without touching the database', async () => {
    const { query, res, next } = await runWithLifecycle(undefined, 'operator');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(query).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('lets an active Member through', async () => {
    const { next, res } = await runWithLifecycle({ id: 7, role_name: 'member', status: 'active', email_verified_at: null });
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('lets an unverified Member through (only suspension blocks)', async () => {
    const { next } = await runWithLifecycle({ id: 7, role_name: 'member', status: 'unverified', email_verified_at: null });
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects a suspended Member holding a still-valid access token with 401', async () => {
    const { next, res } = await runWithLifecycle({ id: 7, role_name: 'member', status: 'suspended', email_verified_at: null });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Account suspended' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a deleted Member (no row) with 401', async () => {
    const { next, res } = await runWithLifecycle(undefined);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token whose user was promoted to Staff with 401', async () => {
    const { next, res } = await runWithLifecycle({ id: 7, role_name: 'operator', status: 'active', email_verified_at: null });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a database failure to the error handler', async () => {
    const failure = new Error('db down');
    const query = vi.fn().mockRejectedValue(failure);
    const { requireMember } = await import('./auth.js');
    const req = { user: { id: 7, role_name: 'member' }, app: { get: () => ({ query }) } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    await requireMember(req, res as any, next);
    expect(next).toHaveBeenCalledWith(failure);
    expect(res.status).not.toHaveBeenCalled();
  });
});

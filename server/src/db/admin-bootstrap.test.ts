import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DB } from './index.js';
import { ensureInitialAdmin } from './admin-bootstrap.js';

// Mock password + random password generators so no real crypto cost is paid.
vi.mock('./user-queries.js', () => ({
  generateRandomPassword: vi.fn().mockReturnValue(' GENERATED_PW_123!'),
}));
vi.mock('../utils/password.js', () => ({
  hashPassword: vi.fn().mockResolvedValue('scrypt:hash'),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

function createMockDb(): DB {
  return { query: vi.fn() } as unknown as DB;
}

describe('ensureInitialAdmin', () => {
  let db: DB;

  beforeEach(() => {
    db = createMockDb();
    vi.clearAllMocks();
  });

  it('logs an error and returns when the admin role is missing', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);

    await ensureInitialAdmin(db);

    const { logger } = await import('../utils/logger.js');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Admin role not found')
    );
    // No admin count query, no insert.
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('skips creation when an admin user already exists', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: 1 }] } as any) // admin role lookup
      .mockResolvedValueOnce({ rows: [{ count: '1' }] } as any); // admin count

    await ensureInitialAdmin(db);

    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      expect.anything()
    );
  });

  it('creates an admin user with the admin role id when none exists', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: 7 }] } as any) // admin role lookup
      .mockResolvedValueOnce({ rows: [{ count: '0' }] } as any) // admin count
      .mockResolvedValueOnce({ rows: [] } as any); // insert

    await ensureInitialAdmin(db);

    expect(db.query).toHaveBeenCalledWith(
      `INSERT INTO users (username, password_hash, role_id) VALUES ($1, $2, $3)`,
      ['admin', 'scrypt:hash', 7]
    );
  });

  it('is idempotent across repeated calls when an admin exists', async () => {
    // Two calls × (role lookup + admin count). Each call sees an existing admin.
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: 1 }] } as any)
      .mockResolvedValueOnce({ rows: [{ count: '2' }] } as any)
      .mockResolvedValueOnce({ rows: [{ id: 1 }] } as any)
      .mockResolvedValueOnce({ rows: [{ count: '2' }] } as any);

    await ensureInitialAdmin(db);
    await ensureInitialAdmin(db);

    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      expect.anything()
    );
  });
});

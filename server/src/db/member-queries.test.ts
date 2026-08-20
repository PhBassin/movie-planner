import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DB } from './index.js';
import {
  getUserByEmail,
  getMemberById,
  createMember,
  getMemberProfile,
  isPendingVerification,
  type MemberCredentialRow,
} from './member-queries.js';

describe('Member Queries', () => {
  let mockDb: DB;

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
    } as unknown as DB;
  });

  describe('getUserByEmail', () => {
    it('should look up a member by lowercased email', async () => {
      const row = {
        id: 7,
        username: 'jane@example.com',
        email: 'jane@example.com',
        password_hash: 'hash',
        role_id: 3,
        role_name: 'member',
        is_system_role: true,
        status: 'unverified',
        email_verified_at: null,
        created_at: '2024-01-01T00:00:00Z',
      };
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [row], rowCount: 1 } as any);

      const result = await getUserByEmail(mockDb, 'Jane@Example.com');

      expect(result).toEqual(row);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('LOWER(u.email) = LOWER($1)'),
        ['Jane@Example.com']
      );
    });

    it('should return undefined when no user matches', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);

      const result = await getUserByEmail(mockDb, 'nobody@example.com');

      expect(result).toBeUndefined();
    });
  });

  describe('createMember', () => {
    it('should insert a user with the member role, unverified status, and email', async () => {
      const created = {
        id: 8,
        username: 'jane@example.com',
        email: 'jane@example.com',
        role_id: 3,
        role_name: 'member',
        status: 'unverified',
        created_at: '2024-01-01T00:00:00Z',
      };
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [created], rowCount: 1 } as any);

      const result = await createMember(mockDb, 'jane@example.com', 'scrypt-hash');

      expect(result).toEqual(created);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("'member'"),
        ['jane@example.com', 'scrypt-hash']
      );
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("'unverified'"),
        expect.any(Array)
      );
    });
  });

  describe('getMemberById', () => {
    it('returns only a Member credential row', async () => {
      const row = {
        id: 7,
        username: 'jane@example.com',
        email: 'jane@example.com',
        password_hash: 'hash',
        role_id: 3,
        role_name: 'member',
        is_system_role: true,
        status: 'active',
        email_verified_at: '2024-01-02T00:00:00Z',
        created_at: '2024-01-01T00:00:00Z',
      };
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [row], rowCount: 1 } as any);

      await expect(getMemberById(mockDb, 7)).resolves.toEqual(row);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("r.name = 'member'"),
        [7],
      );
    });
  });

  describe('isPendingVerification', () => {
    const base: MemberCredentialRow = {
      id: 7,
      username: 'jane@example.com',
      email: 'jane@example.com',
      password_hash: 'hash',
      role_id: 3,
      role_name: 'member',
      is_system_role: true,
      status: 'unverified',
      email_verified_at: null,
      created_at: '2024-01-01T00:00:00Z',
    };

    it('is true for an unverified Member', () => {
      expect(isPendingVerification(base)).toBe(true);
    });

    it('is false for a Staff account (email-keyed flows are Member-only)', () => {
      expect(isPendingVerification({ ...base, role_name: 'admin' })).toBe(false);
    });

    it('is false for an already-verified Member', () => {
      expect(
        isPendingVerification({ ...base, status: 'active', email_verified_at: '2024-01-02T00:00:00Z' }),
      ).toBe(false);
    });
  });

  describe('getMemberProfile', () => {
    it('should return the member profile with verification state', async () => {
      const profile = {
        id: 7,
        email: 'jane@example.com',
        username: 'jane@example.com',
        role_name: 'member',
        status: 'active',
        email_verified_at: '2024-01-02T00:00:00Z',
        appearance: 'light',
        selection_count: 3,
        created_at: '2024-01-01T00:00:00Z',
      };
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [profile], rowCount: 1 } as any);

      const result = await getMemberProfile(mockDb, 7);

      expect(result).toEqual(profile);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('member_preferences'),
        [7]
      );
    });

    it('should return undefined when the user does not exist', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);

      const result = await getMemberProfile(mockDb, 999);

      expect(result).toBeUndefined();
    });
  });
});

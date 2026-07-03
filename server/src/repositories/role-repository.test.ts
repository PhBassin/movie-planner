import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DB } from '../db/index.js';
import { getRoleInUseCount } from './role-repository.js';

describe('role-repository', () => {
  let mockDb: DB;

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
    } as unknown as DB;
  });

  describe('getRoleInUseCount', () => {
    it('returns the number of users assigned to the role', async () => {
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [{ count: '5' }],
        rowCount: 1,
      } as any);

      const result = await getRoleInUseCount(mockDb, 42);

      expect(result).toBe(5);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT COUNT(*)'),
        [42]
      );
    });

    it('returns 0 when no users are assigned to the role', async () => {
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [{ count: '0' }],
        rowCount: 1,
      } as any);

      const result = await getRoleInUseCount(mockDb, 7);

      expect(result).toBe(0);
    });

    it('returns 0 when the query returns no rows', async () => {
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      const result = await getRoleInUseCount(mockDb, 99);

      expect(result).toBe(0);
    });

    it('throws when count is null (malformed row, not a legitimate empty result)', async () => {
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [{ count: null }],
        rowCount: 1,
      } as any);

      await expect(getRoleInUseCount(mockDb, 11)).rejects.toThrow(
        /getRoleInUseCount: unexpected non-numeric count from database/
      );
    });

    it('throws when count is non-numeric (malformed row, not a legitimate empty result)', async () => {
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [{ count: 'not-a-number' }],
        rowCount: 1,
      } as any);

      await expect(getRoleInUseCount(mockDb, 13)).rejects.toThrow(
        /getRoleInUseCount: unexpected non-numeric count from database/
      );
    });
  });
});

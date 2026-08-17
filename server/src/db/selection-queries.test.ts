import { describe, expect, it, vi } from 'vitest';
import type { DB } from './index.js';
import {
  getActiveTheater,
  lockMemberForSelection,
  getSelection,
  getSelectionCount,
} from './selection-queries.js';

describe('Selection queries', () => {
  it('locks the Member users row for cap-enforced writes', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 7, role_name: 'member' }] }),
    } as unknown as DB;

    await lockMemberForSelection(db, 7);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM users u'),
      [7],
    );
    expect(db.query.mock.calls[0][0]).toContain('FOR UPDATE');
  });

  it('loads only active theaters for a Selection add', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as DB;

    await getActiveTheater(db, 'C0001');

    expect(db.query.mock.calls[0][0]).toContain("status = 'active'");
  });

  it('lists the Selection in theater order and excludes provisioning rows', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'C0001', name: 'UGC Opéra', status: 'active' }] }),
    } as unknown as DB;

    const result = await getSelection(db, 7);

    expect(result).toEqual([{ id: 'C0001', name: 'UGC Opéra', status: 'active' }]);
    expect(db.query.mock.calls[0][0]).toContain("t.status = 'active'");
    expect(db.query.mock.calls[0][0]).toContain('ORDER BY t.name, t.id');
  });

  it('returns the member Selection count', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ count: 3 }] }),
    } as unknown as DB;

    await expect(getSelectionCount(db, 7)).resolves.toBe(3);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('COUNT(*)::int'),
      [7],
    );
  });
});

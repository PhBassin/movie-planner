import { describe, expect, it, vi } from 'vitest';
import type { DB } from './index.js';
import {
  getActiveTheater,
  lockMemberForSelection,
  activateSelection,
  getProjectedSelectionTheaterIds,
  getSelection,
  getSelectionChoice,
  getSelectionCounts,
  getSelectionForExport,
} from './selection-queries.js';

describe('Selection queries', () => {
  it('locks the Member users row for cap-enforced writes', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 7, role_name: 'member', status: 'active', email_verified_at: null }] }),
    } as unknown as DB;

    await lockMemberForSelection(db, 7);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT u.id, r.name AS role_name, u.status, u.email_verified_at'),
      [7],
    );
    expect(db.query.mock.calls[0][0]).toContain('FOR UPDATE OF u');
  });

  it('loads only active theaters for a Selection add', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as DB;

    await getActiveTheater(db, 'C0001');

    expect(db.query.mock.calls[0][0]).toContain("status = 'active'");
  });

  it('lists the Selection in theater order with each choice active flag, excluding provisioning rows', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'C0001', name: 'UGC Opéra', status: 'active', active: false }] }),
    } as unknown as DB;

    const result = await getSelection(db, 7);

    expect(result).toEqual([{ id: 'C0001', name: 'UGC Opéra', status: 'active', active: false }]);
    expect(db.query.mock.calls[0][0]).toContain('ms.active');
    expect(db.query.mock.calls[0][0]).toContain("t.status = 'active'");
    expect(db.query.mock.calls[0][0]).toContain('ORDER BY t.name, t.id');
  });

  it('counts active and total stored choices in one statement', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ active: 3, total: 5 }] }),
    } as unknown as DB;

    await expect(getSelectionCounts(db, 7)).resolves.toEqual({ active: 3, total: 5 });
    expect(db.query.mock.calls[0][0]).toContain('FILTER (WHERE active)');
    expect(db.query.mock.calls[0][1]).toEqual([7]);
  });

  it('defaults the counts to zero when the aggregate yields no row', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as DB;

    await expect(getSelectionCounts(db, 7)).resolves.toEqual({ active: 0, total: 0 });
  });

  it('reads one stored choice, or nothing', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ active: false }] })
        .mockResolvedValueOnce({ rows: [] }),
    } as unknown as DB;

    await expect(getSelectionChoice(db, 7, 'C0001')).resolves.toEqual({ active: false });
    await expect(getSelectionChoice(db, 7, 'C0002')).resolves.toBeUndefined();
    expect(db.query.mock.calls[0][1]).toEqual([7, 'C0001']);
  });

  it('activates a remembered choice', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as DB;

    await activateSelection(db, 7, 'C0001');

    expect(db.query.mock.calls[0][0]).toContain('SET active = TRUE');
    expect(db.query.mock.calls[0][1]).toEqual([7, 'C0001']);
  });

  it('projects only active choices of active Theaters unless remembered ones are included', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'C0001' }] }) } as unknown as DB;

    await expect(getProjectedSelectionTheaterIds(db, 7, { includeRemembered: false })).resolves.toEqual(['C0001']);
    await getProjectedSelectionTheaterIds(db, 7, { includeRemembered: true });

    expect(db.query.mock.calls[0][0]).toContain('AND ms.active');
    expect(db.query.mock.calls[0][0]).toContain("t.status = 'active'");
    expect(db.query.mock.calls[1][0]).not.toContain('ms.active');
  });

  it('exports the whole Selection, whatever the Theater status', async () => {
    const rows = [{ theater_id: 'C0001', name: 'UGC', city: 'Paris', url: null, status: 'provisioning', active: false }];
    const db = { query: vi.fn().mockResolvedValue({ rows }) } as unknown as DB;

    await expect(getSelectionForExport(db, 7)).resolves.toEqual(rows);

    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain('WHERE ms.member_id = $1');
    expect(sql).not.toContain("status = 'active'");
    expect(db.query.mock.calls[0][1]).toEqual([7]);
  });
});

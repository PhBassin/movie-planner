import { describe, expect, it, vi } from 'vitest';
import type { DB } from './index.js';
import {
  getActiveTheater,
  lockMemberForSelection,
  activateSelection,
  getSelection,
  getSelectionChoice,
  getSelectionForExport,
  getSelectionSnapshot,
} from './selection-queries.js';

const BILLING_ENABLED = { rememberedCountsAsActive: false };
const BILLING_DISABLED = { rememberedCountsAsActive: true };

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

    const result = await getSelection(db, 7, BILLING_ENABLED);

    expect(result).toEqual([{ id: 'C0001', name: 'UGC Opéra', status: 'active', active: false }]);
    expect(db.query.mock.calls[0][0]).toContain('(ms.active OR $2::boolean) AS active');
    expect(db.query.mock.calls[0][1]).toEqual([7, false]);
    expect(db.query.mock.calls[0][0]).toContain("t.status = 'active'");
    expect(db.query.mock.calls[0][0]).toContain('ORDER BY t.name, t.id');
  });

  it('reads the paid-through state, counts and projected Theaters in one statement', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ paid_through: true, active: 3, total: 5, projected_theater_ids: ['C0001'] }],
      }),
    } as unknown as DB;

    await expect(getSelectionSnapshot(db, 7, BILLING_ENABLED)).resolves.toEqual({
      paidThrough: true, active: 3, total: 5, projectedTheaterIds: ['C0001'],
    });
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain('paid_through > NOW()');
    expect(sql).toContain('COUNT(ms.theater_id) FILTER (WHERE (ms.active OR $2::boolean))');
    expect(sql).toContain("FILTER (WHERE t.status = 'active' AND (ms.active OR $2::boolean))");
    expect(db.query.mock.calls[0][1]).toEqual([7, false]);
  });

  it('passes the billing-disabled view so remembered choices count and project as active', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as DB;

    await expect(getSelectionSnapshot(db, 7, BILLING_DISABLED)).resolves.toEqual({
      paidThrough: false, active: 0, total: 0, projectedTheaterIds: [],
    });
    expect(db.query.mock.calls[0][1]).toEqual([7, true]);
  });

  it('reads one stored choice, or nothing', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ active: false }] })
        .mockResolvedValueOnce({ rows: [] }),
    } as unknown as DB;

    await expect(getSelectionChoice(db, 7, 'C0001', BILLING_ENABLED)).resolves.toEqual({ active: false });
    await expect(getSelectionChoice(db, 7, 'C0002', BILLING_DISABLED)).resolves.toBeUndefined();
    expect(db.query.mock.calls[0][0]).toContain('(ms.active OR $3::boolean) AS active');
    expect(db.query.mock.calls[0][1]).toEqual([7, 'C0001', false]);
    expect(db.query.mock.calls[1][1]).toEqual([7, 'C0002', true]);
  });

  it('activates a remembered choice', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as DB;

    await activateSelection(db, 7, 'C0001');

    expect(db.query.mock.calls[0][0]).toContain('SET active = TRUE');
    expect(db.query.mock.calls[0][1]).toEqual([7, 'C0001']);
  });

  it('exports the whole Selection, whatever the Theater status', async () => {
    const rows = [{ theater_id: 'C0001', name: 'UGC', city: 'Paris', url: null, status: 'provisioning', active: false }];
    const db = { query: vi.fn().mockResolvedValue({ rows }) } as unknown as DB;

    await expect(getSelectionForExport(db, 7, BILLING_DISABLED)).resolves.toEqual(rows);

    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain('WHERE ms.member_id = $1');
    expect(sql).toContain('(ms.active OR $2::boolean) AS active');
    expect(sql).not.toContain("status = 'active'");
    expect(db.query.mock.calls[0][1]).toEqual([7, true]);
  });
});

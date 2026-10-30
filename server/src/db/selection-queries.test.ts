import { describe, expect, it, vi } from 'vitest';
import type { DB } from './index.js';
import {
  getActiveTheater,
  lockMemberForSelection,
  activateSelection,
  getSelection,
  getSelectionCounts,
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

  it('reads the paid-through state and counts in one statement, without the Theater join', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ paid_through: true, active: 3, total: 5, choice_exists: null, choice_active: null }],
      }),
    } as unknown as DB;

    await expect(getSelectionCounts(db, 7, BILLING_ENABLED)).resolves.toEqual({
      paidThrough: true, active: 3, total: 5,
    });
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain('paid_through > statement_timestamp()');
    expect(sql).toContain('COUNT(ms.theater_id) FILTER (WHERE (ms.active OR $2::boolean))');
    expect(sql).not.toContain('JOIN theaters');
    expect(sql).not.toContain('array_agg');
    expect(db.query.mock.calls[0][1]).toEqual([7, false, null]);
  });

  it('reads the targeted choice in the same statement as the counts', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ paid_through: false, active: 2, total: 4, choice_exists: true, choice_active: false }] })
        .mockResolvedValueOnce({ rows: [{ paid_through: false, active: 2, total: 4, choice_exists: false, choice_active: false }] }),
    } as unknown as DB;

    await expect(getSelectionCounts(db, 7, BILLING_ENABLED, 'C0001')).resolves.toEqual({
      paidThrough: false, active: 2, total: 4, choice: { active: false },
    });
    await expect(getSelectionCounts(db, 7, BILLING_DISABLED, 'C0002')).resolves.toEqual({
      paidThrough: false, active: 2, total: 4,
    });
    expect(db.query.mock.calls[0][0]).toContain('bool_or(ms.theater_id = $3::text AND (ms.active OR $2::boolean)) AS choice_active');
    expect(db.query.mock.calls[0][1]).toEqual([7, false, 'C0001']);
    expect(db.query.mock.calls[1][1]).toEqual([7, true, 'C0002']);
  });

  it('reads the counts and projected Theaters in one statement', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ paid_through: true, active: 3, total: 5, projected_theater_ids: ['C0001'] }],
      }),
    } as unknown as DB;

    await expect(getSelectionSnapshot(db, 7, BILLING_ENABLED)).resolves.toEqual({
      paidThrough: true, active: 3, total: 5, projectedTheaterIds: ['C0001'],
    });
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain('paid_through > statement_timestamp()');
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

  it('activates a remembered choice, reporting whether the row was still there', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    } as unknown as DB;

    await expect(activateSelection(db, 7, 'C0001')).resolves.toBe(true);
    await expect(activateSelection(db, 7, 'C0001')).resolves.toBe(false);

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

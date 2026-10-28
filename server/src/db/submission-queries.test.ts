import { describe, expect, it, vi } from 'vitest';
import type { DB } from './index.js';
import {
  countSubmissionAttempts,
  expireStalePendingSubmissionReports,
  getSubmissionHistoryForExport,
  listMemberSubmissionsByTheater,
  lockTheaterForSubmission,
} from './submission-queries.js';

describe('Submission queries', () => {
  it('exports a Member submission history newest first, without internal plumbing', async () => {
    const rows = [{
      id: 3, url: 'https://example.com/salle', theater_id: 'C0099', status: 'failed',
      created_at: '2026-01-03T00:00:00Z', resolved_at: '2026-01-03T00:05:00Z',
    }];
    const db = { query: vi.fn().mockResolvedValue({ rows }) } as unknown as DB;

    await expect(getSubmissionHistoryForExport(db, 7)).resolves.toEqual(rows);

    const sql = vi.mocked(db.query).mock.calls[0][0] as string;
    expect(sql).toContain('WHERE member_id = $1');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).not.toMatch(/report_id|member_id,/);
    expect(vi.mocked(db.query).mock.calls[0][1]).toEqual([7]);
  });

  it('locks the Theater row for the retry decision', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'C0013', status: 'provisioning' }] }) } as unknown as DB;

    await expect(lockTheaterForSubmission(db, 'C0013')).resolves.toEqual({ id: 'C0013', status: 'provisioning' });

    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain('FOR UPDATE');
    expect(params).toEqual(['C0013']);
  });

  it('returns undefined when no Theater row exists', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as DB;

    await expect(lockTheaterForSubmission(db, 'C0013')).resolves.toBeUndefined();
  });

  it('counts total and pending submission attempts for a Theater', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ total: 3, pending: 1 }] }) } as unknown as DB;

    await expect(countSubmissionAttempts(db, 'C0013')).resolves.toEqual({ total: 3, pending: 1 });

    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("FILTER (WHERE status = 'pending')");
    expect(sql).toContain('WHERE theater_id = $1');
    expect(params).toEqual(['C0013']);
  });

  it('defaults attempt counts to zero when no row comes back', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as DB;

    await expect(countSubmissionAttempts(db, 'C0013')).resolves.toEqual({ total: 0, pending: 0 });
  });

  it('expires only running, long-claimed reports of pending submissions', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: 42 }, { id: 43 }] }) } as unknown as DB;
    const cutoff = new Date('2026-01-01T11:30:00Z');

    await expect(expireStalePendingSubmissionReports(db, cutoff)).resolves.toEqual([42, 43]);

    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("SET status = 'failed'");
    expect(sql).toContain("WHERE r.status = 'running'");
    expect(sql).toContain('r.claimed_at < $1');
    expect(sql).toContain("s.status = 'pending'");
    expect(sql).not.toContain('created_at');
    expect(params?.[0]).toBe(cutoff);
    expect(JSON.parse(params?.[1] as string)).toEqual([
      { theater_name: 'System', error: 'Submission scrape timed out' },
    ]);
  });

  it('lists the latest attempt per Theater for one Member, with attempts, derived Selection state and the total', async () => {
    const row = {
      total: 3,
      id: 9,
      url: 'u',
      status: 'failed',
      created_at: '2026-01-01T00:00:00Z',
      resolved_at: null,
      attempts: 2,
      theater_id: 'C0013',
      theater_status: 'active',
      theater_name: 'UGC',
      theater_city: null,
      in_selection: true,
      remembered: false,
    };
    const db = { query: vi.fn().mockResolvedValue({ rows: [row] }) } as unknown as DB;

    const { total: _total, ...expected } = row;
    await expect(listMemberSubmissionsByTheater(db, 7, { limit: 20, offset: 40 }, { rememberedCountsAsActive: false })).resolves.toEqual({
      rows: [expected],
      total: 3,
    });

    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain('WHERE s.member_id = $1');
    expect(sql).toContain('PARTITION BY s.theater_id');
    expect(sql).toContain('WHERE rank = 1');
    expect(sql).toContain('COUNT(*)::int AS total FROM latest');
    expect(sql).toContain('ms.member_id = $1');
    expect(sql).toContain('LIMIT $2 OFFSET $3');
    // A remembered choice is not "in the Selection" (ADR 0011 D6).
    expect(sql).toContain('(ms.theater_id IS NOT NULL AND (ms.active OR $4::boolean)) AS in_selection');
    expect(sql).toContain('(ms.theater_id IS NOT NULL AND NOT (ms.active OR $4::boolean)) AS remembered');
    expect(params).toEqual([7, 20, 40, false]);
  });

  it('keeps the total when the page is past the end', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ total: 4, id: null }] }) } as unknown as DB;

    await expect(listMemberSubmissionsByTheater(db, 7, { limit: 20, offset: 40 }, { rememberedCountsAsActive: false })).resolves.toEqual({ rows: [], total: 4 });
  });

  it('defaults the total to zero', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as DB;

    await expect(listMemberSubmissionsByTheater(db, 7, { limit: 20, offset: 0 }, { rememberedCountsAsActive: false })).resolves.toEqual({ rows: [], total: 0 });
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { DB } from './index.js';
import {
  countSubmissionAttempts,
  expireStalePendingSubmissionReports,
  getSubmissionHistoryForExport,
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

  it('expires only running reports of stale pending submissions and drops their queued jobs', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: 42 }, { id: 43 }] }) } as unknown as DB;
    const cutoff = new Date('2026-01-01T11:30:00Z');

    await expect(expireStalePendingSubmissionReports(db, cutoff)).resolves.toEqual([42, 43]);

    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("SET status = 'failed'");
    expect(sql).toContain("WHERE r.status = 'running'");
    expect(sql).toContain("s.status = 'pending' AND s.created_at < $1");
    expect(sql).toContain('DELETE FROM scrape_jobs');
    expect(params?.[0]).toBe(cutoff);
    expect(JSON.parse(params?.[1] as string)).toEqual([
      { theater_name: 'System', error: 'Submission scrape timed out' },
    ]);
  });
});

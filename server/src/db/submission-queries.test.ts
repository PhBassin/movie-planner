import { describe, expect, it, vi } from 'vitest';
import type { DB } from './index.js';
import { getSubmissionHistoryForExport } from './submission-queries.js';

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
});

import { describe, expect, it, vi } from 'vitest';
import type { DB } from './index.js';
import { hasPaidThroughSubscription } from './subscription-queries.js';

describe('Subscription queries', () => {
  it('finds a non-terminal Subscription paid through the database clock', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
        .mockResolvedValueOnce({ rows: [] }),
    } as unknown as DB;

    await expect(hasPaidThroughSubscription(db, 7)).resolves.toBe(true);
    await expect(hasPaidThroughSubscription(db, 7)).resolves.toBe(false);

    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("status <> 'ended'");
    expect(sql).toContain('paid_through > NOW()');
    expect(db.query.mock.calls[0][1]).toEqual([7]);
  });
});

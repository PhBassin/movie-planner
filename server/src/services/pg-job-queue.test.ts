import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScrapeJob } from '@movie-planner/scraper-protocol';

// ---------------------------------------------------------------------------
// Mock `pg` so PgJobQueue owns a fake pool. Mirrors the ioredis-mock style used
// by redis-client.test.ts — no real Postgres is contacted here; the
// concurrency/restart behaviour is covered by the gated integration test.
// ---------------------------------------------------------------------------

const mockPool = vi.hoisted(() => ({
  query: vi.fn(),
  end: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('pg', () => ({
  // `import pg from 'pg'` resolves to the module.exports namespace; pg.Pool is
  // the constructor used by the app. Expose it on the default export.
  default: {
    Pool: function MockPool() {
      return mockPool;
    },
  },
}));

import { PgJobQueue } from './pg-job-queue.js';

describe('PgJobQueue', () => {
  let queue: PgJobQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.end.mockResolvedValue(undefined);
    // The pool is constructed inside PgJobQueue; supply a placeholder URL.
    queue = new PgJobQueue('postgres://test');
  });

  describe('enqueue', () => {
    it('inserts the serialized job as JSONB', async () => {
      const job: ScrapeJob = { type: 'scrape', reportId: 7, triggerType: 'manual' };
      // First call: INSERT; second call: COUNT.
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '1' }] });

      await queue.enqueue(job);

      expect(mockPool.query).toHaveBeenNthCalledWith(
        1,
        'INSERT INTO scrape_jobs (payload) VALUES ($1::jsonb)',
        [JSON.stringify(job)],
      );
    });

    it('returns the new queue depth after enqueue', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '3' }] });

      const depth = await queue.enqueue({ type: 'scrape', reportId: 1, triggerType: 'cron' });

      expect(depth).toBe(3);
      expect(mockPool.query).toHaveBeenNthCalledWith(
        2,
        'SELECT COUNT(*)::text AS count FROM scrape_jobs',
      );
    });
  });

  describe('enqueueAddTheater', () => {
    it('inserts an add_theater job built from reportId + url', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '1' }] });

      const depth = await queue.enqueueAddTheater(42, 'http://theater');

      expect(depth).toBe(1);
      expect(mockPool.query).toHaveBeenNthCalledWith(
        1,
        'INSERT INTO scrape_jobs (payload) VALUES ($1::jsonb)',
        [JSON.stringify({ type: 'add_theater', triggerType: 'manual', reportId: 42, url: 'http://theater' })],
      );
    });
  });

  describe('depth', () => {
    it('parses the count returned by Postgres', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ count: '5' }] });

      const depth = await queue.depth();

      expect(depth).toBe(5);
    });

    it('returns 0 for an empty queue', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const depth = await queue.depth();

      expect(depth).toBe(0);
    });
  });

  describe('close', () => {
    it('ends the underlying pool', async () => {
      await queue.close();

      expect(mockPool.end).toHaveBeenCalledTimes(1);
    });
  });
});

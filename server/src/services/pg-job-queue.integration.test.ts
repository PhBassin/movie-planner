import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PgJobQueue } from './pg-job-queue.js';

const TEST_URL = process.env.PG_QUEUE_TEST_URL ?? process.env.PG_INIT_TEST_URL;

describe.runIf(Boolean(TEST_URL))('Postgres queue producer integration', () => {
  let setupPool: pg.Pool;
  let queue: PgJobQueue;

  beforeAll(async () => {
    setupPool = new pg.Pool({ connectionString: TEST_URL });
    await setupPool.query(`
      CREATE TABLE IF NOT EXISTS scrape_jobs (
        id BIGSERIAL PRIMARY KEY,
        payload JSONB NOT NULL,
        enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });

  beforeEach(async () => {
    await setupPool.query('TRUNCATE scrape_jobs RESTART IDENTITY');
    queue = new PgJobQueue(TEST_URL);
  });

  afterAll(async () => {
    await queue?.close();
    await setupPool?.end();
  });

  it('round-trips scrape and add_theater jobs and reports depth', async () => {
    await expect(queue.enqueue({ type: 'scrape', reportId: 1, triggerType: 'manual' }))
      .resolves.toBe(1);
    await expect(queue.enqueueAddTheater(2, 'https://example.test/theater'))
      .resolves.toBe(2);

    const result = await setupPool.query<{ payload: { type: string; reportId: number } }>(
      'SELECT payload FROM scrape_jobs ORDER BY id',
    );
    expect(result.rows.map((row) => row.payload)).toEqual([
      { type: 'scrape', reportId: 1, triggerType: 'manual' },
      { type: 'add_theater', triggerType: 'manual', reportId: 2, url: 'https://example.test/theater' },
    ]);
  });
});

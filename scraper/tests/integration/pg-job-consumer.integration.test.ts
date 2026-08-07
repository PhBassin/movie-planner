import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PgJobConsumer } from '../../src/bus/pg-job-consumer.js';

const TEST_URL = process.env.PG_QUEUE_TEST_URL ?? process.env.PG_INIT_TEST_URL;

describe.runIf(Boolean(TEST_URL))('Postgres queue consumer integration', () => {
  let setupPool: pg.Pool;
  const consumers: PgJobConsumer[] = [];

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
  });

  afterAll(async () => {
    for (const consumer of consumers) await consumer.disconnect();
    await setupPool?.end();
  });

  it('claims distinct jobs under concurrent consumers', async () => {
    await setupPool.query(
      `INSERT INTO scrape_jobs (payload) VALUES ($1::jsonb), ($2::jsonb)`,
      [
        JSON.stringify({ type: 'scrape', reportId: 1, triggerType: 'manual' }),
        JSON.stringify({ type: 'scrape', reportId: 2, triggerType: 'manual' }),
      ],
    );

    const first = new PgJobConsumer(TEST_URL, 0);
    const second = new PgJobConsumer(TEST_URL, 0);
    consumers.push(first, second);

    const jobs = await Promise.all([first.popOne(), second.popOne()]);

    expect(jobs.map((job) => job?.reportId).sort()).toEqual([1, 2]);
    await expect(setupPool.query('SELECT COUNT(*)::int AS count FROM scrape_jobs'))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('leaves unclaimed jobs available after a consumer restart', async () => {
    await setupPool.query(
      `INSERT INTO scrape_jobs (payload) VALUES ($1::jsonb), ($2::jsonb)`,
      [
        JSON.stringify({ type: 'scrape', reportId: 10, triggerType: 'manual' }),
        JSON.stringify({ type: 'scrape', reportId: 11, triggerType: 'manual' }),
      ],
    );

    const first = new PgJobConsumer(TEST_URL, 0);
    consumers.push(first);
    await expect(first.popOne()).resolves.toMatchObject({ reportId: 10 });
    await first.disconnect();

    const restarted = new PgJobConsumer(TEST_URL, 0);
    consumers.push(restarted);
    await expect(restarted.popOne()).resolves.toMatchObject({ reportId: 11 });
    await expect(restarted.popOne()).resolves.toBeNull();
  });

  it('does not retry a job after it has been claimed', async () => {
    await setupPool.query(
      `INSERT INTO scrape_jobs (payload) VALUES ($1::jsonb)`,
      [JSON.stringify({ type: 'scrape', reportId: 12, triggerType: 'manual' })],
    );

    const first = new PgJobConsumer(TEST_URL, 0);
    consumers.push(first);
    await expect(first.popOne()).resolves.toMatchObject({ reportId: 12 });
    await first.disconnect();

    const restarted = new PgJobConsumer(TEST_URL, 0);
    consumers.push(restarted);
    await expect(restarted.popOne()).resolves.toBeNull();
  });
});

import pg from 'pg';
import { pgConnectionConfig } from '@movie-planner/scraper-protocol';
import type { BusTransaction, ScrapeJob, ScrapeJobAddTheater } from '@movie-planner/scraper-protocol';
import { parseStrictInt } from '../utils/number.js';

// ---------------------------------------------------------------------------
// PgJobQueue — the Postgres implementation of the *queue* arm of the bus
// (web/producer side). The pub/sub arm still runs over Redis until LISTEN/NOTIFY
// lands (#25); PostgresBusProducer composes this queue with the Redis pub/sub
// delegate so callers see one BusProducer (issue #24, ADR 0009).
//
// The queue is the `scrape_jobs` table (migration 001). Enqueue inserts the
// serialized ScrapeJob as JSONB; the worker claims rows with
// `FOR UPDATE SKIP LOCKED` (see scraper/src/bus/pg-job-consumer.ts). This class
// owns its own pg.Pool — mirroring how RedisClient owns its Redis connections —
// which keeps the module side-effect free and unit-testable without a DB.
// ---------------------------------------------------------------------------

/**
 * Build a pg.Pool config from the same environment the application uses
 * (DATABASE_URL wins; otherwise the POSTGRES_* vars). Shared with the worker
 * and the pub/sub backends via `pgConnectionConfig` in scraper-protocol.
 */
function poolConfigFromEnv(): pg.PoolConfig {
  return pgConnectionConfig();
}

const INSERT_JOB = 'INSERT INTO scrape_jobs (payload) VALUES ($1::jsonb)';
const COUNT_JOBS = 'SELECT COUNT(*)::text AS count FROM scrape_jobs';

export class PgJobQueue {
  private readonly pool: pg.Pool;

  constructor(connectionString?: string) {
    this.pool = new pg.Pool(
      connectionString ? { connectionString } : poolConfigFromEnv(),
    );
  }

  /** Insert a scrape job and return a queue-depth snapshot. */
  async enqueue(job: ScrapeJob, transaction?: BusTransaction): Promise<number> {
    return this.enqueueSerialized(JSON.stringify(job), transaction);
  }

  /** Insert an `add_theater` job and return a queue-depth snapshot. */
  async enqueueAddTheater(reportId: number, url: string, transaction?: BusTransaction): Promise<number> {
    const job: ScrapeJobAddTheater = { type: 'add_theater', triggerType: 'manual', reportId, url };
    return this.enqueueSerialized(JSON.stringify(job), transaction);
  }

  /** Return the queue-depth snapshot visible to the enqueue transaction. */
  private async enqueueSerialized(payload: string, transaction?: BusTransaction): Promise<number> {
    const executor = transaction ?? this.pool;
    await executor.query(INSERT_JOB, [payload]);
    const result = await executor.query<{ count: string }>(COUNT_JOBS);
    return parseStrictInt(result.rows[0]?.count);
  }

  /** Current number of jobs waiting in the queue. */
  async depth(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(COUNT_JOBS);
    return parseStrictInt(result.rows[0]?.count);
  }

  /** Close the underlying pool (graceful shutdown). */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

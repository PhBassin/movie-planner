import pg from 'pg';
import { parseJob, pgConnectionConfig, type ScrapeJob } from '@movie-planner/scraper-protocol';
import { logger } from '../utils/logger.js';

const CLAIM_JOB = `
  WITH next_job AS (
    SELECT id, payload::text AS payload
    FROM scrape_jobs
    ORDER BY id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  DELETE FROM scrape_jobs
  USING next_job
  WHERE scrape_jobs.id = next_job.id
  RETURNING next_job.payload
`;

const DEFAULT_POLL_INTERVAL_MS = 2000;

function poolConfigFromEnv(): pg.PoolConfig {
  return pgConnectionConfig();
}

/** Postgres queue consumer; claiming removes a job atomically before handling. */
export class PgJobConsumer {
  private readonly pool: pg.Pool;
  private running = false;

  constructor(
    connectionString?: string,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ) {
    this.pool = new pg.Pool(
      connectionString ? { connectionString } : poolConfigFromEnv(),
    );
  }

  /** Claim the oldest available job, or null when the queue is empty. */
  async popOne(): Promise<ScrapeJob | null> {
    const result = await this.pool.query<{ payload: string }>(CLAIM_JOB);
    const payload = result.rows[0]?.payload;
    if (payload === undefined) return null;
    return parseJob(payload);
  }

  /** Poll until stopped, handling each atomically claimed job once. */
  async start(handler: (job: ScrapeJob) => Promise<void>): Promise<void> {
    this.running = true;
    logger.info('[PgJobConsumer] Waiting for scrape jobs on scrape_jobs');

    while (this.running) {
      let job: ScrapeJob | null;
      try {
        job = await this.popOne();
      } catch (error) {
        if (!this.running) break;
        logger.error('[PgJobConsumer] Error claiming queue job', { error });
        await this.sleep();
        continue;
      }

      if (!job) {
        await this.sleep();
        continue;
      }

      logger.info('[PgJobConsumer] Received job', {
        reportId: job.reportId,
        type: job.type,
        trigger: job.triggerType,
      });

      try {
        await handler(job);
      } catch (error) {
        // The row was deleted by the claim: log the failure and do not retry
        // the job.
        logger.error('[PgJobConsumer] Job handler failed', { error });
      }
    }

    logger.info('[PgJobConsumer] Stopped.');
  }

  stop(): void {
    this.running = false;
  }

  async disconnect(): Promise<void> {
    this.stop();
    await this.pool.end();
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
  }
}

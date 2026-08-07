import type {
  BusProducer,
  BusTransaction,
  ProgressEvent,
  ScheduleChangeEvent,
  ScrapeJob,
} from '@movie-planner/scraper-protocol';
import { PgJobQueue } from './pg-job-queue.js';
import { getRedisClient } from './redis-client.js';

// ---------------------------------------------------------------------------
// PostgresBusProducer — the active BusProducer backend for the `web` role.
//
// Issue #24 moves the job queue off the Redis `scrape:jobs` list onto the
// Postgres `scrape_jobs` table (PgJobQueue). The pub/sub arms (progress +
// schedule-change) still run over Redis until LISTEN/NOTIFY lands (#25); this
// class delegates them to the existing RedisClient so callers keep seeing one
// BusProducer. #25 swaps the pub/sub delegate; #26 retires Redis entirely.
// ---------------------------------------------------------------------------

export class PostgresBusProducer implements BusProducer {
  constructor(
    private readonly queue: PgJobQueue,
    private readonly pubsub: BusProducer,
  ) {}

  // --- Job queue (Postgres) --------------------------------------------------

  enqueueJob(job: ScrapeJob, transaction?: BusTransaction): Promise<number> {
    return this.queue.enqueue(job, transaction);
  }

  enqueueAddTheaterJob(reportId: number, url: string, transaction?: BusTransaction): Promise<number> {
    return this.queue.enqueueAddTheater(reportId, url, transaction);
  }

  getQueueDepth(): Promise<number> {
    return this.queue.depth();
  }

  // --- Pub/sub (Redis, until #25 moves these to LISTEN/NOTIFY) --------------

  subscribeToProgress(handler: (event: ProgressEvent) => void): Promise<void> {
    return this.pubsub.subscribeToProgress(handler);
  }

  publishScheduleChange(event: ScheduleChangeEvent): Promise<void> {
    return this.pubsub.publishScheduleChange(event);
  }

  // --- Lifecycle -------------------------------------------------------------

  async disconnect(): Promise<void> {
    await Promise.all([this.queue.close(), this.pubsub.disconnect()]);
  }
}

// ---------------------------------------------------------------------------
// Singleton — initialised lazily so tests can mock the module before any caller
// imports it. Returns the BusProducer port so callers depend on the contract,
// not on the concrete Postgres + Redis backends.
// ---------------------------------------------------------------------------

let _producer: PostgresBusProducer | null = null;

export function getBusProducer(): BusProducer {
  if (!_producer) {
    _producer = new PostgresBusProducer(new PgJobQueue(), getRedisClient());
  }
  return _producer;
}

/** Reset the singleton (useful in tests). */
export function resetBusProducer(): void {
  _producer = null;
}

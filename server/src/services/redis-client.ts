import Redis from 'ioredis';
import type {
  ProgressEvent,
  ScrapeJob,
  ScrapeJobAddTheater,
  ScheduleChangeEvent,
  BusProducer,
} from '@movie-planner/scraper-protocol';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types — re-exported from @movie-planner/scraper-protocol so existing
// importers keep working without churn. The wire contract lives in one place.
// ---------------------------------------------------------------------------

export type {
  ScrapeJob,
  ScheduleChangeEvent,
} from '@movie-planner/scraper-protocol';

// ---------------------------------------------------------------------------
// RedisClient — the Redis implementation of the BusProducer port (web role).
// The port itself (BusProducer) lives in @movie-planner/scraper-protocol; this
// class is the concrete backend. The worker side's progress publisher lives in
// the scraper image — the server never publishes progress.
// ---------------------------------------------------------------------------

export class RedisClient implements BusProducer {
  private publisher: Redis;
  private subscriber: Redis;

  constructor(redisUrl: string) {
    this.publisher = new Redis(redisUrl, { lazyConnect: false });
    this.subscriber = new Redis(redisUrl, { lazyConnect: false });
  }

  // --------------------------------------------------------------------------
  // Job queue (scrape:jobs)  – web → worker
  // --------------------------------------------------------------------------

  /** Enqueue a scrape job. Returns the new queue depth. */
  async enqueueJob(job: ScrapeJob): Promise<number> {
    return this.publisher.rpush('scrape:jobs', JSON.stringify(job));
  }

  /** Enqueue an `add_theater` job. Returns the new queue depth. */
  async enqueueAddTheaterJob(reportId: number, url: string): Promise<number> {
    const job: ScrapeJobAddTheater = { type: 'add_theater', triggerType: 'manual', reportId, url };
    return this.publisher.rpush('scrape:jobs', JSON.stringify(job));
  }

  /** Current depth of the scrape:jobs queue. */
  async getQueueDepth(): Promise<number> {
    return this.publisher.llen('scrape:jobs');
  }

  // --------------------------------------------------------------------------
  // Progress events (scrape:progress)  – worker → web → SSE clients
  // --------------------------------------------------------------------------

  /** Subscribe to real-time progress events emitted by the worker. */
  async subscribeToProgress(handler: (event: ProgressEvent) => void): Promise<void> {
    await this.subscriber.subscribe('scrape:progress');

    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel !== 'scrape:progress') return;
      try {
        const event: ProgressEvent = JSON.parse(message);
        handler(event);
      } catch (err) {
        logger.error('[RedisClient] Failed to parse progress event:', err);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Schedule change events (scraper:schedule:changed) – web → worker
  // --------------------------------------------------------------------------

  /**
   * Publish a schedule-change notice so the worker reloads its cron registrations.
   * (Called via the BusProducer port from routes/scraper-schedules.ts.)
   */
  async publishScheduleChange(event: ScheduleChangeEvent): Promise<void> {
    await this.publisher.publish('scraper:schedule:changed', JSON.stringify(event));
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async disconnect(): Promise<void> {
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}

// ---------------------------------------------------------------------------
// Singleton – initialised lazily so tests can mock ioredis before importing.
// Returns the BusProducer port so callers depend on the contract, not the
// concrete Redis backend.
// ---------------------------------------------------------------------------

let _instance: RedisClient | null = null;

export function getRedisClient(): BusProducer {
  if (!_instance) {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    _instance = new RedisClient(url);
  }
  return _instance;
}

/** Reset the singleton (useful in tests). */
export function resetRedisClient(): void {
  _instance = null;
}

import Redis from 'ioredis';
import type {
  ProgressEvent,
  ScrapeJob,
  ScheduleChangeEvent,
  BusConsumer,
} from '@movie-planner/scraper-protocol';
import { logger } from '../utils/logger.js';
import { PgJobConsumer } from '../bus/pg-job-consumer.js';
import { PostgresBusConsumer } from '../bus/postgres-consumer.js';

// ---------------------------------------------------------------------------
// Types — re-exported from @movie-planner/scraper-protocol so existing
// importers keep working without churn. The wire contract lives in one place.
// ---------------------------------------------------------------------------

export type {
  ScrapeJob,
  ScheduleChangeEvent,
  BusConsumer,
} from '@movie-planner/scraper-protocol';

// ---------------------------------------------------------------------------
// Internal Redis-backed building blocks.
//
// These classes are the concrete Redis implementation of each bus arm. They
// are exported for testing but the worker role does not use them directly —
// it goes through `RedisBusConsumer` (below), which composes them and
// implements the `BusConsumer` port. A future Postgres backend (#24/#25)
// provides its own `BusConsumer` implementation and these classes retire.
// ---------------------------------------------------------------------------

/**
 * Publishes progress events to the `scrape:progress` Redis pub/sub channel.
 * `emit` satisfies the scraper's internal `ProgressPublisher` contract
 * (see `src/scraper/scrape-run.ts`) — distinct from the bus-level
 * `BusConsumer.publishProgress`, which `RedisBusConsumer` exposes.
 */
export class RedisProgressPublisher {
  protected readonly client: Redis;

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl, { lazyConnect: false });
  }

  /** Publish a progress event to the scrape:progress pub/sub channel. */
  async emit(event: ProgressEvent): Promise<void> {
    await this.client.publish('scrape:progress', JSON.stringify(event));
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}

/**
 * Consumes jobs from the `scrape:jobs` Redis list. The `consumer` role uses
 * `start` (a blocking BLPOP loop); the `oneshot` role uses `popOne`
 * (non-blocking LPOP).
 */
export class RedisJobConsumer {
  private readonly client: Redis;
  private running = false;

  constructor(redisUrl: string) {
    // Dedicated connection for blocking operations.
    this.client = new Redis(redisUrl, { lazyConnect: false });
  }

  /**
   * Blocking consume loop. Calls `handler` for each job popped. Loops on a
   * 5-second BLPOP so a `stop()` call can drain cleanly between pops.
   */
  async start(handler: (job: ScrapeJob) => Promise<void>): Promise<void> {
    this.running = true;
    logger.info('[RedisJobConsumer] Waiting for scrape jobs on scrape:jobs');

    while (this.running) {
      try {
        // Block for up to 5 seconds, then loop to allow clean shutdown.
        const result = await this.client.blpop('scrape:jobs', 5);

        if (!result) continue; // Timeout, loop again.

        const [_key, raw] = result;
        let job: ScrapeJob;
        try {
          job = JSON.parse(raw);
        } catch (err) {
          logger.error('[RedisJobConsumer] Failed to parse job', { raw, err });
          continue;
        }

        logger.info('[RedisJobConsumer] Received job', { reportId: job.reportId, type: job.type, trigger: job.triggerType });

        try {
          await handler(job);
        } catch (err) {
          logger.error('[RedisJobConsumer] Job handler failed', { err });
        }
      } catch (err: any) {
        // If connection closed cleanly during shutdown, stop.
        if (!this.running) break;
        logger.error('[RedisJobConsumer] Error polling queue', { err });
        // Brief pause to avoid tight loop on persistent errors.
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    logger.info('[RedisJobConsumer] Stopped.');
  }

  /**
   * Pop one job without blocking. Returns `null` when the queue is empty.
   * Used by `oneshot` mode.
   */
  async popOne(): Promise<ScrapeJob | null> {
    const raw = await this.client.lpop('scrape:jobs');
    if (!raw) return null;
    return JSON.parse(raw) as ScrapeJob;
  }

  stop(): void {
    this.running = false;
  }

  async disconnect(): Promise<void> {
    this.stop();
    await this.client.quit();
  }
}

/** Listens for schedule-change events on the `scraper:schedule:changed` channel. */
class RedisScheduleSubscriber {
  private readonly client: Redis;

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl, { lazyConnect: false });
  }

  async subscribe(channel: string, handler: (event: ScheduleChangeEvent) => void): Promise<void> {
    await this.client.subscribe(channel);

    this.client.on('message', (ch: string, message: string) => {
      if (ch !== channel) return;
      try {
        const event: ScheduleChangeEvent = JSON.parse(message);
        handler(event);
      } catch (err) {
        logger.error('[RedisScheduleSubscriber] Failed to parse schedule event:', err);
      }
    });

    logger.info(`[RedisScheduleSubscriber] Subscribed to channel: ${channel}`);
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}

// ---------------------------------------------------------------------------
// RedisBusConsumer — the Redis implementation of the BusConsumer port.
//
// Composes the three internal Redis clients behind the bus contract so the
// worker role depends on `BusConsumer`, not on Redis. `progressPublisher` is
// exposed for the scraper's internal `ProgressPublisher` contract (the
// scrape-run/strategies call `emit`); everything else goes through the port.
// ---------------------------------------------------------------------------

export class RedisBusConsumer implements BusConsumer {
  readonly progressPublisher: RedisProgressPublisher;
  private readonly consumer: RedisJobConsumer | null;
  private readonly subscriber: RedisScheduleSubscriber;

  constructor(redisUrl: string, includeJobQueue = true) {
    this.progressPublisher = new RedisProgressPublisher(redisUrl);
    this.consumer = includeJobQueue ? new RedisJobConsumer(redisUrl) : null;
    this.subscriber = new RedisScheduleSubscriber(redisUrl);
  }

  async publishProgress(event: ProgressEvent): Promise<void> {
    await this.progressPublisher.emit(event);
  }

  async consumeJobs(handler: (job: ScrapeJob) => Promise<void>): Promise<void> {
    if (!this.consumer) throw new Error('Redis job queue is disabled');
    await this.consumer.start(handler);
  }

  stopConsuming(): void {
    this.consumer?.stop();
  }

  async popOneJob(): Promise<ScrapeJob | null> {
    if (!this.consumer) throw new Error('Redis job queue is disabled');
    return this.consumer.popOne();
  }

  async subscribeScheduleChange(handler: (event: ScheduleChangeEvent) => void): Promise<void> {
    await this.subscriber.subscribe('scraper:schedule:changed', handler);
  }

  async disconnect(): Promise<void> {
    await Promise.all([
      this.progressPublisher.disconnect(),
      this.consumer?.disconnect(),
      this.subscriber.disconnect(),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Singleton — initialised lazily so tests can mock ioredis before importing.
// Returns the BusConsumer port so callers depend on the contract, not the
// concrete Redis backend.
// ---------------------------------------------------------------------------

let _consumer: BusConsumer | null = null;

export function getBusConsumer(): BusConsumer {
  if (!_consumer) {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    _consumer = new PostgresBusConsumer(
      new PgJobConsumer(),
      new RedisBusConsumer(url, false),
    );
  }
  return _consumer;
}

/** Tear down the singleton bus consumer (graceful shutdown). */
export async function disconnectBus(): Promise<void> {
  await _consumer?.disconnect();
  _consumer = null;
}

import {
  NOTIFICATION_CHANNELS,
  type BusProducer,
  type BusTransaction,
  type NotificationBus,
  type ProgressEvent,
  type ScheduleChangeEvent,
  type ScrapeJob,
} from '@movie-planner/scraper-protocol';
import { logger } from '../utils/logger.js';
import { PgJobQueue } from './pg-job-queue.js';
import { PostgresNotificationBus } from './postgres-notification-bus.js';

// ---------------------------------------------------------------------------
// PostgresBusProducer — the active BusProducer backend for the `web` role.
//
// Both arms now run on Postgres (ADR 0009): the job queue lives on the
// `scrape_jobs` table (`PgJobQueue`, issue #24) and the pub/sub fan-outs
// (progress + schedule-change) run over LISTEN/NOTIFY (`PostgresNotificationBus`,
// issue #25). Redis is no longer part of the producer; issue #26 retires the
// leftover Redis code across the repo.
// ---------------------------------------------------------------------------

export class PostgresBusProducer implements BusProducer {
  constructor(
    private readonly queue: PgJobQueue,
    private readonly notifications: NotificationBus = new PostgresNotificationBus(),
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

  // --- Pub/sub (Postgres LISTEN/NOTIFY) --------------------------------------

  subscribeToProgress(handler: (event: ProgressEvent) => void): Promise<void> {
    return this.notifications.subscribe(NOTIFICATION_CHANNELS.progress, (payload) => {
      try {
        handler(JSON.parse(payload) as ProgressEvent);
      } catch (error) {
        logger.error('[PostgresBusProducer] Failed to parse progress event:', error);
      }
    });
  }

  async publishScheduleChange(event: ScheduleChangeEvent): Promise<void> {
    await this.notifications.publish(NOTIFICATION_CHANNELS.scheduleChanged, JSON.stringify(event));
  }

  // --- Lifecycle -------------------------------------------------------------

  async disconnect(): Promise<void> {
    await Promise.all([this.queue.close(), this.notifications.disconnect()]);
  }
}

// ---------------------------------------------------------------------------
// Singleton — initialised lazily so tests can mock the module before any caller
// imports it. Returns the BusProducer port so callers depend on the contract,
// not on the concrete Postgres backends.
// ---------------------------------------------------------------------------

let _producer: PostgresBusProducer | null = null;

export function getBusProducer(): BusProducer {
  if (!_producer) {
    _producer = new PostgresBusProducer(new PgJobQueue());
  }
  return _producer;
}

/** Reset the singleton (useful in tests). */
export function resetBusProducer(): void {
  _producer = null;
}

import {
  NOTIFICATION_CHANNELS,
  type BusConsumer,
  type NotificationBus,
  type ProgressEvent,
  type ScheduleChangeEvent,
  type ScrapeJob,
} from '@movie-planner/scraper-protocol';
import { logger } from '../utils/logger.js';
import { PgJobConsumer } from './pg-job-consumer.js';
import { PostgresNotificationBus } from './postgres-notification-bus.js';

/**
 * Worker bus after the incremental migration: Postgres owns the queue
 * (`PgJobConsumer`, issue #24) and the pub/sub fan-outs run over LISTEN/NOTIFY
 * (`PostgresNotificationBus`, issue #25). Redis is no longer part of the
 * consumer; issue #26 retires the leftover Redis code across the repo.
 */
export class PostgresBusConsumer implements BusConsumer {
  constructor(
    private readonly queue: PgJobConsumer,
    private readonly notifications: NotificationBus = new PostgresNotificationBus(),
  ) {}

  /**
   * Publish a progress event (worker → web → SSE).
   *
   * Best-effort by design: progress is ephemeral telemetry and the durable
   * outcome lives in the report row, so a publish failure (e.g. a payload
   * over PostgreSQL's 8 KB notification cap, or a transient Postgres outage)
   * must never fail the scrape job it reports on. A dropped notification is
   * the same as a client that was not connected — nothing durable is lost.
   */
  async publishProgress(event: ProgressEvent): Promise<void> {
    try {
      await this.notifications.publish(NOTIFICATION_CHANNELS.progress, JSON.stringify(event));
    } catch (error) {
      logger.error('[PostgresBusConsumer] Dropped progress notification', { error });
    }
  }

  consumeJobs(handler: (job: ScrapeJob) => Promise<void>): Promise<void> {
    return this.queue.start(handler);
  }

  stopConsuming(): void {
    this.queue.stop();
  }

  popOneJob(): Promise<ScrapeJob | null> {
    return this.queue.popOne();
  }

  subscribeScheduleChange(handler: (event: ScheduleChangeEvent) => void): Promise<void> {
    return this.notifications.subscribe(NOTIFICATION_CHANNELS.scheduleChanged, (payload) => {
      try {
        handler(JSON.parse(payload) as ScheduleChangeEvent);
      } catch (error) {
        logger.error('[PostgresBusConsumer] Failed to parse schedule-change event:', error);
      }
    });
  }

  async disconnect(): Promise<void> {
    await Promise.all([this.queue.disconnect(), this.notifications.disconnect()]);
  }
}

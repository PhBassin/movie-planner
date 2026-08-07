import type {
  BusConsumer,
  ProgressEvent,
  ScheduleChangeEvent,
  ScrapeJob,
} from '@movie-planner/scraper-protocol';
import { PgJobConsumer } from './pg-job-consumer.js';

/**
 * Worker bus during the incremental migration: Postgres owns the queue while
 * Redis continues to carry progress and schedule-change pub/sub until #25.
 */
export class PostgresBusConsumer implements BusConsumer {
  constructor(
    private readonly queue: PgJobConsumer,
    private readonly pubsub: BusConsumer,
  ) {}

  publishProgress(event: ProgressEvent): Promise<void> {
    return this.pubsub.publishProgress(event);
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
    return this.pubsub.subscribeScheduleChange(handler);
  }

  async disconnect(): Promise<void> {
    await Promise.all([this.queue.disconnect(), this.pubsub.disconnect()]);
  }
}

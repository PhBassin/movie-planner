import type { BusConsumer } from '@movie-planner/scraper-protocol';
import { PgJobConsumer } from './pg-job-consumer.js';
import { PostgresBusConsumer } from './postgres-consumer.js';

// ---------------------------------------------------------------------------
// Worker-role bus factory — the `worker` entrypoint (`src/index.ts`) resolves
// its `BusConsumer` here. Both arms run on Postgres (ADR 0009): the job queue
// lives on the `scrape_jobs` table (`PgJobConsumer`, issue #24) and the
// pub/sub fan-outs (progress + schedule-change) run over LISTEN/NOTIFY
// (`PostgresNotificationBus`, issue #25).
// ---------------------------------------------------------------------------

let _consumer: BusConsumer | null = null;

export function getBusConsumer(): BusConsumer {
  if (!_consumer) {
    _consumer = new PostgresBusConsumer(new PgJobConsumer());
  }
  return _consumer;
}

/** Tear down the singleton bus consumer (graceful shutdown). */
export async function disconnectBus(): Promise<void> {
  await _consumer?.disconnect();
  _consumer = null;
}

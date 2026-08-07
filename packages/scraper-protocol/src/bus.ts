import type { ScrapeJob } from './jobs.js';
import type { ProgressEvent, ScheduleChangeEvent } from './events.js';

export interface BusTransaction {
  query<T = Record<string, unknown>>(text: string, params?: any[]): Promise<{ rows: T[] }>;
}

// ---------------------------------------------------------------------------
// Bus port — the cross-process contract between the `web` and `worker` roles.
//
// Today both roles are separate images (server, scraper) wired through Redis.
// ADR 0009 consolidates them into one image with two roles backed by Postgres
// (job queue via `FOR UPDATE SKIP LOCKED`, pub/sub via `LISTEN/NOTIFY`). This
// port is the seam that makes that swap a drop-in: the role code depends on
// the interface, not the backend. `member:notices` is a documented peer
// channel (CONTEXT.md, ADR 0005) but has no callers in code yet; it joins the
// port when it gains an implementation.
// ---------------------------------------------------------------------------

/**
 * Producer side of the bus — used by the `web` role.
 *
 * The web process enqueues scrape jobs, subscribes to progress events for
 * SSE fan-out, and publishes schedule-change notices (the DB remains the
 * source of truth for the schedules table; this is a reload nudge).
 */
export interface BusProducer {
  /** Enqueue a scrape job. Returns a queue-depth snapshot. */
  enqueueJob(job: ScrapeJob, transaction?: BusTransaction): Promise<number>;

  /** Enqueue an `add_theater` job. Returns a queue-depth snapshot. */
  enqueueAddTheaterJob(reportId: number, url: string, transaction?: BusTransaction): Promise<number>;

  /** Current depth of the job queue. */
  getQueueDepth(): Promise<number>;

  /** Subscribe to real-time progress events emitted by the worker. */
  subscribeToProgress(handler: (event: ProgressEvent) => void): Promise<void>;

  /** Publish a schedule-change notice (server → worker). */
  publishScheduleChange(event: ScheduleChangeEvent): Promise<void>;

  /** Tear down all connections held by this backend (graceful shutdown). */
  disconnect(): Promise<void>;
}

/**
 * Consumer side of the bus — used by the `worker` role.
 *
 * The worker publishes progress, consumes jobs (long-running blocking loop in
 * `consumer` mode, single non-blocking pop in `oneshot` mode), and subscribes
 * to schedule-change notices to reload its cron registrations.
 */
export interface BusConsumer {
  /** Publish a progress event for the web role to fan out over SSE. */
  publishProgress(event: ProgressEvent): Promise<void>;

  /**
   * Blocking consume loop — invokes `handler` once per job. Resolves when
   * `stopConsuming()` halts it (graceful shutdown). Used by `consumer` mode.
   */
  consumeJobs(handler: (job: ScrapeJob) => Promise<void>): Promise<void>;

  /** Signal the blocking consume loop to drain and return. */
  stopConsuming(): void;

  /**
   * Pop one job without blocking. Returns `null` when the queue is empty.
   * Used by `oneshot` mode.
   */
  popOneJob(): Promise<ScrapeJob | null>;

  /** Subscribe to schedule-change notices published by the web role. */
  subscribeScheduleChange(handler: (event: ScheduleChangeEvent) => void): Promise<void>;

  /** Tear down all connections held by this backend (graceful shutdown). */
  disconnect(): Promise<void>;
}

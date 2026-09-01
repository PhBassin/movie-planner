import type { ScrapeJob } from './jobs.js';
import type { MemberNotice, ProgressEvent, ScheduleChangeEvent } from './events.js';

export interface BusTransaction {
  query<T = Record<string, unknown>>(text: string, params?: any[]): Promise<{ rows: T[] }>;
}

// ---------------------------------------------------------------------------
// Bus port — the cross-process contract between the `web` and `worker` roles.
//
// ADR 0009 consolidates the roles into one image backed by Postgres: the job
// queue runs on the `scrape_jobs` table with `FOR UPDATE SKIP LOCKED` and the
// pub/sub fan-outs run on `LISTEN/NOTIFY` (see `notifications.ts`). This port
// is the seam that makes the backend a drop-in: role code depends on the
// interface, not the concrete queue/transport. The `member:notices` channel
// (ADR 0005) rides the same pub/sub arm: the web role's resolver publishes
// Member notices and the web role's SSE router subscribes — separate web
// instances fan out to whichever holds the Member's live connections.
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

  /**
   * Publish a Member-domain notice on the `member:notices` channel (ADR 0005).
   * Best-effort: the notice is ephemeral by design — the submission row is the
   * durable record — so a publish failure is logged and swallowed.
   */
  publishMemberNotice(notice: MemberNotice): Promise<void>;

  /** Subscribe to Member-domain notices for per-Member SSE fan-out. */
  subscribeToMemberNotices(handler: (notice: MemberNotice) => void): Promise<void>;

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

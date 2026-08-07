import cron from 'node-cron';
import type { BusConsumer, ScheduleChangeEvent } from '@movie-planner/scraper-protocol';
import { logger } from '../utils/logger.js';

/**
 * A schedule the cron ticker can register. This is the scheduler-facing
 * projection of a `scrape_schedules` row — only the fields the ticker needs
 * to decide *when* to fire and identify *which* schedule fired.
 */
export interface CronSchedule {
  id: number;
  name: string;
  cronExpression: string;
}

/**
 * Projects a snake_case schedule row (from the DB loader or a
 * `ScheduleChangeEvent` snapshot) into the scheduler's own `CronSchedule`.
 * Centralizing the rename keeps the wire/DB shape out of the ticker.
 */
export function toCronSchedule(row: { id: number; name: string; cron_expression: string }): CronSchedule {
  return { id: row.id, name: row.name, cronExpression: row.cron_expression };
}

/**
 * Runs the scrape for a schedule when its cron expression ticks. Owns the
 * "how to scrape" half of the scraping domain; the `CronScheduler` owns only
 * the "when" (registration, reload, lifecycle). Kept as a callback so the
 * scheduler is a pure function of (bus, clock, db loader) and trivially
 * testable without a database or a real scraper.
 */
export type CronExecutor = (schedule: CronSchedule) => Promise<void>;

interface ActiveTask extends CronSchedule {
  task: ReturnType<typeof cron.schedule>;
}

export interface CronSchedulerDeps {
  /** Bus port used to subscribe to schedule-change notices from the web role. */
  bus: BusConsumer;
  /** Invoked when a registered cron expression fires. */
  executor: CronExecutor;
  /** Returns the enabled schedules to register at startup. */
  loadEnabledSchedules: () => Promise<CronSchedule[]>;
}

/**
 * Owns the cron ticker for the worker role. Loads persisted schedules at
 * startup, re-evaluates its in-process registrations when the web role
 * notifies a change, and tears everything down on shutdown. The database
 * (written by the web role) stays the source of truth; this is the
 * reload-and-fire projection of it.
 *
 * Folded into the worker by ADR 0009 (decision 3): scheduling travels with
 * job execution so the whole scraping domain stays in one process. There is
 * no standalone scheduler process.
 */
export class CronScheduler {
  private readonly activeTasks = new Map<number, ActiveTask>();
  private readonly deps: CronSchedulerDeps;

  constructor(deps: CronSchedulerDeps) {
    this.deps = deps;
  }

  /** Number of schedules currently registered (exposed for logging/tests). */
  get size(): number {
    return this.activeTasks.size;
  }

  /**
   * Load persisted schedules from the database and subscribe to live
   * schedule-change notices. A failure to load schedules is logged but does
   * not prevent the change subscription — a later change event will still
   * register schedules as they are edited.
   */
  async start(): Promise<void> {
    await this.loadInitial();
    await this.deps.bus.subscribeScheduleChange((event) => {
      void this.handleScheduleChange(event);
    });
  }

  private async loadInitial(): Promise<void> {
    try {
      const schedules = await this.deps.loadEnabledSchedules();
      for (const schedule of schedules) {
        this.register(schedule);
      }
      logger.info(`[scheduler] Loaded ${this.activeTasks.size} schedule(s) from database`);
    } catch (err) {
      logger.warn('[scheduler] Failed to load schedules from database:', err);
    }
  }

  /**
   * Re-evaluate registrations after the web role reports a schedules-row
   * change. Created and updated are the same operation here — stop any
   * existing task for the id, then register the new snapshot if it is
   * enabled.
   */
  async handleScheduleChange(event: ScheduleChangeEvent): Promise<void> {
    const { action, scheduleId, schedule } = event;
    logger.info(`[scheduler] Received schedule change event: ${action} for schedule ${scheduleId}`);

    switch (action) {
      case 'created':
      case 'updated':
        this.unregister(scheduleId);
        if (schedule && schedule.enabled !== false) {
          this.register(toCronSchedule({ id: scheduleId, name: schedule.name, cron_expression: schedule.cron_expression }));
          logger.info(`[scheduler] ${action === 'created' ? 'Added' : 'Updated'} schedule task: "${schedule.name}" (id=${scheduleId})`);
        } else {
          logger.info(`[scheduler] Schedule ${scheduleId} is disabled, not scheduling`);
        }
        break;

      case 'deleted':
        this.unregister(scheduleId);
        logger.info(`[scheduler] Removed schedule task: id=${scheduleId}`);
        break;
    }
  }

  /** Stop every registered task. Safe to call during shutdown. */
  stop(): void {
    for (const task of this.activeTasks.values()) {
      task.task.stop();
    }
    this.activeTasks.clear();
    logger.info('[scheduler] Stopped all scheduled tasks');
  }

  private register(schedule: CronSchedule): void {
    if (!cron.validate(schedule.cronExpression)) {
      logger.error(`[scheduler] Invalid cron expression for "${schedule.name}": ${schedule.cronExpression}`);
      return;
    }
    // Replace any existing task for this id before registering the new one.
    this.unregister(schedule.id);

    logger.info(`[scheduler] Scheduling "${schedule.name}" with cron: ${schedule.cronExpression}`);
    const task = cron.schedule(schedule.cronExpression, () => {
      // Fire-and-forget: the executor owns its own error handling, but guard
      // here too so a rejecting executor becomes a logged failure rather than
      // an unhandled-rejection process warning.
      this.deps.executor(schedule).catch((err) => {
        logger.error(`[scheduler] Executor for "${schedule.name}" (id=${schedule.id}) rejected:`, err);
      });
    });
    this.activeTasks.set(schedule.id, { ...schedule, task });
  }

  private unregister(id: number): void {
    const existing = this.activeTasks.get(id);
    if (existing) {
      existing.task.stop();
      this.activeTasks.delete(id);
    }
  }
}

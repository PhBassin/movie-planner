import { logger } from './utils/logger.js';
import { registry, scrapeJobsTotal, scrapeDurationSeconds, moviesScrapedTotal, showtimesScrapedTotal } from './utils/metrics.js';

import { runScraper, addTheaterAndScrape } from './scraper/index.js';
import type { ScrapeSummary } from './types/scraper.js';
import type { ProgressPublisher } from './scraper/scrape-run.js';
import { getBusConsumer, disconnectBus } from './bus/bus-consumer.js';
import type { BusConsumer } from '@movie-planner/scraper-protocol';
import type { ScrapeJob, ScrapeJobScrape, ScrapeJobAddTheater } from '@movie-planner/scraper-protocol';
import { db } from './db/client.js';
import { createScrapeReport, updateScrapeReport } from './db/report-queries.js';
import { getEnabledSchedules, updateScheduleRunStatus } from './db/schedule-queries.js';
import { CronScheduler, toCronSchedule, type CronSchedule } from './scheduler/cron-scheduler.js';

// ---------------------------------------------------------------------------
// Metrics HTTP server (always-on, port 9091)
// ---------------------------------------------------------------------------

const METRICS_PORT = parseInt(process.env.METRICS_PORT ?? '9091', 10);

async function startMetricsServer(): Promise<void> {
  const { default: express } = await import('express');
  const metricsApp = express();

  metricsApp.get('/metrics', async (_req, res) => {
    try {
      res.set('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    } catch (err) {
      res.status(500).end(String(err));
    }
  });

  metricsApp.listen(METRICS_PORT, () => {
    logger.info(`Metrics server listening on port ${METRICS_PORT}`);
  });
}


// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

/**
 * RUN_MODE controls how this container behaves:
 *  - "oneshot"  : Pop one job from the Postgres queue, execute it, then exit. (default)
 *  - "consumer" : Long-running worker process — consumes the job queue AND
 *                 runs the cron scheduler (ADR 0009: scheduling folds into
 *                 the worker so the scraping domain stays in one process).
 *  - "direct"   : Run scraper immediately once and exit (for local dev / manual use).
 */
type RunMode = 'oneshot' | 'consumer' | 'direct';

const RUN_MODE: RunMode = (process.env.RUN_MODE as RunMode) ?? 'oneshot';

// ---------------------------------------------------------------------------
// Job executor
// ---------------------------------------------------------------------------

export async function executeJob(job: ScrapeJob, progress: ProgressPublisher): Promise<void> {
  // Support legacy jobs that predate the discriminated union (no 'type' field)
  const jobType = ('type' in job) ? job.type : 'scrape';

  // Update report status
  try {
    await updateScrapeReport(db, job.reportId, { status: 'running' });
  } catch (err) {
    logger.warn(`[scraper] Could not update report ${job.reportId}:`, err);
  }

  // --- add_theater branch ---
  if (jobType === 'add_theater') {
    const addTheaterJob = job as ScrapeJobAddTheater;
    try {
      await addTheaterAndScrape(db, addTheaterJob.url, progress);
      await updateScrapeReport(db, job.reportId, {
        status: 'success',
        completed_at: new Date().toISOString(),
      });
      logger.info(`[scraper] add_theater job ${job.reportId} completed successfully`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`[scraper] add_theater job ${job.reportId} failed:`, err);
      await updateScrapeReport(db, job.reportId, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        errors: [{ theater_name: 'System', error: errorMessage }],
      }).catch(() => {});
    }
    return;
  }

  // --- scrape branch ---
  const durationTimer = scrapeDurationSeconds.startTimer({ theater: 'all' });

  try {
    const scrapeJob = job as ScrapeJobScrape;
    const summary = await runScraper(progress, scrapeJob.options);

    const status = summary.failed_theaters === 0
      ? 'success'
      : summary.successful_theaters > 0
        ? 'partial_success'
        : 'failed';

    durationTimer();
    scrapeJobsTotal.inc({ status, trigger: job.triggerType });
    moviesScrapedTotal.inc({ theater: 'all' }, summary.total_movies);
    showtimesScrapedTotal.inc({ theater: 'all' }, summary.total_showtimes);

    await updateScrapeReport(db, job.reportId, {
      status,
      completed_at: new Date().toISOString(),
      total_theaters: summary.total_theaters,
      successful_theaters: summary.successful_theaters,
      failed_theaters: summary.failed_theaters,
      total_movies_scraped: summary.total_movies,
      total_showtimes_scraped: summary.total_showtimes,
      errors: summary.errors,
    });

    logger.info(`[scraper] Job ${job.reportId} completed with status: ${status}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`[scraper] Job ${job.reportId} failed:`, err);
    scrapeJobsTotal.inc({ status: 'failed', trigger: job.triggerType });

    await updateScrapeReport(db, job.reportId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      errors: [{ theater_name: 'System', error: errorMessage }],
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Oneshot mode: pop one job and exit
// ---------------------------------------------------------------------------

/**
 * Derive the outcome status from a scrape summary and record it on the
 * report. Shared by the cron executor and the direct-run path so the status
 * rule (no failures → success, some → partial, none → failed) and the report
 * fields live in one place. Returns the status so callers can also update the
 * originating schedule row.
 */
async function recordScrapeOutcome(reportId: number, summary: ScrapeSummary): Promise<'success' | 'partial_success' | 'failed'> {
  const status = summary.failed_theaters === 0
    ? 'success'
    : summary.successful_theaters > 0
      ? 'partial_success'
      : 'failed';

  await updateScrapeReport(db, reportId, {
    status,
    completed_at: new Date().toISOString(),
    total_theaters: summary.total_theaters,
    successful_theaters: summary.successful_theaters,
    failed_theaters: summary.failed_theaters,
    total_movies_scraped: summary.total_movies,
    total_showtimes_scraped: summary.total_showtimes,
    errors: summary.errors,
  });

  return status;
}

async function runOneshot(bus: BusConsumer): Promise<void> {
  logger.info('[scraper] Mode: oneshot');

  try {
    const job = await bus.popOneJob();
    if (!job) {
      logger.info('[scraper] No job in queue. Exiting.');
      return;
    }

    logger.info(`[scraper] Processing job: reportId=${job.reportId}`);
    await executeJob(job, { emit: (event) => bus.publishProgress(event) });
  } finally {
    await disconnectBus();
    await db.end();
  }
}

// ---------------------------------------------------------------------------
// Worker mode: long-running queue consumer + cron scheduler
// ---------------------------------------------------------------------------

/**
 * Runs the scrape triggered by a cron tick. This is the "how to scrape" half
 * of the domain; the `CronScheduler` decides *when* to call it. Gated by
 * `ENABLE_SCRAPE_CRON` so a freshly-deployed worker registers schedules
 * (visible in logs/metrics) without firing scrapes until the operator opts in.
 */
export async function runScheduledScrape(bus: BusConsumer, schedule: CronSchedule): Promise<void> {
  if (process.env.ENABLE_SCRAPE_CRON !== 'true') {
    logger.info(`[scraper] External scheduled scraping disabled (ENABLE_SCRAPE_CRON is not true). Skipping cron execution for "${schedule.name}".`);
    return;
  }

  logger.info(`[scraper] Cron triggered for "${schedule.name}", starting scrape...`);

  let reportId: number;
  try {
    reportId = await createScrapeReport(db, 'cron');
  } catch (err) {
    logger.error('[scraper] Failed to create scrape report:', err);
    return;
  }

  const publisher: ProgressPublisher = { emit: (event) => bus.publishProgress(event) };

  try {
    const summary = await runScraper(publisher);

    const status = await recordScrapeOutcome(reportId, summary);
    await updateScheduleRunStatus(db, schedule.id, status);

    logger.info(`[scraper] Cron scrape for "${schedule.name}" completed: ${status}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`[scraper] Cron scrape for "${schedule.name}" failed:`, err);
    await updateScrapeReport(db, reportId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      errors: [{ theater_name: 'System', error: errorMessage }],
    }).catch(() => {});

    await updateScheduleRunStatus(db, schedule.id, 'failed').catch(() => {});
  }
}

async function runWorker(bus: BusConsumer): Promise<void> {
  logger.info('[scraper] Mode: worker (queue consumer + scheduler)');

  const scheduler = new CronScheduler({
    bus,
    executor: (schedule) => runScheduledScrape(bus, schedule),
    loadEnabledSchedules: async () => (await getEnabledSchedules(db)).map(toCronSchedule),
  });

  await scheduler.start();

  if (process.env.ENABLE_SCRAPE_CRON !== 'true') {
    logger.info('[scraper] ENABLE_SCRAPE_CRON is not set to "true". External scheduled scrapes will be skipped when triggered.');
  }
  logger.info(`[scraper] ${scheduler.size} cron task(s) scheduled. Listening for jobs and schedule changes...`);

  // Graceful shutdown — stop the cron tasks, drain the consumer, close pools.
  const shutdown = async (): Promise<void> => {
    logger.info('[scraper] Shutting down worker...');
    scheduler.stop();
    bus.stopConsuming();
    await disconnectBus();
    await db.end();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await bus.consumeJobs(async (job) => {
    await executeJob(job, { emit: (event) => bus.publishProgress(event) });
  });
}

// ---------------------------------------------------------------------------
// Direct mode: run once immediately and exit
// ---------------------------------------------------------------------------

async function runDirect(bus: BusConsumer): Promise<void> {
  logger.info('[scraper] Mode: direct (immediate one-time run)');

  let reportId: number;
  try {
    reportId = await createScrapeReport(db, 'manual');
  } catch (err) {
    logger.error('[scraper] Failed to create scrape report:', err);
    reportId = -1;
  }

  try {
    const publisher: ProgressPublisher = { emit: (event) => bus.publishProgress(event) };
    const summary = await runScraper(publisher);

    if (reportId !== -1) {
      await recordScrapeOutcome(reportId, summary);
    }

    logger.info('[scraper] Direct run completed.');
  } finally {
    await disconnectBus();
    await db.end();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info(`[scraper] Starting in ${RUN_MODE} mode...`);

  // Start metrics HTTP endpoint (non-blocking)
  await startMetricsServer();

  // One bus consumer drives every mode — queued jobs, progress publishing,
  // and schedule-change subscription all flow through this port.
  const bus = getBusConsumer();

  switch (RUN_MODE) {
    case 'oneshot':
      await runOneshot(bus);
      break;
    case 'consumer':
      await runWorker(bus);
      break;
    case 'direct':
      await runDirect(bus);
      break;
    default:
      throw new Error(`Unknown RUN_MODE: ${RUN_MODE}`);
  }
}

main().catch((err) => {
  logger.error('[scraper] Fatal error:', err);
  process.exit(1);
});

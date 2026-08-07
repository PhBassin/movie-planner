import { getBusProducer } from './bus-producer.js';
import { progressTracker } from './progress-tracker.js';
import { createScrapeReport, getLatestScrapeReport } from '../db/report-queries.js';
import { getTheaters } from '../db/theater-queries.js';
import type { DB } from '../db/index.js';
import { TheaterNotFoundError } from '../utils/errors.js';
import type { ScrapeAttempt } from '../db/scrape-attempt-queries.js';

export class ScraperService {
  constructor(private db: DB) {}

  /**
   * Triggers a new scrape job by enqueuing it on the bus.
   * Validates the theaterId if provided.
   */
  async triggerScrape(options: { theaterId?: string; movieId?: number } = {}) {
    const { theaterId, movieId } = options;

    // Validate theaterId exists in database if provided
    if (theaterId) {
      const theaters = await getTheaters(this.db);
      const theaterExists = theaters.some(c => c.id === theaterId);

      if (!theaterExists) {
        throw new TheaterNotFoundError(theaterId);
      }
    }

    // Reset stale events so new SSE subscribers don't receive previous session's
    // completed/failed events and immediately dismiss the progress panel.
    progressTracker.reset();

    const { reportId, queueDepth } = await this.db.transaction(async (transaction) => {
      const reportId = await createScrapeReport(transaction as typeof this.db, 'manual');
      const queueDepth = await getBusProducer().enqueueJob({
        type: 'scrape',
        reportId,
        triggerType: 'manual',
        options: {
          ...(theaterId && { theaterId }),
          ...(movieId && { movieId }),
        },
      }, transaction);
      return { reportId, queueDepth };
    });

    return { reportId, queueDepth };
  }

  /**
   * Triggers a resume job for a previous failed/rate-limited scrape.
   * Creates a new report linked to the parent and queues only pending attempts.
   */
  async triggerResume(parentReportId: number, pendingAttempts: ScrapeAttempt[]) {
    // Create new report with parent link
    // Reset stale events
    progressTracker.reset();

    // Build list of theater/date pairs to retry
    const pendingList = pendingAttempts.map(a => ({
      theater_id: a.theater_id,
      date: a.date,
    }));

    const { reportId, queueDepth } = await this.db.transaction(async (transaction) => {
      const reportId = await createScrapeReport(transaction as typeof this.db, 'manual', parentReportId);
      const queueDepth = await getBusProducer().enqueueJob({
        type: 'scrape',
        reportId,
        triggerType: 'manual',
        options: {
          resumeMode: true,
          pendingAttempts: pendingList,
        },
      }, transaction);
      return { reportId, queueDepth };
    });

    return { reportId, queueDepth };
  }

  /**
   * Retrieves the current status of the scraper based on the latest report.
   */
  async getStatus() {
    const latestReport = await getLatestScrapeReport(this.db);
    return {
      isRunning: latestReport?.status === 'running',
      latestReport,
    };
  }
}

/**
 * Common bootstrap for scraper integration/unit tests.
 *
 * Provides reusable mocks for DB, Redis, logger, and metrics
 * that appear across multiple scraper test files.
 *
 * Usage:
 *   import { bootstrapLoggerMock, bootstrapMetricsMock } from '../../tests/_helpers/bootstrap.js';
 *   vi.mock('../../src/utils/logger.js', bootstrapLoggerMock);
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------

/** Standard logger mock used by most scraper tests. */
export function bootstrapLoggerMock() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Metrics mock
// ---------------------------------------------------------------------------

/** Standard Prometheus metrics mock. */
export function bootstrapMetricsMock() {
  return {
    registry: {},
    scrapeJobsTotal: { inc: vi.fn() },
    scrapeDurationSeconds: {
      startTimer: vi.fn().mockReturnValue(vi.fn()),
    },
    moviesScrapedTotal: { inc: vi.fn() },
    showtimesScrapedTotal: { inc: vi.fn() },
  };
}

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

/** Minimal DB client mock (just `query` and `end`). */
export function bootstrapDbMock() {
  return {
    db: {
      query: vi.fn(),
      end: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Redis mock
// ---------------------------------------------------------------------------

/** Redis bus consumer mock (matches the BusConsumer port surface). */
export function bootstrapRedisMock() {
  return {
    getBusConsumer: vi
      .fn()
      .mockReturnValue({
        progressPublisher: { emit: vi.fn() },
        publishProgress: vi.fn(),
        consumeJobs: vi.fn(),
        stopConsuming: vi.fn(),
        popOneJob: vi.fn(),
        subscribeScheduleChange: vi.fn(),
        disconnect: vi.fn(),
      }),
    disconnectBus: vi.fn(),
  };
}

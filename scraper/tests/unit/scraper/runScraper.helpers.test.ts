import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DB } from '../../../src/db/client.js';
import { ScrapeSession } from '../../../src/scraper/scrape-session.js';
import type { ScrapeConfig } from '../../../src/scraper/scrape-config.js';

const DEFAULT_CONFIG: ScrapeConfig = { movieDelayMs: 0, theaterDelayMs: 0 };
const MOCK_DB = {} as DB;

function createSession(progress?: any) {
  return new ScrapeSession(MOCK_DB, DEFAULT_CONFIG, progress);
}

const mockStrategy = {
  sourceName: 'allocine',
  canHandleUrl: vi.fn().mockReturnValue(true),
  extractTheaterId: vi.fn().mockReturnValue('C0072'),
  cleanTheaterUrl: vi.fn((url: string) => url),
  loadTheaterMetadata: vi.fn(),
  scrapeTheater: vi.fn(),
};

vi.mock('../../../src/scraper/strategy-factory.js', () => ({
  getStrategyByUrl: vi.fn(() => mockStrategy),
  getStrategyBySource: vi.fn(() => mockStrategy),
}));

const mockGetTheaterConfigs = vi.fn();
const mockGetTheaters = vi.fn();
const mockCreateScrapeAttempt = vi.fn();
const mockUpdateScrapeAttempt = vi.fn();

vi.mock('../../../src/db/theater-queries.js', () => ({
  upsertTheater: vi.fn(),
  getTheaters: (...args: any[]) => mockGetTheaters(...args),
  getTheaterConfigs: (...args: any[]) => mockGetTheaterConfigs(...args),
}));

vi.mock('../../../src/db/scrape-attempt-queries.js', () => ({
  createScrapeAttempt: (...args: any[]) => mockCreateScrapeAttempt(...args),
  updateScrapeAttempt: (...args: any[]) => mockUpdateScrapeAttempt(...args),
  getPendingScrapeAttempts: vi.fn(),
  getScrapeAttemptsByReport: vi.fn(),
  getScrapeAttempt: vi.fn(),
  hasSuccessfulAttempt: vi.fn(),
}));

vi.mock('../../../src/db/movie-queries.js', () => ({
  upsertMovie: vi.fn(),
  getMovie: vi.fn(),
}));

vi.mock('../../../src/db/showtime-queries.js', () => ({
  upsertShowtimes: vi.fn(),
  upsertWeeklyPrograms: vi.fn(),
}));

vi.mock('../../../src/scraper/http-client.js', () => ({
  fetchTheaterPage: vi.fn(),
  fetchShowtimesJson: vi.fn(),
  fetchMoviePage: vi.fn(),
  delay: vi.fn().mockResolvedValue(undefined),
  closeBrowser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/client.js', () => ({
  db: {},
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/utils/date.js', () => ({
  getScrapeDates: vi.fn().mockReturnValue(['2026-03-10', '2026-03-11']),
  getWeekStartForDate: vi.fn().mockReturnValue('2026-03-09'),
}));

const THEATER_A: any = {
  id: 'C0072',
  name: 'Theater A',
  url: 'https://example.com/a',
  source: 'allocine',
};
const THEATER_B: any = {
  id: 'W7504',
  name: 'Theater B',
  url: 'https://example.com/b',
  source: 'allocine',
};

describe('prepareSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTheaterConfigs.mockResolvedValue([THEATER_A, THEATER_B]);
    mockGetTheaters.mockResolvedValue([THEATER_A, THEATER_B]);
  });

  it('returns all configured theaters when no theaterId is provided', async () => {
    const { prepareSchedule } = await import('../../../src/scraper/index.js');
    const session = createSession();

    const result = await prepareSchedule(MOCK_DB, session, {});

    expect(result.theaters).toHaveLength(2);
    expect(result.dates).toEqual(['2026-03-10', '2026-03-11']);
  });

  it('filters theaters to the requested theaterId when configured and in DB', async () => {
    const { prepareSchedule } = await import('../../../src/scraper/index.js');
    const session = createSession();

    const result = await prepareSchedule(MOCK_DB, session, { theaterId: 'C0072' });

    expect(result.theaters).toHaveLength(1);
    expect(result.theaters[0].id).toBe('C0072');
  });

  it('throws if requested theaterId is missing from the database', async () => {
    const { prepareSchedule } = await import('../../../src/scraper/index.js');
    const session = createSession();
    mockGetTheaters.mockResolvedValue([THEATER_B]);

    await expect(
      prepareSchedule(MOCK_DB, session, { theaterId: 'C0072' })
    ).rejects.toThrow(/not found in database/i);
  });

  it('throws if requested theaterId is in DB but not configured for scraping', async () => {
    const { prepareSchedule } = await import('../../../src/scraper/index.js');
    const session = createSession();
    mockGetTheaterConfigs.mockResolvedValue([THEATER_B]);

    await expect(
      prepareSchedule(MOCK_DB, session, { theaterId: 'C0072' })
    ).rejects.toThrow(/not configured for scraping/i);
  });

  it('populates session.summary.total_theaters and total_dates', async () => {
    const { prepareSchedule } = await import('../../../src/scraper/index.js');
    const session = createSession();

    await prepareSchedule(MOCK_DB, session, {});

    expect(session.summary.total_theaters).toBe(2);
    expect(session.summary.total_dates).toBe(2);
  });

  it('emits a started progress event with totals', async () => {
    const { prepareSchedule } = await import('../../../src/scraper/index.js');
    const publisher = { emit: vi.fn().mockResolvedValue(undefined) };
    const session = createSession(publisher);

    await prepareSchedule(MOCK_DB, session, {});

    expect(publisher.emit).toHaveBeenCalledWith({
      type: 'started',
      total_theaters: 2,
      total_dates: 2,
    });
  });
});

describe('scrapeTheaterWithStrategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStrategy.loadTheaterMetadata.mockResolvedValue({
      theater: THEATER_A,
      availableDates: ['2026-03-10', '2026-03-11'],
    });
    mockStrategy.scrapeTheater.mockResolvedValue({
      moviesCount: 2,
      showtimesCount: 4,
    });
    mockCreateScrapeAttempt.mockResolvedValue(99);
  });

  it('returns successfully scraped counts and the filtered datesToScrape', async () => {
    const { scrapeTheaterWithStrategy } = await import(
      '../../../src/scraper/index.js'
    );
    const session = createSession();

    const result = await scrapeTheaterWithStrategy(
      THEATER_A,
      ['2026-03-10', '2026-03-11'],
      session,
      {}
    );

    expect(result.rateLimited).toBe(false);
    expect(result.successfulDates).toBe(2);
    expect(result.moviesCount).toBe(4);
    expect(result.showtimesCount).toBe(8);
  });

  it('increments summary.failed_theaters when metadata loading fails', async () => {
    const { scrapeTheaterWithStrategy } = await import(
      '../../../src/scraper/index.js'
    );
    mockStrategy.loadTheaterMetadata.mockRejectedValueOnce(
      new Error('boom')
    );
    const session = createSession();

    const result = await scrapeTheaterWithStrategy(
      THEATER_A,
      ['2026-03-10'],
      session,
      {}
    );

    expect(result.rateLimited).toBe(false);
    expect(session.summary.failed_theaters).toBe(1);
    expect(session.summary.errors).toHaveLength(1);
    expect(session.summary.errors[0].error).toBe('boom');
  });

  it('increments summary.successful_theaters and total_movies on full success', async () => {
    const { scrapeTheaterWithStrategy } = await import(
      '../../../src/scraper/index.js'
    );
    const session = createSession();

    await scrapeTheaterWithStrategy(
      THEATER_A,
      ['2026-03-10', '2026-03-11'],
      session,
      {}
    );

    expect(session.summary.successful_theaters).toBe(1);
    expect(session.summary.total_movies).toBe(4);
    expect(session.summary.total_showtimes).toBe(8);
  });

  it('marks the theater as failed when every date fails non-rate-limit', async () => {
    const { scrapeTheaterWithStrategy } = await import(
      '../../../src/scraper/index.js'
    );
    mockStrategy.scrapeTheater.mockRejectedValue(new Error('network'));
    const session = createSession();

    await scrapeTheaterWithStrategy(
      THEATER_A,
      ['2026-03-10', '2026-03-11'],
      session,
      {}
    );

    expect(session.summary.failed_theaters).toBe(1);
    expect(session.summary.successful_theaters).toBe(0);
    expect(session.summary.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('returns rateLimited=true and sets summary.status on RateLimitError', async () => {
    const { RateLimitError } = await import('../../../src/utils/errors.js');
    const { scrapeTheaterWithStrategy } = await import(
      '../../../src/scraper/index.js'
    );
    mockStrategy.scrapeTheater.mockRejectedValueOnce(
      new RateLimitError('rate limit', 429, 'https://example.com')
    );
    const session = createSession();

    const result = await scrapeTheaterWithStrategy(
      THEATER_A,
      ['2026-03-10', '2026-03-11'],
      session,
      {}
    );

    expect(result.rateLimited).toBe(true);
    expect(session.summary.status).toBe('rate_limited');
  });

  it('on rate limit with reportId, cascades not_attempted to remaining theaters', async () => {
    const { RateLimitError } = await import('../../../src/utils/errors.js');
    const { scrapeTheaterWithStrategy } = await import(
      '../../../src/scraper/index.js'
    );

    mockStrategy.scrapeTheater.mockRejectedValueOnce(
      new RateLimitError('rate limit', 429, 'https://example.com')
    );

    const session = createSession();

    const THEATER_B_CASCADE = {
      id: 'C0099',
      name: 'Theater B',
      url: 'https://example.com/b',
      source: 'allocine',
    };

    const result = await scrapeTheaterWithStrategy(
      THEATER_A,
      ['2026-03-10', '2026-03-11'],
      session,
      { reportId: 42 },
      {
        allTheaters: [THEATER_A, THEATER_B_CASCADE],
        theaterIndex: 0,
        datesToScrape: ['2026-03-10', '2026-03-11'],
      }
    );

    expect(result.rateLimited).toBe(true);

    expect(mockCreateScrapeAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        theater_id: 'C0072',
        date: '2026-03-11',
        status: 'not_attempted',
      })
    );
    expect(mockCreateScrapeAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        theater_id: 'C0099',
        date: '2026-03-10',
        status: 'not_attempted',
      })
    );
    expect(mockCreateScrapeAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        theater_id: 'C0099',
        date: '2026-03-11',
        status: 'not_attempted',
      })
    );
  });

  it('filters datesToScrape to availableDates and logs skipped dates', async () => {
    const { scrapeTheaterWithStrategy } = await import(
      '../../../src/scraper/index.js'
    );
    mockStrategy.loadTheaterMetadata.mockResolvedValueOnce({
      theater: THEATER_A,
      availableDates: ['2026-03-10'],
    });
    const session = createSession();

    const result = await scrapeTheaterWithStrategy(
      THEATER_A,
      ['2026-03-10', '2026-03-11'],
      session,
      {}
    );

    expect(result.successfulDates).toBe(1);
    expect(mockStrategy.scrapeTheater).toHaveBeenCalledTimes(1);
  });

  it('in resume mode, restricts datesToScrape to pendingAttempts for that theater', async () => {
    const { scrapeTheaterWithStrategy } = await import(
      '../../../src/scraper/index.js'
    );
    const session = createSession();

    await scrapeTheaterWithStrategy(
      THEATER_A,
      ['2026-03-10', '2026-03-11'],
      session,
      {
        resumeMode: true,
        pendingAttempts: [{ theater_id: 'C0072', date: '2026-03-10' }],
      }
    );

    expect(mockStrategy.scrapeTheater).toHaveBeenCalledTimes(1);
  });

  it('emits theater_completed after a successful theater with correct movie count', async () => {
    const { scrapeTheaterWithStrategy } = await import(
      '../../../src/scraper/index.js'
    );
    const publisher = { emit: vi.fn().mockResolvedValue(undefined) };
    const session = createSession(publisher);

    await scrapeTheaterWithStrategy(
      THEATER_A,
      ['2026-03-10', '2026-03-11'],
      session,
      {}
    );

    expect(publisher.emit).toHaveBeenCalledWith({
      type: 'theater_completed',
      theater_name: 'Theater A',
      total_movies: 4,
    });
  });

  it('does not emit theater_completed when every date fails', async () => {
    const { scrapeTheaterWithStrategy } = await import(
      '../../../src/scraper/index.js'
    );
    mockStrategy.scrapeTheater.mockRejectedValue(new Error('boom'));
    const publisher = { emit: vi.fn().mockResolvedValue(undefined) };
    const session = createSession(publisher);

    await scrapeTheaterWithStrategy(
      THEATER_A,
      ['2026-03-10', '2026-03-11'],
      session,
      {}
    );

    const theaterCompletedCalls = publisher.emit.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'theater_completed'
    );
    expect(theaterCompletedCalls).toHaveLength(0);
  });
});

describe('loadTheaterAvailability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the available dates from the strategy on success', async () => {
    const { loadTheaterAvailability } = await import(
      '../../../src/scraper/index.js'
    );
    mockStrategy.loadTheaterMetadata.mockResolvedValue({
      theater: THEATER_A,
      availableDates: ['2026-03-10', '2026-03-12'],
    });
    const session = createSession();

    const result = await loadTheaterAvailability(MOCK_DB, session, THEATER_A);

    expect(result.failed).toBe(false);
    expect(result.availableDates).toEqual(['2026-03-10', '2026-03-12']);
    expect(session.summary.failed_theaters).toBe(0);
  });

  it('records the error, increments failed_theaters, and signals failure on metadata load error', async () => {
    const { loadTheaterAvailability } = await import(
      '../../../src/scraper/index.js'
    );
    mockStrategy.loadTheaterMetadata.mockRejectedValueOnce(
      new Error('network down')
    );
    const session = createSession();

    const result = await loadTheaterAvailability(MOCK_DB, session, THEATER_A);

    expect(result.failed).toBe(true);
    expect(result.availableDates).toEqual([]);
    expect(session.summary.failed_theaters).toBe(1);
    expect(session.summary.errors).toHaveLength(1);
    expect(session.summary.errors[0]).toMatchObject({
      theater_id: 'C0072',
      error: 'network down',
    });
  });
});

describe('filterDatesForScrape', () => {
  it('returns the intersection of requested and available dates', async () => {
    const { filterDatesForScrape } = await import(
      '../../../src/scraper/index.js'
    );

    const result = filterDatesForScrape(THEATER_A, ['2026-03-10', '2026-03-11', '2026-03-12'], ['2026-03-10', '2026-03-12'], {});

    expect(result.datesToScrape).toEqual(['2026-03-10', '2026-03-12']);
    expect(result.finalDatesToScrape).toEqual(['2026-03-10', '2026-03-12']);
    expect(result.skippedDates).toEqual(['2026-03-11']);
  });

  it('further filters to pendingAttempts in resumeMode', async () => {
    const { filterDatesForScrape } = await import(
      '../../../src/scraper/index.js'
    );

    const result = filterDatesForScrape(
      THEATER_A,
      ['2026-03-10', '2026-03-11'],
      ['2026-03-10', '2026-03-11'],
      {
        resumeMode: true,
        pendingAttempts: [{ theater_id: 'C0072', date: '2026-03-10' }],
      }
    );

    expect(result.datesToScrape).toEqual(['2026-03-10', '2026-03-11']);
    expect(result.finalDatesToScrape).toEqual(['2026-03-10']);
  });
});

describe('processOneDate', () => {
  it('returns "success" with counts on a clean scrape', async () => {
    const { processOneDate } = await import('../../../src/scraper/index.js');
    mockStrategy.scrapeTheater.mockResolvedValueOnce({
      moviesCount: 3,
      showtimesCount: 7,
    });
    const session = createSession();

    const result = await processOneDate(
      session,
      THEATER_A,
      '2026-03-10',
      ['2026-03-10'],
      {}
    );

    expect(result.status).toBe('success');
    expect(result.moviesCount).toBe(3);
    expect(result.showtimesCount).toBe(7);
  });

  it('returns "error" on a non-rate-limit failure and pushes the error to summary', async () => {
    const { processOneDate } = await import('../../../src/scraper/index.js');
    mockStrategy.scrapeTheater.mockRejectedValueOnce(new Error('HTTP 500'));
    const session = createSession();

    const result = await processOneDate(
      session,
      THEATER_A,
      '2026-03-10',
      ['2026-03-10'],
      {}
    );

    expect(result.status).toBe('error');
    expect(session.summary.errors).toHaveLength(1);
    expect(session.summary.errors[0]).toMatchObject({
      theater_id: 'C0072',
      date: '2026-03-10',
      error: 'HTTP 500',
    });
  });

  it('returns "rate_limited" on a RateLimitError and sets summary.status', async () => {
    const { RateLimitError } = await import('../../../src/utils/errors.js');
    const { processOneDate } = await import('../../../src/scraper/index.js');
    mockStrategy.scrapeTheater.mockRejectedValueOnce(
      new RateLimitError('429', 429, 'https://example.com')
    );
    const session = createSession();

    const result = await processOneDate(
      session,
      THEATER_A,
      '2026-03-10',
      ['2026-03-10'],
      { reportId: 7 }
    );

    expect(result.status).toBe('rate_limited');
    expect(session.summary.status).toBe('rate_limited');
    expect(session.summary.errors[0]).toMatchObject({
      theater_id: 'C0072',
      error_type: 'http_429',
    });
  });

  it('on rate limit with reportId and cascade, marks remaining theater dates as not_attempted', async () => {
    const { RateLimitError } = await import('../../../src/utils/errors.js');
    const { processOneDate } = await import('../../../src/scraper/index.js');
    mockStrategy.scrapeTheater.mockRejectedValueOnce(
      new RateLimitError('429', 429, 'https://example.com')
    );
    const session = createSession();

    const result = await processOneDate(
      session,
      THEATER_A,
      '2026-03-10',
      ['2026-03-10', '2026-03-11'],
      { reportId: 42 },
      {
        allTheaters: [THEATER_A, THEATER_B],
        theaterIndex: 0,
        datesToScrape: ['2026-03-10', '2026-03-11'],
      }
    );

    expect(result.status).toBe('rate_limited');

    expect(mockCreateScrapeAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        theater_id: 'C0072',
        date: '2026-03-11',
        status: 'not_attempted',
      })
    );
    expect(mockCreateScrapeAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        theater_id: 'W7504',
        date: '2026-03-10',
        status: 'not_attempted',
      })
    );
  });

  it('on non-rate-limit error with reportId, updates the attempt as failed', async () => {
    const { processOneDate } = await import('../../../src/scraper/index.js');
    mockStrategy.scrapeTheater.mockRejectedValueOnce(new Error('HTTP 500'));
    const session = createSession();
    mockUpdateScrapeAttempt.mockClear();

    const result = await processOneDate(
      session,
      THEATER_A,
      '2026-03-10',
      ['2026-03-10'],
      { reportId: 7 }
    );

    expect(result.status).toBe('error');
    expect(mockUpdateScrapeAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      expect.objectContaining({ status: 'failed' })
    );
  });

  it('still returns "error" when attemptId is not set (no update call)', async () => {
    const { processOneDate } = await import('../../../src/scraper/index.js');
    mockStrategy.scrapeTheater.mockRejectedValueOnce(new Error('boom'));
    const session = createSession();
    mockUpdateScrapeAttempt.mockClear();
    mockCreateScrapeAttempt.mockRejectedValue(new Error('db down'));

    const result = await processOneDate(
      session,
      THEATER_A,
      '2026-03-10',
      ['2026-03-10'],
      {}
    );

    expect(result.status).toBe('error');
    expect(session.summary.errors[0].error).toBe('boom');
  });

  it('does not call updateScrapeAttempt when rate_limited with no attemptId', async () => {
    const { RateLimitError } = await import('../../../src/utils/errors.js');
    const { processOneDate } = await import('../../../src/scraper/index.js');
    mockStrategy.scrapeTheater.mockRejectedValueOnce(
      new RateLimitError('429', 429, 'https://example.com')
    );
    mockCreateScrapeAttempt.mockRejectedValue(new Error('db down'));
    const session = createSession();
    mockUpdateScrapeAttempt.mockClear();

    const result = await processOneDate(
      session,
      THEATER_A,
      '2026-03-10',
      ['2026-03-10'],
      {}
    );

    expect(result.status).toBe('rate_limited');
    expect(mockUpdateScrapeAttempt).not.toHaveBeenCalled();
  });
});

describe('ScrapeSession', () => {
  it('recordError pushes entries to summary.errors', () => {
    const session = createSession();

    session.recordError({
      theater_name: 'Test',
      theater_id: 'T001',
      error: 'test error',
      error_type: 'network',
    });

    expect(session.summary.errors).toHaveLength(1);
    expect(session.summary.errors[0].error).toBe('test error');
  });

  it('incrementSuccessfulTheater bumps counts', () => {
    const session = createSession();

    session.incrementSuccessfulTheater(5, 10);

    expect(session.summary.successful_theaters).toBe(1);
    expect(session.summary.total_movies).toBe(5);
    expect(session.summary.total_showtimes).toBe(10);
  });

  it('incrementFailedTheater increments failed counter', () => {
    const session = createSession();

    session.incrementFailedTheater();

    expect(session.summary.failed_theaters).toBe(1);
  });

  it('markRateLimited sets status', () => {
    const session = createSession();

    session.markRateLimited();

    expect(session.summary.status).toBe('rate_limited');
  });

  it('setTotals sets theater and date counts', () => {
    const session = createSession();

    session.setTotals(5, 30);

    expect(session.summary.total_theaters).toBe(5);
    expect(session.summary.total_dates).toBe(30);
  });

  it('setDuration stamps duration_ms', () => {
    const session = createSession();

    session.setDuration(4200);

    expect(session.summary.duration_ms).toBe(4200);
  });

  it('recordSystemError pushes a system-level error', () => {
    const session = createSession();

    session.recordSystemError('fatal error', 'parse');

    expect(session.summary.errors).toHaveLength(1);
    expect(session.summary.errors[0]).toMatchObject({
      theater_name: 'System',
      theater_id: 'system',
      error: 'fatal error',
      error_type: 'parse',
    });
  });

  it('emit delegates to the progress publisher', async () => {
    const publisher = { emit: vi.fn().mockResolvedValue(undefined) };
    const session = createSession(publisher);

    await session.emit({ type: 'started', total_theaters: 1, total_dates: 7 } as any);

    expect(publisher.emit).toHaveBeenCalledWith({
      type: 'started',
      total_theaters: 1,
      total_dates: 7,
    });
  });

  it('emit is a no-op when no progress publisher is set', async () => {
    const session = createSession();

    await expect(session.emit({ type: 'started', total_theaters: 1, total_dates: 1 } as any)).resolves.toBeUndefined();
  });

  it('config is exposed from the session', () => {
    const session = createSession();

    expect(session.config).toEqual(DEFAULT_CONFIG);
    expect(session.config.movieDelayMs).toBe(0);
    expect(session.config.theaterDelayMs).toBe(0);
  });

  it('summary is initialized with zero counts and an empty errors array', () => {
    const session = createSession();

    expect(session.summary.total_theaters).toBe(0);
    expect(session.summary.successful_theaters).toBe(0);
    expect(session.summary.failed_theaters).toBe(0);
    expect(session.summary.total_movies).toBe(0);
    expect(session.summary.total_showtimes).toBe(0);
    expect(session.summary.total_dates).toBe(0);
    expect(session.summary.duration_ms).toBe(0);
    expect(session.summary.errors).toEqual([]);
  });
});

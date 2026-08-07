import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks (must be declared before any imports of the module under test) ---

const mockRunScraper = vi.fn();
const mockAddTheaterAndScrape = vi.fn();
const mockUpdateScrapeReport = vi.fn().mockResolvedValue(undefined);
const mockCreateScrapeReport = vi.fn().mockResolvedValue(1);
const mockGetEnabledSchedules = vi.fn().mockResolvedValue([]);
const mockUpdateScheduleRunStatus = vi.fn().mockResolvedValue(undefined);
const mockEmit = vi.fn();
const mockScrapeJobsTotal = { inc: vi.fn() };
const mockScrapeDurationSeconds = { startTimer: vi.fn().mockReturnValue(vi.fn()) };
const mockMoviesScrapedTotal = { inc: vi.fn() };
const mockShowtimesScrapedTotal = { inc: vi.fn() };

// CronScheduler.start() subscribes via the bus and registers cron tasks.
// node-cron is mocked so no real timers are scheduled.
const mockCronTask = { stop: vi.fn(), start: vi.fn(), now: vi.fn() };
vi.mock('node-cron', () => ({
  default: { validate: () => true, schedule: () => mockCronTask },
}));

vi.mock('../../src/scraper/index.js', () => ({
  runScraper: mockRunScraper,
  addTheaterAndScrape: mockAddTheaterAndScrape,
}));

vi.mock('../../src/db/report-queries.js', () => ({
  createScrapeReport: (...args: any[]) => mockCreateScrapeReport(...args),
  updateScrapeReport: (...args: any[]) => mockUpdateScrapeReport(...args),
}));

vi.mock('../../src/db/schedule-queries.js', () => ({
  getEnabledSchedules: (...args: any[]) => mockGetEnabledSchedules(...args),
  updateScheduleRunStatus: (...args: any[]) => mockUpdateScheduleRunStatus(...args),
}));

const mockBus = {
  progressPublisher: { emit: mockEmit },
  publishProgress: mockEmit,
  consumeJobs: vi.fn(),
  stopConsuming: vi.fn(),
  popOneJob: vi.fn(),
  subscribeScheduleChange: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock('../../src/redis/client.js', () => ({
  getBusConsumer: vi.fn().mockReturnValue(mockBus),
  disconnectBus: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: { end: vi.fn() },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/utils/metrics.js', () => ({
  registry: {},
  scrapeJobsTotal: mockScrapeJobsTotal,
  scrapeDurationSeconds: mockScrapeDurationSeconds,
  moviesScrapedTotal: mockMoviesScrapedTotal,
  showtimesScrapedTotal: mockShowtimesScrapedTotal,
}));

const mockProgress = { emit: mockEmit };

const okSummary = {
  failed_theaters: 0,
  successful_theaters: 1,
  total_theaters: 1,
  total_movies: 5,
  total_showtimes: 20,
  errors: [],
};

describe('executeJob dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScrapeDurationSeconds.startTimer.mockReturnValue(vi.fn());
  });

  it('should dispatch scrape jobs to runScraper', async () => {
    mockRunScraper.mockResolvedValue({
      failed_theaters: 0,
      successful_theaters: 1,
      total_theaters: 1,
      total_movies: 5,
      total_showtimes: 20,
      errors: [],
    });

    // Dynamically import to pick up mocks
    const { executeJob } = await import('../../src/index.js');

    await executeJob({
      type: 'scrape',
      triggerType: 'manual',
      reportId: 42,
      options: { mode: 'from_today_limited' },
    }, mockProgress);

    expect(mockRunScraper).toHaveBeenCalledOnce();
    expect(mockAddTheaterAndScrape).not.toHaveBeenCalled();
  });

  it('should dispatch add_theater jobs to addTheaterAndScrape', async () => {
    mockAddTheaterAndScrape.mockResolvedValue({
      id: 'C0072',
      name: 'Theater Test',
      url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0072.html',
    });

    const { executeJob } = await import('../../src/index.js');

    await executeJob({
      type: 'add_theater',
      triggerType: 'manual',
      reportId: 43,
      url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0072.html',
    }, mockProgress);

    expect(mockAddTheaterAndScrape).toHaveBeenCalledOnce();
    expect(mockRunScraper).not.toHaveBeenCalled();
  });

  it('should handle legacy jobs without type field as scrape', async () => {
    mockRunScraper.mockResolvedValue({
      failed_theaters: 0,
      successful_theaters: 1,
      total_theaters: 1,
      total_movies: 3,
      total_showtimes: 10,
      errors: [],
    });

    const { executeJob } = await import('../../src/index.js');

    // Cast as any to simulate legacy job without 'type' field
    await executeJob({
      triggerType: 'cron',
      reportId: 44,
    } as any, mockProgress);

    expect(mockRunScraper).toHaveBeenCalledOnce();
    expect(mockAddTheaterAndScrape).not.toHaveBeenCalled();
  });

  it('should reject add_theater jobs and update report to failed on error', async () => {
    mockAddTheaterAndScrape.mockRejectedValue(new Error('Invalid Allociné URL: bad-url'));

    const { executeJob } = await import('../../src/index.js');

    // Should not throw — errors are caught and reported
    await expect(executeJob({
      type: 'add_theater',
      triggerType: 'manual',
      reportId: 45,
      url: 'bad-url',
    }, mockProgress)).resolves.toBeUndefined();

    // Should have updated report to failed
    expect(mockUpdateScrapeReport).toHaveBeenCalledWith(
      expect.anything(),
      45,
      expect.objectContaining({ status: 'failed' })
    );
  });
});

describe('runScheduledScrape (cron executor)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScrapeDurationSeconds.startTimer.mockReturnValue(vi.fn());
    vi.stubEnv('ENABLE_SCRAPE_CRON', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips the scrape when ENABLE_SCRAPE_CRON is not true', async () => {
    vi.stubEnv('ENABLE_SCRAPE_CRON', 'false');

    const { runScheduledScrape } = await import('../../src/index.js');

    await runScheduledScrape(mockBus as any, { id: 1, name: 'Weekly', cronExpression: '0 8 * * 3' });

    expect(mockCreateScrapeReport).not.toHaveBeenCalled();
    expect(mockRunScraper).not.toHaveBeenCalled();
  });

  it('creates a cron report, runs the scrape, and records success on the schedule', async () => {
    mockRunScraper.mockResolvedValue(okSummary);

    const { runScheduledScrape } = await import('../../src/index.js');

    await runScheduledScrape(mockBus as any, { id: 7, name: 'Weekly', cronExpression: '0 8 * * 3' });

    expect(mockCreateScrapeReport).toHaveBeenCalledWith(expect.anything(), 'cron');
    expect(mockRunScraper).toHaveBeenCalledOnce();
    expect(mockUpdateScrapeReport).toHaveBeenCalledWith(
      expect.anything(),
      1,
      expect.objectContaining({ status: 'success', total_movies_scraped: 5 })
    );
    expect(mockUpdateScheduleRunStatus).toHaveBeenCalledWith(expect.anything(), 7, 'success');
  });

  it('records failed status on the report and schedule when the scrape throws', async () => {
    mockRunScraper.mockRejectedValue(new Error('boom'));

    const { runScheduledScrape } = await import('../../src/index.js');

    await runScheduledScrape(mockBus as any, { id: 8, name: 'Daily', cronExpression: '0 8 * * *' });

    expect(mockUpdateScrapeReport).toHaveBeenCalledWith(
      expect.anything(),
      1,
      expect.objectContaining({ status: 'failed' })
    );
    expect(mockUpdateScheduleRunStatus).toHaveBeenCalledWith(expect.anything(), 8, 'failed');
  });

  it('aborts cleanly when the scrape report cannot be created', async () => {
    mockCreateScrapeReport.mockRejectedValue(new Error('db down'));

    const { runScheduledScrape } = await import('../../src/index.js');

    await runScheduledScrape(mockBus as any, { id: 9, name: 'Daily', cronExpression: '0 8 * * *' });

    expect(mockRunScraper).not.toHaveBeenCalled();
    expect(mockUpdateScheduleRunStatus).not.toHaveBeenCalled();
  });
});

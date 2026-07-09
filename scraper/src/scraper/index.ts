import { db, type DB } from '../db/client.js';
import { logger } from '../utils/logger.js';
import {
  getTheaterConfigs,
  getTheaters,
} from '../db/theater-queries.js';
import { closeBrowser, delay } from './http-client.js';
import { getScrapeDates, type ScrapeMode } from '../utils/date.js';
import type { TheaterConfig, Theater, ProgressEvent, ScrapeSummary } from '../types/scraper.js';
import { getStrategyByUrl, getStrategyBySource } from './strategy-factory.js';
import { RateLimitError } from '../utils/errors.js';
import { classifyError } from '../utils/error-classifier.js';
import {
  createScrapeAttempt,
  updateScrapeAttempt,
} from '../db/scrape-attempt-queries.js';

import { ScrapeSession, type ProgressPublisher } from './scrape-session.js';
import { createScrapeConfig, type ScrapeConfig } from './scrape-config.js';

export type { ProgressPublisher } from './scrape-session.js';

export interface PrepareScheduleResult {
  theaters: TheaterConfig[];
  dates: string[];
  scrapeMode: ScrapeMode;
  scrapeDays: number;
}

interface ScrapeTheaterResult {
  rateLimited: boolean;
  datesToScrape: string[];
  successfulDates: number;
  moviesCount: number;
  showtimesCount: number;
}

export { ScrapeSession, createScrapeConfig };
export type { ScrapeConfig };

export async function loadTheaterMetadata(
  db: DB,
  theater: TheaterConfig
): Promise<{ availableDates: string[]; theater: Theater }> {
  const strategy = getStrategyBySource(theater.source || 'allocine');
  return strategy.loadTheaterMetadata(db, theater);
}

async function scrapeTheater(
  db: DB,
  theater: TheaterConfig,
  date: string,
  movieDelayMs: number,
  progress?: ProgressPublisher
): Promise<{ moviesCount: number; showtimesCount: number }> {
  const strategy = getStrategyBySource(theater.source || 'allocine');
  return strategy.scrapeTheater(db, theater, date, movieDelayMs, progress);
}

export async function addTheaterAndScrape(
  db: DB,
  url: string,
  progress?: ProgressPublisher
): Promise<Theater> {
  const strategy = getStrategyByUrl(url);
  
  const theaterId = strategy.extractTheaterId(url);
  if (!theaterId) {
    throw new Error(`Could not extract theater ID from URL: ${url}`);
  }

  const cleanedUrl = strategy.cleanTheaterUrl(url);
  const tempConfig: TheaterConfig = { 
    id: theaterId, 
    name: theaterId, 
    url: cleanedUrl,
    source: strategy.sourceName 
  };

  const config = createScrapeConfig();
  logger.info(`Adding new theater from ${url} using ${strategy.sourceName} strategy...`);
  const { availableDates, theater } = await strategy.loadTheaterMetadata(db, tempConfig);

  logger.info(`Scraping ${availableDates.length} available date(s)...`, { theater: theater.name });

  for (const date of availableDates) {
    try {
      await strategy.scrapeTheater(db, tempConfig, date, config.movieDelayMs, progress);
    } catch (error) {
      logger.error('Failed to scrape date', { date, theater: theater.name, error });
    }
  }

  await closeBrowser();
  logger.info('Theater added successfully', { theater: theater.name, id: theater.id });

  return theater;
}

export interface ScrapeOptions {
  mode?: ScrapeMode;
  days?: number;
  theaterId?: string;
  movieId?: number;
  reportId?: number;
  resumeMode?: boolean;
  pendingAttempts?: Array<{ theater_id: string; date: string }>;
}

export async function prepareSchedule(
  db: DB,
  session: ScrapeSession,
  options?: ScrapeOptions
): Promise<PrepareScheduleResult> {
  let theaters = await getTheaterConfigs(db);

  if (options?.theaterId) {
    const allTheatersFromDb = await getTheaters(db);
    const theaterExistsInDb = allTheatersFromDb.some(
      (c: Theater) => c.id === options.theaterId
    );

    if (!theaterExistsInDb) {
      throw new Error(`Theater not found in database: ${options.theaterId}`);
    }

    const foundTheater = theaters.find(c => c.id === options.theaterId);
    if (!foundTheater) {
      throw new Error(`Theater not configured for scraping: ${options.theaterId}`);
    }

    theaters = [foundTheater];
    logger.info(`Scraping only theater: ${foundTheater.name} (${foundTheater.id})`);
  }

  logger.info('Theaters loaded', { count: theaters.length });

  const scrapeMode =
    options?.mode ?? session.config.scrapeMode;
  const scrapeDays = options?.days || session.config.scrapeDays;
  const dates = getScrapeDates(scrapeMode, scrapeDays);

  logger.info('Scrape config', { mode: scrapeMode, dates: dates.length, scrapeDays });
  logger.info('Delay config', {
    theaterDelayMs: session.config.theaterDelayMs,
    movieDelayMs: session.config.movieDelayMs,
  });

  session.setTotals(theaters.length, dates.length);

  await session.emit({
    type: 'started',
    total_theaters: theaters.length,
    total_dates: dates.length,
  });

  return { theaters, dates, scrapeMode, scrapeDays };
}

async function markNotAttempted(
  db: DB,
  reportId: number,
  theaterId: string,
  date: string
): Promise<void> {
  try {
    await createScrapeAttempt(db, {
      report_id: reportId,
      theater_id: theaterId,
      date,
      status: 'not_attempted',
    });
  } catch (error) {
    logger.error('Failed to mark attempt as not_attempted', { error });
  }
}

export async function scrapeTheaterWithStrategy(
  theater: TheaterConfig,
  dates: string[],
  session: ScrapeSession,
  options?: ScrapeOptions,
  cascade?: {
    allTheaters: TheaterConfig[];
    theaterIndex: number;
    datesToScrape: string[];
  }
): Promise<ScrapeTheaterResult> {
  const strategy = getStrategyBySource(theater.source || 'allocine');

  let theaterMoviesCount = 0;
  let theaterShowtimesCount = 0;
  let successfulDates = 0;
  let rateLimited = false;

  const { availableDates, failed } = await loadTheaterAvailability(session.db, session, theater);
  if (failed) {
    return {
      rateLimited: false,
      datesToScrape: [],
      successfulDates: 0,
      moviesCount: 0,
      showtimesCount: 0,
    };
  }

  const { datesToScrape, finalDatesToScrape } = filterDatesForScrape(
    theater,
    dates,
    availableDates,
    options ?? {}
  );

  for (const date of finalDatesToScrape) {
    logger.info('Attempting date', { theater: theater.name, date });
    const outcome = await processOneDate(
      session,
      theater,
      date,
      finalDatesToScrape,
      options,
      cascade
    );
    if (outcome.status === 'success') {
      theaterMoviesCount += outcome.moviesCount ?? 0;
      theaterShowtimesCount += outcome.showtimesCount ?? 0;
      successfulDates++;
    } else if (outcome.status === 'rate_limited') {
      rateLimited = true;
      break;
    }
  }

  await summarizeTheater(session, theater, {
    successfulDates,
    totalDates: finalDatesToScrape.length,
    moviesCount: theaterMoviesCount,
    showtimesCount: theaterShowtimesCount,
  });

  return {
    rateLimited,
    datesToScrape,
    successfulDates,
    moviesCount: theaterMoviesCount,
    showtimesCount: theaterShowtimesCount,
  };
}

export async function processOneDate(
  session: ScrapeSession,
  theater: TheaterConfig,
  date: string,
  finalDatesToScrape: string[],
  options?: ScrapeOptions,
  cascade?: {
    allTheaters: TheaterConfig[];
    theaterIndex: number;
    datesToScrape: string[];
  }
): Promise<
  | { status: 'success'; moviesCount: number; showtimesCount: number }
  | { status: 'rate_limited' }
  | { status: 'error' }
> {
  const strategy = getStrategyBySource(theater.source || 'allocine');
  const db = session.db;

  let attemptId: number | undefined;
  if (options?.reportId) {
    try {
      attemptId = await createScrapeAttempt(db, {
        report_id: options.reportId,
        theater_id: theater.id,
        date,
        status: 'pending',
      });
    } catch (error) {
      logger.error('Failed to create scrape attempt', { error });
    }
  }

  try {
    const { moviesCount, showtimesCount } = await strategy.scrapeTheater(
      db,
      theater,
      date,
      session.config.movieDelayMs,
      { emit: (event: ProgressEvent) => session.emit(event) }
    );
    logger.info('Date scraped successfully', { date, movies: moviesCount, showtimes: showtimesCount });
    if (attemptId) {
      try {
        await updateScrapeAttempt(db, attemptId, {
          status: 'success',
          movies_scraped: moviesCount,
          showtimes_scraped: showtimesCount,
        });
      } catch (error) {
        logger.error('Failed to update scrape attempt', { error });
      }
    }
    return { status: 'success', moviesCount, showtimesCount };
  } catch (error) {
    if (error instanceof RateLimitError) {
      return await handleRateLimit({
        session,
        theater,
        date,
        finalDatesToScrape,
        options,
        cascade,
        error,
        attemptId,
      });
    }
    return await handleDateFailure({
      session,
      theater,
      date,
      error,
      attemptId,
    });
  }
}

async function handleRateLimit(args: {
  session: ScrapeSession;
  theater: TheaterConfig;
  date: string;
  finalDatesToScrape: string[];
  options?: ScrapeOptions;
  cascade?: {
    allTheaters: TheaterConfig[];
    theaterIndex: number;
    datesToScrape: string[];
  };
  error: RateLimitError;
  attemptId: number | undefined;
}): Promise<{ status: 'rate_limited' }> {
  const { session, theater, date, finalDatesToScrape, options, cascade, error, attemptId } = args;

  logger.error('Rate limit detected - stopping all scraping', {
    theater: theater.name,
    date,
    statusCode: error.statusCode,
  });

  const errorType = classifyError(error);
  session.recordError({
    theater_name: theater.name,
    theater_id: theater.id,
    date,
    error: error.message,
    error_type: errorType,
    http_status_code: error.statusCode,
  });

  if (attemptId) {
    try {
      await updateScrapeAttempt(session.db, attemptId, {
        status: 'rate_limited',
        error_type: errorType,
        error_message: error.message,
        http_status_code: error.statusCode,
      });
    } catch (updateError) {
      logger.error('Failed to update scrape attempt', { error: updateError });
    }
  }

  if (options?.reportId) {
    const remainingDates = finalDatesToScrape.slice(finalDatesToScrape.indexOf(date) + 1);
    for (const remainingDate of remainingDates) {
      await markNotAttempted(session.db, options.reportId, theater.id, remainingDate);
    }
  }

  if (options?.reportId && cascade) {
    const remainingTheaters = cascade.allTheaters.slice(cascade.theaterIndex + 1);
    for (const remainingTheater of remainingTheaters) {
      for (const futureDate of cascade.datesToScrape) {
        await markNotAttempted(
          session.db,
          options.reportId,
          remainingTheater.id,
          futureDate
        );
      }
    }
  }

  await session.emit({
    type: 'date_failed',
    theater_name: theater.name,
    date,
    error: error.message,
  });

  session.markRateLimited();
  return { status: 'rate_limited' };
}

async function handleDateFailure(args: {
  session: ScrapeSession;
  theater: TheaterConfig;
  date: string;
  error: unknown;
  attemptId: number | undefined;
}): Promise<{ status: 'error' }> {
  const { session, theater, date, error, attemptId } = args;

  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorType = classifyError(error);
  logger.error('Date scrape failed', { theater: theater.name, date, error: errorMessage });

  session.recordError({
    theater_name: theater.name,
    theater_id: theater.id,
    date,
    error: errorMessage,
    error_type: errorType,
    http_status_code: (error as any).statusCode,
  });

  if (attemptId) {
    try {
      await updateScrapeAttempt(session.db, attemptId, {
        status: 'failed',
        error_type: errorType,
        error_message: errorMessage,
        http_status_code: (error as any).statusCode,
      });
    } catch (updateError) {
      logger.error('Failed to update scrape attempt', { error: updateError });
    }
  }

  await session.emit({
    type: 'date_failed',
    theater_name: theater.name,
    date,
    error: errorMessage,
  });

  return { status: 'error' };
}

export async function loadTheaterAvailability(
  db: DB,
  session: ScrapeSession,
  theater: TheaterConfig
): Promise<{ availableDates: string[]; failed: boolean }> {
  const strategy = getStrategyBySource(theater.source || 'allocine');
  try {
    const meta = await strategy.loadTheaterMetadata(db, theater);
    return { availableDates: meta.availableDates, failed: false };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorType = classifyError(error);
    logger.error('Failed to load theater metadata', {
      theater: theater.name,
      error: errorMessage,
    });
    session.recordError({
      theater_name: theater.name,
      theater_id: theater.id,
      error: errorMessage,
      error_type: errorType,
      http_status_code: (error as any).statusCode,
    });
    session.incrementFailedTheater();
    return { availableDates: [], failed: true };
  }
}

export function filterDatesForScrape(
  theater: TheaterConfig,
  dates: string[],
  availableDates: string[],
  options: ScrapeOptions
): { datesToScrape: string[]; finalDatesToScrape: string[]; skippedDates: string[] } {
  const datesToScrape = dates.filter(d => availableDates.includes(d));
  const skippedDates = dates.filter(d => !availableDates.includes(d));
  if (skippedDates.length > 0) {
    logger.info('Skipping dates not yet published', {
      count: skippedDates.length,
      dates: skippedDates,
    });
  }

  let finalDatesToScrape = datesToScrape;
  if (options.resumeMode && options.pendingAttempts) {
    const pendingDatesForTheater = options.pendingAttempts
      .filter(a => a.theater_id === theater.id)
      .map(a => a.date);
    finalDatesToScrape = datesToScrape.filter(d => pendingDatesForTheater.includes(d));
    logger.info('Resume mode: filtered to pending attempts', {
      theater: theater.name,
      allDates: datesToScrape.length,
      pendingDates: finalDatesToScrape.length,
    });
  }

  return { datesToScrape, finalDatesToScrape, skippedDates };
}

async function summarizeTheater(
  session: ScrapeSession,
  theater: TheaterConfig,
  counts: {
    successfulDates: number;
    totalDates: number;
    moviesCount: number;
    showtimesCount: number;
  }
): Promise<boolean> {
  const theaterFailed = counts.successfulDates === 0 && counts.totalDates > 0;
  logger.info('Theater summary', {
    theater: theater.name,
    successfulDates: counts.successfulDates,
    totalDates: counts.totalDates,
    movies: counts.moviesCount,
    showtimes: counts.showtimesCount,
  });

  if (!theaterFailed) {
    session.incrementSuccessfulTheater(counts.moviesCount, counts.showtimesCount);
    await session.emit({
      type: 'theater_completed',
      theater_name: theater.name,
      total_movies: counts.moviesCount,
    });
    return true;
  }

  session.incrementFailedTheater();
  logger.error('Theater failed completely', { theater: theater.name, dates: counts.totalDates });
  return false;
}

async function processTheater(
  theater: TheaterConfig,
  index: number,
  theaters: TheaterConfig[],
  dates: string[],
  session: ScrapeSession,
  options?: ScrapeOptions
): Promise<{ rateLimited: boolean }> {
  const strategy = getStrategyBySource(theater.source || 'allocine');

  await session.emit({
    type: 'theater_started',
    theater_name: theater.name,
    theater_id: theater.id,
    index: index + 1,
  });

  logger.info(`Processing theater using ${strategy.sourceName} strategy`, {
    theater: theater.name,
    id: theater.id,
  });

  const result = await scrapeTheaterWithStrategy(theater, dates, session, options, {
    allTheaters: theaters,
    theaterIndex: index,
    datesToScrape: dates,
  });

  if (!result.rateLimited) {
    return { rateLimited: false };
  }

  logger.warn('Stopping scrape due to rate limit', {
    processedTheaters: index + 1,
    totalTheaters: theaters.length,
  });

  return { rateLimited: true };
}

async function finalizeScrape(
  session: ScrapeSession,
  startTime: number
): Promise<void> {
  session.setDuration(Date.now() - startTime);
  logger.info('Scraping completed', { summary: session.summary });
  await closeBrowser();
  await session.emit({ type: 'completed', summary: session.summary });
}

async function handleFatalError(
  session: ScrapeSession,
  startTime: number,
  error: unknown
): Promise<never> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorType = classifyError(error);
  logger.error('Fatal error in scraper', { error });
  await closeBrowser();
  session.recordSystemError(errorMessage, errorType);
  session.setDuration(Date.now() - startTime);
  await session.emit({ type: 'failed', error: errorMessage });
  throw error;
}

export async function runScraper(
  progress?: ProgressPublisher,
  options?: ScrapeOptions
): Promise<ScrapeSummary> {
  logger.info('Starting scraper');

  const config = createScrapeConfig();
  const session = new ScrapeSession(db, config, progress);
  const startTime = Date.now();

  try {
    const { theaters, dates } = await prepareSchedule(db, session, options);

    for (let i = 0; i < theaters.length; i++) {
      const { rateLimited } = await processTheater(
        theaters[i], i, theaters, dates, session, options
      );
      if (rateLimited) break;
      if (i < theaters.length - 1) {
        logger.info('Waiting before next theater', { delayMs: config.theaterDelayMs });
        await delay(config.theaterDelayMs);
      }
    }

    await finalizeScrape(session, startTime);
    return session.summary;
  } catch (error) {
    await handleFatalError(session, startTime, error);
    throw error;
  }
}

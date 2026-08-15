import { db, type DB } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { closeBrowser, delay } from './http-client.js';
import { getStrategyByUrl, getStrategyBySource } from './strategy-factory.js';
import type { Theater, TheaterConfig } from '../types/scraper.js';
import { ScrapeRun } from './scrape-run.js';
import type { ScrapeOptions, ProgressPublisher } from './scrape-run.js';
import { createScrapeConfig } from './scrape-config.js';
import type { ScrapeSummary } from '../types/scraper.js';
import { activateTheater, resetProvisioningTheater } from '../db/theater-queries.js';

export type { ScrapeOptions, ProgressPublisher } from './scrape-run.js';

export async function loadTheaterMetadata(
  db: DB,
  theater: TheaterConfig
): Promise<{ availableDates: string[]; theater: Theater }> {
  const strategy = getStrategyBySource(theater.source || 'allocine');
  return strategy.loadTheaterMetadata(db, theater);
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
    source: strategy.sourceName,
  };

  const config = createScrapeConfig();
  logger.info(`Adding new theater from ${url} using ${strategy.sourceName} strategy...`);
  const { availableDates, theater } = await strategy.loadTheaterMetadata(db, tempConfig);

  logger.info(`Scraping ${availableDates.length} available date(s)...`, { theater: theater.name });

  let successfulDates = 0;
  let scrapedShowtimes = 0;
  for (const date of availableDates) {
    try {
      const result = await strategy.scrapeTheater(
        db,
        tempConfig,
        date,
        config.movieDelayMs,
        progress
      );
      successfulDates++;
      scrapedShowtimes += result.showtimesCount;
    } catch (error) {
      logger.error('Failed to scrape date', { date, theater: theater.name, error });
    }
  }

  if (successfulDates === 0 || scrapedShowtimes === 0) {
    await resetProvisioningTheater(db, theater.id);
    throw new Error(`Theater scrape failed for every available date: ${theater.id}`);
  }

  await activateTheater(db, theater.id);

  await closeBrowser();
  logger.info('Theater added successfully', { theater: theater.name, id: theater.id });

  return theater;
}

export async function runScraper(
  progress?: ProgressPublisher,
  options?: ScrapeOptions
): Promise<ScrapeSummary> {
  logger.info('Starting scraper');

  const config = createScrapeConfig();
  const run = new ScrapeRun(db, config, progress);
  const startTime = Date.now();

  try {
    const { theaters, dates } = await run.prepare(options);

    for (let i = 0; i < theaters.length; i++) {
      const { rateLimited } = await run.runTheater(
        theaters[i], i, theaters, dates, options
      );
      if (rateLimited) break;
      if (i < theaters.length - 1) {
        logger.info('Waiting before next theater', { delayMs: config.theaterDelayMs });
        await delay(config.theaterDelayMs);
      }
    }

    await run.finalize(startTime);
    return run.summary;
  } catch (error) {
    await run.handleFatalError(startTime, error);
    throw error;
  }
}

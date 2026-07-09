import type { ScrapeMode } from '../utils/date.js';

export interface ScrapeConfig {
  movieDelayMs: number;
  theaterDelayMs: number;
  scrapeMode: ScrapeMode;
  scrapeDays: number;
}

export function createScrapeConfig(overrides?: Partial<ScrapeConfig>): ScrapeConfig {
  return {
    movieDelayMs: overrides?.movieDelayMs ?? parseInt(process.env.SCRAPE_MOVIE_DELAY_MS || '500', 10),
    theaterDelayMs: overrides?.theaterDelayMs ?? parseInt(process.env.SCRAPE_THEATER_DELAY_MS || '3000', 10),
    scrapeMode: (overrides?.scrapeMode ?? process.env.SCRAPE_MODE as ScrapeMode) ?? 'from_today_limited',
    scrapeDays: overrides?.scrapeDays || parseInt(process.env.SCRAPE_DAYS || '7', 10),
  };
}

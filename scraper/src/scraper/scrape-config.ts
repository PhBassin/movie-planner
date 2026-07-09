import type { ScrapeMode } from '../utils/date.js';
import { parseStrictInt } from '../utils/number.js';

export interface ScrapeConfig {
  movieDelayMs: number;
  theaterDelayMs: number;
  scrapeMode: ScrapeMode;
  scrapeDays: number;
}

const VALID_SCRAPE_MODES: readonly ScrapeMode[] = [
  'weekly',
  'from_today',
  'from_today_limited',
];

const DEFAULTS = {
  movieDelayMs: 500,
  theaterDelayMs: 3000,
  scrapeMode: 'from_today_limited' as ScrapeMode,
  scrapeDays: 7,
};

function envInt(envVar: string, fallback: number): number {
  const parsed = parseStrictInt(process.env[envVar]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envScrapeMode(envVar: string, fallback: ScrapeMode): ScrapeMode {
  const raw = process.env[envVar];
  return raw && VALID_SCRAPE_MODES.includes(raw as ScrapeMode)
    ? (raw as ScrapeMode)
    : fallback;
}

export function createScrapeConfig(overrides?: Partial<ScrapeConfig>): ScrapeConfig {
  return {
    movieDelayMs: overrides?.movieDelayMs ?? envInt('SCRAPE_MOVIE_DELAY_MS', DEFAULTS.movieDelayMs),
    theaterDelayMs: overrides?.theaterDelayMs ?? envInt('SCRAPE_THEATER_DELAY_MS', DEFAULTS.theaterDelayMs),
    scrapeMode: overrides?.scrapeMode ?? envScrapeMode('SCRAPE_MODE', DEFAULTS.scrapeMode),
    scrapeDays: overrides?.scrapeDays ?? envInt('SCRAPE_DAYS', DEFAULTS.scrapeDays),
  };
}

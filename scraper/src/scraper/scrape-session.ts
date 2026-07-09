import type { DB } from '../db/client.js';
import type { ScrapeSummary, ProgressEvent } from '../types/scraper.js';
import type { ScrapeConfig } from './scrape-config.js';
import type { ErrorType } from '../utils/error-classifier.js';

export interface ProgressPublisher {
  emit(event: ProgressEvent): Promise<void>;
}

export type { ScrapeConfig };

export class ScrapeSession {
  readonly db: DB;
  readonly config: ScrapeConfig;
  readonly summary: ScrapeSummary;
  private readonly progress?: ProgressPublisher;

  constructor(db: DB, config: ScrapeConfig, progress?: ProgressPublisher) {
    this.db = db;
    this.config = config;
    this.progress = progress;
    this.summary = {
      total_theaters: 0,
      successful_theaters: 0,
      failed_theaters: 0,
      total_movies: 0,
      total_showtimes: 0,
      total_dates: 0,
      duration_ms: 0,
      errors: [],
    };
  }

  recordError(entry: {
    theater_name: string;
    theater_id: string;
    date?: string;
    error: string;
    error_type: ErrorType;
    http_status_code?: number;
  }): void {
    this.summary.errors.push(entry);
  }

  recordSystemError(errorMessage: string, errorType: ErrorType): void {
    this.summary.errors.push({
      theater_name: 'System',
      theater_id: 'system',
      error: errorMessage,
      error_type: errorType,
    });
  }

  incrementSuccessfulTheater(movies: number, showtimes: number): void {
    this.summary.successful_theaters++;
    this.summary.total_movies += movies;
    this.summary.total_showtimes += showtimes;
  }

  incrementFailedTheater(): void {
    this.summary.failed_theaters++;
  }

  markRateLimited(): void {
    this.summary.status = 'rate_limited';
  }

  setTotals(theaters: number, dates: number): void {
    this.summary.total_theaters = theaters;
    this.summary.total_dates = dates;
  }

  setDuration(ms: number): void {
    this.summary.duration_ms = ms;
  }

  async emit(event: ProgressEvent): Promise<void> {
    await this.progress?.emit(event);
  }
}

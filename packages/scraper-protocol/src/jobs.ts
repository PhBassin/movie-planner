export interface BaseScrapeJob {
  reportId: number;
}

export interface ScrapeJobScrape extends BaseScrapeJob {
  type: 'scrape';
  triggerType: 'manual' | 'cron';
  options?: {
    mode?: 'weekly' | 'from_today' | 'from_today_limited';
    days?: number;
    theaterId?: string;
    movieId?: number;
    resumeMode?: boolean;
    pendingAttempts?: Array<{ theater_id: string; date: string }>;
  };
}

export interface ScrapeJobAddTheater extends BaseScrapeJob {
  type: 'add_theater';
  triggerType: 'manual';
  url: string;
}

export type ScrapeJob = ScrapeJobScrape | ScrapeJobAddTheater;

export function serializeJob(job: ScrapeJob): string {
  return JSON.stringify(job);
}

export function parseJob(raw: string): ScrapeJob {
  const parsed: unknown = JSON.parse(raw);
  if (!isScrapeJob(parsed)) {
    throw new Error('Invalid ScrapeJob: failed type guard');
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScrapeJob(value: unknown): value is ScrapeJob {
  if (!isRecord(value)) return false;
  if (value.type === 'scrape') return isScrapeJobScrape(value);
  if (value.type === 'add_theater') return isScrapeJobAddTheater(value);
  return false;
}

const SCRAPE_MODES = new Set<string>(['weekly', 'from_today', 'from_today_limited']);

function isPendingAttempt(value: unknown): value is { theater_id: string; date: string } {
  if (!isRecord(value)) return false;
  return typeof value.theater_id === 'string' && typeof value.date === 'string';
}

function isPendingAttempts(value: unknown): value is Array<{ theater_id: string; date: string }> {
  if (!Array.isArray(value)) return false;
  return value.every(isPendingAttempt);
}

function isScrapeOptions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { mode, days, theaterId, movieId, resumeMode, pendingAttempts } = value;
  if (mode !== undefined && (typeof mode !== 'string' || !SCRAPE_MODES.has(mode))) return false;
  if (days !== undefined && typeof days !== 'number') return false;
  if (theaterId !== undefined && typeof theaterId !== 'string') return false;
  if (movieId !== undefined && typeof movieId !== 'number') return false;
  if (resumeMode !== undefined && typeof resumeMode !== 'boolean') return false;
  if (pendingAttempts !== undefined && !isPendingAttempts(pendingAttempts)) return false;
  return true;
}

function isBaseScrapeJob(value: Record<string, unknown>): boolean {
  if (typeof value.reportId !== 'number') return false;
  return true;
}

function isScrapeJobScrape(value: unknown): value is ScrapeJobScrape {
  if (!isRecord(value)) return false;
  if (value.type !== 'scrape') return false;
  if (value.triggerType !== 'manual' && value.triggerType !== 'cron') return false;
  if (!isBaseScrapeJob(value)) return false;
  if (value.options !== undefined && !isScrapeOptions(value.options)) return false;
  return true;
}

function isScrapeJobAddTheater(value: unknown): value is ScrapeJobAddTheater {
  if (!isRecord(value)) return false;
  if (value.type !== 'add_theater') return false;
  if (value.triggerType !== 'manual') return false;
  if (!isBaseScrapeJob(value)) return false;
  if (typeof value.url !== 'string' || value.url.length === 0) return false;
  return true;
}

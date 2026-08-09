import type { ScrapeJob, ScrapeJobScrape, ScrapeJobAddTheater } from './jobs.js';
import { serializeJob, parseJob } from './jobs.js';
import type { ProgressEvent, ScheduleChangeEvent, ScrapeSummary } from './events.js';

export type {
  ScrapeJob,
  ScrapeJobScrape,
  ScrapeJobAddTheater,
  ProgressEvent,
  ScheduleChangeEvent,
  ScrapeSummary,
};

export const NOTIFICATION_CHANNELS = {
  progress: 'scrape:progress',
  scheduleChanged: 'scraper:schedule:changed',
  memberNotices: 'member:notices',
} as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[keyof typeof NOTIFICATION_CHANNELS];

export interface NotificationBus {
  publish(channel: NotificationChannel, payload: string): Promise<void>;
  subscribe(channel: NotificationChannel, handler: (payload: string) => void): Promise<void>;
  disconnect(): Promise<void>;
}

export { serializeJob, parseJob };

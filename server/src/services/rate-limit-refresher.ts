import type { DB } from '../db/index.js';
import { loadFromDb } from './rate-limit-source.js';
import { logger } from '../utils/logger.js';

const POLL_INTERVAL = 60_000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startConfigRefresher(db: DB): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
  }

  const poll = async () => {
    try {
      const updated = await loadFromDb(db);
      if (updated) {
        logger.debug('Rate limit config refreshed from database');
      }
    } catch (error) {
      logger.warn('Failed to refresh rate limits from DB, using current config', { error });
    }
  };

  poll();
  intervalHandle = setInterval(poll, POLL_INTERVAL);

  if (intervalHandle.unref) {
    intervalHandle.unref();
  }
}

export function stopConfigRefresher(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

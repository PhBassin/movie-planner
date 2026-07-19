import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./rate-limit-source.js');
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { loadFromDb } from './rate-limit-source.js';
import { logger } from '../utils/logger.js';
import { startConfigRefresher, stopConfigRefresher } from './rate-limit-refresher.js';
import type { DB } from '../db/index.js';

describe('Rate Limit Refresher Service', () => {
  const mockDb = {} as DB;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(loadFromDb).mockResolvedValue(true);
  });

  afterEach(() => {
    stopConfigRefresher();
    vi.useRealTimers();
  });

  it('polls immediately on start', async () => {
    startConfigRefresher(mockDb);
    await vi.waitFor(() => {
      expect(loadFromDb).toHaveBeenCalledTimes(1);
      expect(loadFromDb).toHaveBeenCalledWith(mockDb);
    });
  });

  it('logs debug on successful DB refresh', async () => {
    startConfigRefresher(mockDb);
    await vi.waitFor(() => {
      expect(logger.debug).toHaveBeenCalledWith('Rate limit config refreshed from database');
    });
  });

  it('does not log debug when loadFromDb returns false (no row found)', async () => {
    vi.mocked(loadFromDb).mockResolvedValue(false);
    startConfigRefresher(mockDb);
    await vi.waitFor(() => expect(loadFromDb).toHaveBeenCalledTimes(1));
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('polls again after POLL_INTERVAL', async () => {
    startConfigRefresher(mockDb);
    await vi.waitFor(() => expect(loadFromDb).toHaveBeenCalledTimes(1));

    vi.mocked(loadFromDb).mockClear();
    vi.advanceTimersByTime(60000);

    await vi.waitFor(() => expect(loadFromDb).toHaveBeenCalledTimes(1));
  });

  it('logs warning when loadFromDb throws', async () => {
    vi.mocked(loadFromDb).mockRejectedValue(new Error('DB connection failed'));

    startConfigRefresher(mockDb);

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to refresh rate limits from DB, using current config',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  it('clears interval on stopConfigRefresher', async () => {
    startConfigRefresher(mockDb);
    await vi.waitFor(() => expect(loadFromDb).toHaveBeenCalledTimes(1));

    stopConfigRefresher();
    vi.mocked(loadFromDb).mockClear();

    vi.advanceTimersByTime(120000);
    expect(loadFromDb).not.toHaveBeenCalled();
  });

  it('restarts interval if startConfigRefresher is called twice', async () => {
    startConfigRefresher(mockDb);
    await vi.waitFor(() => expect(loadFromDb).toHaveBeenCalledTimes(1));

    vi.mocked(loadFromDb).mockClear();
    startConfigRefresher(mockDb);

    await vi.waitFor(() => expect(loadFromDb).toHaveBeenCalledTimes(1));
  });
});

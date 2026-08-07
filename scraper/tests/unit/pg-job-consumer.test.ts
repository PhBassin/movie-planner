import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPool, MockPool } = vi.hoisted(() => {
  const mockPool = {
    query: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
  class MockPool {
    constructor() {
      return mockPool;
    }
  }
  return { mockPool, MockPool };
});

vi.mock('pg', () => ({ default: { Pool: MockPool } }));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { PgJobConsumer } from '../../src/bus/pg-job-consumer.js';

describe('PgJobConsumer', () => {
  let consumer: PgJobConsumer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.end.mockResolvedValue(undefined);
    consumer = new PgJobConsumer('postgres://test', 0);
  });

  it('claims the oldest job with FOR UPDATE SKIP LOCKED', async () => {
    const job = { type: 'scrape', reportId: 7, triggerType: 'manual' };
    mockPool.query.mockResolvedValueOnce({ rows: [{ payload: JSON.stringify(job) }] });

    await expect(consumer.popOne()).resolves.toEqual(job);
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE SKIP LOCKED'));
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM scrape_jobs'));
  });

  it('returns null when the queue is empty', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(consumer.popOne()).resolves.toBeNull();
  });

  it('preserves Redis terminal behavior for malformed payloads', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ payload: 'not-json' }] });

    await expect(consumer.popOne()).rejects.toThrow(SyntaxError);
  });

  it('rejects structurally invalid JSON payloads', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ payload: JSON.stringify({}) }] });

    await expect(consumer.popOne()).rejects.toThrow('Invalid ScrapeJob');
  });

  it('continues after a handler failure and stops cleanly', async () => {
    const first = { type: 'scrape', reportId: 1, triggerType: 'manual' };
    const second = { type: 'scrape', reportId: 2, triggerType: 'manual' };
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ payload: JSON.stringify(first) }] })
      .mockResolvedValueOnce({ rows: [{ payload: JSON.stringify(second) }] });
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error('terminal'))
      .mockImplementationOnce(async () => consumer.stop());

    await consumer.start(handler);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, first);
    expect(handler).toHaveBeenNthCalledWith(2, second);
  });

  it('closes the pool and stops consuming', async () => {
    await consumer.disconnect();

    expect(mockPool.end).toHaveBeenCalledOnce();
  });
});

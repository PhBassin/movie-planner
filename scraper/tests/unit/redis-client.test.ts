import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock ioredis using vi.hoisted() to ensure variables are available before
// module hoisting resolves imports.
// ---------------------------------------------------------------------------

const { mockPublish, mockQuit, mockBlpop, mockLpop, MockRedis } = vi.hoisted(() => {
  const mockPublish = vi.fn().mockResolvedValue(1);
  const mockQuit = vi.fn().mockResolvedValue('OK');
  const mockBlpop = vi.fn().mockResolvedValue(null);
  const mockLpop = vi.fn().mockResolvedValue(null);

  class MockRedis {
    publish = mockPublish;
    quit = mockQuit;
    blpop = mockBlpop;
    lpop = mockLpop;
    on = vi.fn();
  }

  return { mockPublish, mockQuit, mockBlpop, mockLpop, MockRedis };
});

vi.mock('ioredis', () => ({
  default: MockRedis,
}));

import { RedisProgressPublisher, RedisJobConsumer, RedisBusConsumer } from '../../src/redis/client.js';
import type { BusConsumer } from '@movie-planner/scraper-protocol';

describe('RedisProgressPublisher', () => {
  let publisher: RedisProgressPublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    publisher = new RedisProgressPublisher('redis://localhost:6379');
  });

  it('publishes progress events to scrape:progress channel', async () => {
    const event = { type: 'started' as const, total_theaters: 3, total_dates: 7 };
    await publisher.emit(event);

    expect(mockPublish).toHaveBeenCalledWith('scrape:progress', JSON.stringify(event));
  });

  it('publishes completed event with summary', async () => {
    const event = {
      type: 'completed' as const,
      summary: {
        total_theaters: 2,
        successful_theaters: 2,
        failed_theaters: 0,
        total_movies: 10,
        total_showtimes: 50,
        total_dates: 7,
        duration_ms: 5000,
        errors: [],
      },
    };
    await publisher.emit(event);

    expect(mockPublish).toHaveBeenCalledWith('scrape:progress', JSON.stringify(event));
  });

  it('disconnects cleanly', async () => {
    await publisher.disconnect();
    expect(mockQuit).toHaveBeenCalledOnce();
  });
});

describe('RedisJobConsumer', () => {
  let consumer: RedisJobConsumer;

  beforeEach(() => {
    vi.clearAllMocks();
    consumer = new RedisJobConsumer('redis://localhost:6379');
  });

  it('stops cleanly', async () => {
    consumer.stop();
    await consumer.disconnect();
    expect(mockQuit).toHaveBeenCalled();
  });

  it('does not call handler when queue is empty (BLPOP timeout)', async () => {
    const handler = vi.fn();

    // Make blpop return null once, then consumer.stop() is called to break the loop
    mockBlpop.mockImplementation(async () => {
      consumer.stop();
      return null;
    });

    await consumer.start(handler);

    expect(handler).not.toHaveBeenCalled();
  });

  it('popOne returns null when queue is empty', async () => {
    mockLpop.mockResolvedValueOnce(null);
    const job = await consumer.popOne();
    expect(job).toBeNull();
    expect(mockLpop).toHaveBeenCalledWith('scrape:jobs');
  });

  it('popOne returns the parsed job when queue has one', async () => {
    const payload = { type: 'scrape', triggerType: 'manual', reportId: 7 };
    mockLpop.mockResolvedValueOnce(JSON.stringify(payload));
    const job = await consumer.popOne();
    expect(job).toEqual(payload);
  });

  it('popOne returns null on unparseable payload', async () => {
    mockLpop.mockResolvedValueOnce('not-json');
    const job = await consumer.popOne();
    expect(job).toBeNull();
  });
});

describe('RedisBusConsumer', () => {
  let bus: RedisBusConsumer;

  beforeEach(() => {
    vi.clearAllMocks();
    bus = new RedisBusConsumer('redis://localhost:6379');
  });

  it('implements the BusConsumer port', () => {
    // Compile-time satisfaction; runtime identity check here.
    const port: BusConsumer = bus;
    expect(port).toBe(bus);
  });

  it('publishProgress delegates to the wrapped publisher', async () => {
    const event = { type: 'started' as const, total_theaters: 1, total_dates: 1 };
    await bus.publishProgress(event);
    expect(mockPublish).toHaveBeenCalledWith('scrape:progress', JSON.stringify(event));
  });

  it('popOneJob delegates to the wrapped consumer', async () => {
    mockLpop.mockResolvedValueOnce(null);
    const job = await bus.popOneJob();
    expect(job).toBeNull();
    expect(mockLpop).toHaveBeenCalledWith('scrape:jobs');
  });

  it('disconnect tears down all three sub-clients', async () => {
    await bus.disconnect();
    // publisher + consumer + subscriber each quit once → 3 calls
    expect(mockQuit).toHaveBeenCalledTimes(3);
  });
});

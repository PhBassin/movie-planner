import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BusProducer } from '@movie-planner/scraper-protocol';

const queue = vi.hoisted(() => ({
  enqueue: vi.fn().mockResolvedValue(1),
  enqueueAddTheater: vi.fn().mockResolvedValue(1),
  depth: vi.fn().mockResolvedValue(0),
  close: vi.fn().mockResolvedValue(undefined),
}));

const pubsub = vi.hoisted((): BusProducer => ({
  enqueueJob: vi.fn().mockResolvedValue(0),
  enqueueAddTheaterJob: vi.fn().mockResolvedValue(0),
  getQueueDepth: vi.fn().mockResolvedValue(0),
  subscribeToProgress: vi.fn().mockResolvedValue(undefined),
  publishScheduleChange: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./pg-job-queue.js', () => ({
  PgJobQueue: function MockPgJobQueue() {
    return queue;
  },
}));
vi.mock('./redis-client.js', () => ({
  getRedisClient: () => pubsub,
}));

import { PostgresBusProducer, getBusProducer, resetBusProducer } from './bus-producer.js';

describe('PostgresBusProducer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBusProducer();
  });

  it('implements the BusProducer port and delegates queue operations', async () => {
    const producer: BusProducer = new PostgresBusProducer(queue, pubsub);
    const job = { type: 'scrape' as const, reportId: 1, triggerType: 'manual' as const };

    await producer.enqueueJob(job);
    await producer.enqueueAddTheaterJob(2, 'url');
    await producer.getQueueDepth();

    expect(queue.enqueue).toHaveBeenCalledWith(job, undefined);
    expect(queue.enqueueAddTheater).toHaveBeenCalledWith(2, 'url', undefined);
    expect(queue.depth).toHaveBeenCalledOnce();
  });

  it('delegates pub/sub and disconnects both backends', async () => {
    const producer = new PostgresBusProducer(queue, pubsub);
    const handler = vi.fn();
    const event = { action: 'created' as const, scheduleId: 1 };

    await producer.subscribeToProgress(handler);
    await producer.publishScheduleChange(event);
    await producer.disconnect();

    expect(pubsub.subscribeToProgress).toHaveBeenCalledWith(handler);
    expect(pubsub.publishScheduleChange).toHaveBeenCalledWith(event);
    expect(queue.close).toHaveBeenCalledOnce();
    expect(pubsub.disconnect).toHaveBeenCalledOnce();
  });

  it('lazily creates and caches the composed singleton', () => {
    const first = getBusProducer();
    const second = getBusProducer();

    expect(first).toBeInstanceOf(PostgresBusProducer);
    expect(second).toBe(first);
  });
});

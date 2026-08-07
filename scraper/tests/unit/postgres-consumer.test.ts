import { describe, it, expect, vi } from 'vitest';
import type { BusConsumer } from '@movie-planner/scraper-protocol';
import { PostgresBusConsumer } from '../../src/bus/postgres-consumer.js';

describe('PostgresBusConsumer', () => {
  const queue = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    popOne: vi.fn().mockResolvedValue(null),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const pubsub: BusConsumer = {
    publishProgress: vi.fn().mockResolvedValue(undefined),
    consumeJobs: vi.fn().mockResolvedValue(undefined),
    stopConsuming: vi.fn(),
    popOneJob: vi.fn().mockResolvedValue(null),
    subscribeScheduleChange: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };

  it('implements the BusConsumer port', () => {
    const bus: BusConsumer = new PostgresBusConsumer(queue, pubsub);
    expect(bus).toBeInstanceOf(PostgresBusConsumer);
  });

  it('delegates queue operations to Postgres', async () => {
    const bus = new PostgresBusConsumer(queue, pubsub);
    const handler = vi.fn();

    await bus.consumeJobs(handler);
    bus.stopConsuming();
    await bus.popOneJob();

    expect(queue.start).toHaveBeenCalledWith(handler);
    expect(queue.stop).toHaveBeenCalledOnce();
    expect(queue.popOne).toHaveBeenCalledOnce();
  });

  it('delegates pub/sub operations to Redis during the incremental migration', async () => {
    const bus = new PostgresBusConsumer(queue, pubsub);
    const event = { type: 'started' as const, total_theaters: 1, total_dates: 1 };
    const handler = vi.fn();

    await bus.publishProgress(event);
    await bus.subscribeScheduleChange(handler);

    expect(pubsub.publishProgress).toHaveBeenCalledWith(event);
    expect(pubsub.subscribeScheduleChange).toHaveBeenCalledWith(handler);
  });

  it('disconnects both backends', async () => {
    const bus = new PostgresBusConsumer(queue, pubsub);

    await bus.disconnect();

    expect(queue.disconnect).toHaveBeenCalledOnce();
    expect(pubsub.disconnect).toHaveBeenCalledOnce();
  });
});

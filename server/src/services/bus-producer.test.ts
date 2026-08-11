import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NOTIFICATION_CHANNELS, type BusProducer, type NotificationBus } from '@movie-planner/scraper-protocol';

const queue = vi.hoisted(() => ({
  enqueue: vi.fn().mockResolvedValue(1),
  enqueueAddTheater: vi.fn().mockResolvedValue(1),
  depth: vi.fn().mockResolvedValue(0),
  close: vi.fn().mockResolvedValue(undefined),
}));

const notifications = vi.hoisted((): NotificationBus => ({
  publish: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./pg-job-queue.js', () => ({
  PgJobQueue: function MockPgJobQueue() {
    return queue;
  },
}));
vi.mock('./postgres-notification-bus.js', () => ({
  PostgresNotificationBus: class MockPostgresNotificationBus implements NotificationBus {
    publish = notifications.publish;
    subscribe = notifications.subscribe;
    disconnect = notifications.disconnect;
  },
}));
vi.mock('../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { PostgresBusProducer, getBusProducer, resetBusProducer } from './bus-producer.js';
import { logger } from '../utils/logger.js';

describe('PostgresBusProducer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBusProducer();
  });

  it('implements the BusProducer port and delegates queue operations', async () => {
    const producer: BusProducer = new PostgresBusProducer(queue, notifications);
    const job = { type: 'scrape' as const, reportId: 1, triggerType: 'manual' as const };

    await producer.enqueueJob(job);
    await producer.enqueueAddTheaterJob(2, 'url');
    await producer.getQueueDepth();

    expect(queue.enqueue).toHaveBeenCalledWith(job, undefined);
    expect(queue.enqueueAddTheater).toHaveBeenCalledWith(2, 'url', undefined);
    expect(queue.depth).toHaveBeenCalledOnce();
  });

  it('subscribes to progress events and parses payloads for the handler', async () => {
    const producer = new PostgresBusProducer(queue, notifications);
    const handler = vi.fn();

    await producer.subscribeToProgress(handler);

    expect(notifications.subscribe).toHaveBeenCalledWith(
      NOTIFICATION_CHANNELS.progress,
      expect.any(Function),
    );

    const listener = vi.mocked(notifications.subscribe).mock.calls[0][1];
    const event = { type: 'started' as const, total_theaters: 3, total_dates: 7 };
    listener(JSON.stringify(event));
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('logs and swallows malformed progress payloads', async () => {
    const producer = new PostgresBusProducer(queue, notifications);
    await producer.subscribeToProgress(vi.fn());

    const listener = vi.mocked(notifications.subscribe).mock.calls[0][1];
    expect(() => listener('not-json')).not.toThrow();
  });

  it('publishes schedule changes serialized to the schedule-change channel', async () => {
    const producer = new PostgresBusProducer(queue, notifications);
    const event = { action: 'created' as const, scheduleId: 1 };

    await producer.publishScheduleChange(event);

    expect(notifications.publish).toHaveBeenCalledWith(
      NOTIFICATION_CHANNELS.scheduleChanged,
      JSON.stringify(event),
    );
  });

  it('logs and swallows schedule-change publish failures (ephemeral nudge, best-effort)', async () => {
    vi.mocked(notifications.publish).mockRejectedValueOnce(new Error('pg down'));
    const producer = new PostgresBusProducer(queue, notifications);

    await expect(
      producer.publishScheduleChange({ action: 'created' as const, scheduleId: 1 }),
    ).resolves.toBeUndefined();

    expect(notifications.publish).toHaveBeenCalledWith(
      NOTIFICATION_CHANNELS.scheduleChanged,
      JSON.stringify({ action: 'created', scheduleId: 1 }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      '[PostgresBusProducer] Dropped schedule-change notification',
      { error: expect.any(Error) },
    );
  });

  it('disconnects both the queue and the notification backend', async () => {
    const producer = new PostgresBusProducer(queue, notifications);

    await producer.disconnect();

    expect(queue.close).toHaveBeenCalledOnce();
    expect(notifications.disconnect).toHaveBeenCalledOnce();
  });

  it('lazily creates and caches the composed singleton', () => {
    const first = getBusProducer();
    const second = getBusProducer();

    expect(first).toBeInstanceOf(PostgresBusProducer);
    expect(second).toBe(first);
  });
});

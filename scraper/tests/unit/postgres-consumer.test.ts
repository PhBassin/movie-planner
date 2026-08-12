import { describe, it, expect, vi } from 'vitest';
import { NOTIFICATION_CHANNELS, type BusConsumer, type NotificationBus } from '@movie-planner/scraper-protocol';
import { PostgresBusConsumer } from '../../src/bus/postgres-consumer.js';

describe('PostgresBusConsumer', () => {
  const queue = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    popOne: vi.fn().mockResolvedValue(null),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const notifications: NotificationBus = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };

  it('implements the BusConsumer port', () => {
    const bus: BusConsumer = new PostgresBusConsumer(queue, notifications);
    expect(bus).toBeInstanceOf(PostgresBusConsumer);
  });

  it('delegates queue operations to Postgres', async () => {
    const bus = new PostgresBusConsumer(queue, notifications);
    const handler = vi.fn();

    await bus.consumeJobs(handler);
    bus.stopConsuming();
    await bus.popOneJob();

    expect(queue.start).toHaveBeenCalledWith(handler);
    expect(queue.stop).toHaveBeenCalledOnce();
    expect(queue.popOne).toHaveBeenCalledOnce();
  });

  it('publishes progress events serialized to the progress channel', async () => {
    const bus = new PostgresBusConsumer(queue, notifications);
    const event = { type: 'started' as const, total_theaters: 1, total_dates: 1 };

    await bus.publishProgress(event);

    expect(notifications.publish).toHaveBeenCalledWith(
      NOTIFICATION_CHANNELS.progress,
      JSON.stringify(event),
    );
  });

  it('drops a progress notification when publishing fails, without throwing', async () => {
    vi.mocked(notifications.publish).mockRejectedValueOnce(new Error('payload exceeds 8000 bytes'));
    const bus = new PostgresBusConsumer(queue, notifications);
    const event = { type: 'completed' as const, summary: { errors: [] } } as never;

    await expect(bus.publishProgress(event)).resolves.toBeUndefined();
  });

  it('subscribes to schedule changes and parses payloads for the handler', async () => {
    const bus = new PostgresBusConsumer(queue, notifications);
    const handler = vi.fn();

    await bus.subscribeScheduleChange(handler);

    expect(notifications.subscribe).toHaveBeenCalledWith(
      NOTIFICATION_CHANNELS.scheduleChanged,
      expect.any(Function),
    );

    const listener = vi.mocked(notifications.subscribe).mock.calls[0][1];
    const event = { action: 'deleted' as const, scheduleId: 9 };
    listener(JSON.stringify(event));
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('logs and swallows malformed schedule-change payloads', async () => {
    const bus = new PostgresBusConsumer(queue, notifications);
    await bus.subscribeScheduleChange(vi.fn());

    const listener = vi.mocked(notifications.subscribe).mock.calls[0][1];
    expect(() => listener('not-json')).not.toThrow();
  });

  it('disconnects both the queue and the notification backend', async () => {
    const bus = new PostgresBusConsumer(queue, notifications);

    await bus.disconnect();

    expect(queue.disconnect).toHaveBeenCalledOnce();
    expect(notifications.disconnect).toHaveBeenCalledOnce();
  });
});

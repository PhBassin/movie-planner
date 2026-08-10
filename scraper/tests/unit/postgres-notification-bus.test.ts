import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import { NOTIFICATION_CHANNELS } from '@movie-planner/scraper-protocol';
import {
  PostgresNotificationBus,
  defaultNotificationClientFactory,
  type NotificationClient,
  type NotificationClientFactory,
} from '../../src/bus/postgres-notification-bus.js';
import { logger } from '../../src/utils/logger.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

/** Minimal fake pg.Client: records calls and lets tests emit events. */
class FakeClient {
  connect = vi.fn().mockResolvedValue(undefined);
  query = vi.fn().mockResolvedValue({ rows: [] });
  end = vi.fn().mockResolvedValue(undefined);
  on = vi.fn((name: string, handler: (...args: unknown[]) => void) => {
    const listeners = this.listeners.get(name) ?? new Set<(...args: unknown[]) => void>();
    listeners.add(handler);
    this.listeners.set(name, listeners);
    return this;
  });
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  emit(name: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(name) ?? []) handler(...args);
  }
}

function makeBus(
  mutate?: (client: FakeClient, index: number) => void,
): { bus: PostgresNotificationBus; clients: FakeClient[]; factory: ReturnType<typeof vi.fn> } {
  const clients: FakeClient[] = [];
  const factory = vi.fn((_connectionString?: string) => {
    const client = new FakeClient();
    mutate?.(client, clients.length);
    clients.push(client);
    return client as unknown as NotificationClient;
  }) as unknown as NotificationClientFactory & ReturnType<typeof vi.fn>;

  const bus = new PostgresNotificationBus('postgres://test', factory);
  return { bus, clients, factory };
}

describe('PostgresNotificationBus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('defaultNotificationClientFactory', () => {
    it('builds a lazy client from a connection string', () => {
      const client = defaultNotificationClientFactory('postgres://user:pass@host:5433/db');
      expect(client).toBeInstanceOf(pg.Client);
      const params = (client as unknown as { connectionParameters: { host: string; port: number; database: string } })
        .connectionParameters;
      expect(params.host).toBe('host');
      expect(params.port).toBe(5433);
      expect(params.database).toBe('db');
    });

    it('builds a lazy client from the POSTGRES_* environment', () => {
      process.env.POSTGRES_HOST = 'db.internal';
      process.env.POSTGRES_DB = 'test_db';
      const client = defaultNotificationClientFactory();
      expect(client).toBeInstanceOf(pg.Client);
      expect((client as unknown as { host: string }).host).toBe('db.internal');
      expect((client as unknown as { database: string }).database).toBe('test_db');
      delete process.env.POSTGRES_HOST;
      delete process.env.POSTGRES_DB;
    });
  });

  describe('publish', () => {
    it('opens a short-lived client and calls pg_notify', async () => {
      const { bus, clients, factory } = makeBus();

      await bus.publish(NOTIFICATION_CHANNELS.progress, '{"type":"started"}');

      expect(factory).toHaveBeenCalledWith('postgres://test');
      expect(clients[0].connect).toHaveBeenCalledOnce();
      expect(clients[0].query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
        'scrape:progress',
        '{"type":"started"}',
      ]);
      expect(clients[0].end).toHaveBeenCalledOnce();
    });

    it('rejects payloads over the 8 KB notification cap without opening a client', async () => {
      const { bus, factory, clients } = makeBus();

      await expect(
        bus.publish(NOTIFICATION_CHANNELS.progress, 'x'.repeat(8001)),
      ).rejects.toThrow(/exceeds 8000 bytes/);

      expect(factory).not.toHaveBeenCalled();
      expect(clients).toHaveLength(0);
    });

    it('accepts payloads exactly at the cap', async () => {
      const { bus } = makeBus();

      await expect(
        bus.publish(NOTIFICATION_CHANNELS.progress, 'x'.repeat(8000)),
      ).resolves.toBeUndefined();
    });

    it('rejects unknown channels before opening a client', async () => {
      const { bus, factory } = makeBus();

      await expect(bus.publish('not:a:channel' as never)).rejects.toThrow(/Unsupported notification channel/);
      expect(factory).not.toHaveBeenCalled();
    });
  });

  describe('subscribe', () => {
    it('connects, issues LISTEN, and dispatches notifications to handlers', async () => {
      const { bus, clients } = makeBus();
      const handler = vi.fn();

      await bus.subscribe(NOTIFICATION_CHANNELS.progress, handler);

      expect(clients[0].connect).toHaveBeenCalledOnce();
      expect(clients[0].query).toHaveBeenCalledWith('LISTEN "scrape:progress"');

      clients[0].emit('notification', {
        channel: 'scrape:progress',
        payload: '{"type":"started","total_theaters":2,"total_dates":1}',
      });
      expect(handler).toHaveBeenCalledWith('{"type":"started","total_theaters":2,"total_dates":1}');
    });

    it('dispatches to every handler registered on a channel', async () => {
      const { bus, clients } = makeBus();
      const first = vi.fn();
      const second = vi.fn();

      await bus.subscribe(NOTIFICATION_CHANNELS.progress, first);
      await bus.subscribe(NOTIFICATION_CHANNELS.progress, second);
      clients[0].emit('notification', { channel: 'scrape:progress', payload: 'p' });

      expect(first).toHaveBeenCalledWith('p');
      expect(second).toHaveBeenCalledWith('p');
    });

    it('ignores notifications for unsubscribed channels and payload-less messages', async () => {
      const { bus, clients } = makeBus();
      const handler = vi.fn();

      await bus.subscribe(NOTIFICATION_CHANNELS.progress, handler);
      clients[0].emit('notification', { channel: 'scraper:schedule:changed', payload: 'p' });
      clients[0].emit('notification', { channel: 'scrape:progress' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('keeps dispatching to other handlers when one throws', async () => {
      const { bus, clients } = makeBus();
      const throwing = vi.fn(() => {
        throw new Error('boom');
      });
      const healthy = vi.fn();

      await bus.subscribe(NOTIFICATION_CHANNELS.progress, throwing);
      await bus.subscribe(NOTIFICATION_CHANNELS.progress, healthy);
      clients[0].emit('notification', { channel: 'scrape:progress', payload: 'p' });

      expect(throwing).toHaveBeenCalledWith('p');
      expect(healthy).toHaveBeenCalledWith('p');
      expect(logger.error).toHaveBeenCalled();
    });

    it('reuses an existing listener connection for later subscribes', async () => {
      const { bus, clients } = makeBus();

      await bus.subscribe(NOTIFICATION_CHANNELS.progress, vi.fn());
      await bus.subscribe(NOTIFICATION_CHANNELS.scheduleChanged, vi.fn());

      expect(clients).toHaveLength(1);
      expect(clients[0].query).toHaveBeenCalledWith('LISTEN "scrape:progress"');
      expect(clients[0].query).toHaveBeenCalledWith('LISTEN "scraper:schedule:changed"');
    });

    it('rejects unknown channels without registering a handler', async () => {
      const { bus, factory } = makeBus();

      await expect(bus.subscribe('not:a:channel' as never, vi.fn())).rejects.toThrow(/Unsupported notification channel/);
      expect(factory).not.toHaveBeenCalled();
    });

    it('survives an initial connect failure and retries via the reconnect loop', async () => {
      const { bus, clients } = makeBus((client, index) => {
        if (index === 0) client.connect.mockRejectedValueOnce(new Error('db down'));
      });

      await expect(bus.subscribe(NOTIFICATION_CHANNELS.progress, vi.fn())).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(clients).toHaveLength(2);
      expect(clients[1].connect).toHaveBeenCalledOnce();
      expect(clients[1].query).toHaveBeenCalledWith('LISTEN "scrape:progress"');
    });

    it('serializes concurrent subscribe connects into one listener connection', async () => {
      const { bus, clients } = makeBus();

      await Promise.all([
        bus.subscribe(NOTIFICATION_CHANNELS.progress, vi.fn()),
        bus.subscribe(NOTIFICATION_CHANNELS.scheduleChanged, vi.fn()),
      ]);

      expect(clients).toHaveLength(1);
    });
  });

  describe('reconnect lifecycle', () => {
    it('reconnects and re-issues LISTEN after the listener errors', async () => {
      const { bus, clients } = makeBus();
      await bus.subscribe(NOTIFICATION_CHANNELS.progress, vi.fn());

      clients[0].emit('error', new Error('conn lost'));

      await vi.advanceTimersByTimeAsync(1000);
      expect(clients).toHaveLength(2);
      expect(clients[1].connect).toHaveBeenCalledOnce();
      expect(clients[1].query).toHaveBeenCalledWith('LISTEN "scrape:progress"');
      expect(clients[0].end).toHaveBeenCalledOnce();
    });

    it('reconnects after the listener connection ends', async () => {
      const { bus, clients } = makeBus();
      await bus.subscribe(NOTIFICATION_CHANNELS.progress, vi.fn());

      clients[0].emit('end');

      await vi.advanceTimersByTimeAsync(1000);
      expect(clients).toHaveLength(2);
      expect(clients[1].connect).toHaveBeenCalledOnce();
    });

    it('keeps retrying while reconnects fail', async () => {
      const { bus, clients } = makeBus((client, index) => {
        if (index === 1) client.connect.mockRejectedValueOnce(new Error('down'));
      });
      await bus.subscribe(NOTIFICATION_CHANNELS.progress, vi.fn());

      clients[0].emit('end');

      await vi.advanceTimersByTimeAsync(1000);
      expect(clients[1].connect).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Reconnect failed'),
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(1000);
      expect(clients).toHaveLength(3);
      expect(clients[2].connect).toHaveBeenCalledOnce();
    });

    it('dispatches to handlers on the reconnected connection', async () => {
      const { bus, clients } = makeBus();
      const handler = vi.fn();
      await bus.subscribe(NOTIFICATION_CHANNELS.progress, handler);

      clients[0].emit('end');
      await vi.advanceTimersByTimeAsync(1000);

      clients[1].emit('notification', { channel: 'scrape:progress', payload: 'after-reconnect' });
      expect(handler).toHaveBeenCalledWith('after-reconnect');
    });

    it('does not stack multiple reconnect timers for a burst of failures', async () => {
      const { bus, clients } = makeBus();
      await bus.subscribe(NOTIFICATION_CHANNELS.progress, vi.fn());

      clients[0].emit('error', new Error('x'));
      clients[0].emit('end');

      await vi.advanceTimersByTimeAsync(1000);
      expect(clients).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(2000);
      expect(clients).toHaveLength(2);
    });

    it('ignores end events from a stale listener connection after reconnect', async () => {
      const { bus, clients } = makeBus();
      await bus.subscribe(NOTIFICATION_CHANNELS.progress, vi.fn());

      clients[0].emit('end');
      await vi.advanceTimersByTimeAsync(1000);
      expect(clients).toHaveLength(2);

      clients[0].emit('end');
      await vi.advanceTimersByTimeAsync(2000);
      expect(clients).toHaveLength(2);
    });
  });

  describe('disconnect', () => {
    it('ends the listener connection and stops reconnecting', async () => {
      const { bus, clients } = makeBus();
      await bus.subscribe(NOTIFICATION_CHANNELS.progress, vi.fn());

      await bus.disconnect();
      expect(clients[0].end).toHaveBeenCalledOnce();

      clients[0].emit('end');
      await vi.advanceTimersByTimeAsync(2000);
      expect(clients).toHaveLength(1);
    });

    it('cancels a pending reconnect on disconnect', async () => {
      const { bus, clients } = makeBus();
      await bus.subscribe(NOTIFICATION_CHANNELS.progress, vi.fn());

      clients[0].emit('end');
      await bus.disconnect();

      await vi.advanceTimersByTimeAsync(2000);
      expect(clients).toHaveLength(1);
    });

    it('is a no-op when no listener connection was ever opened', async () => {
      const { bus, clients } = makeBus();

      await expect(bus.disconnect()).resolves.toBeUndefined();
      expect(clients).toHaveLength(0);
    });
  });
});

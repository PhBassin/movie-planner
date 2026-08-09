import { describe, expect, it, vi } from 'vitest';
import { PostgresNotificationBus, type NotificationClient } from './postgres-notification-bus.js';

function clientFixture() {
  const listeners = new Map<string, (...args: any[]) => void>();
  const client: NotificationClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, listener);
      return client;
    }),
  };
  return { client, listeners };
}

describe('PostgresNotificationBus', () => {
  it('publishes with pg_notify and closes the short-lived publisher connection', async () => {
    const { client } = clientFixture();
    const bus = new PostgresNotificationBus('postgres://test', () => client);

    await bus.publish('scrape:progress', '{"type":"started"}');

    expect(client.query).toHaveBeenCalledWith(
      'SELECT pg_notify($1, $2)',
      ['scrape:progress', '{"type":"started"}'],
    );
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('closes the publisher connection when publishing fails', async () => {
    const fixture = clientFixture();
    fixture.client.query = vi.fn().mockRejectedValue(new Error('notify failed'));
    const bus = new PostgresNotificationBus('postgres://test', () => fixture.client);

    await expect(bus.publish('scrape:progress', '{}')).rejects.toThrow('notify failed');
    expect(fixture.client.end).toHaveBeenCalledOnce();
  });

  it('delivers notifications to subscribers and restores LISTEN after reconnect', async () => {
    const first = clientFixture();
    const second = clientFixture();
    const createClient = vi.fn()
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    const handler = vi.fn();
    const bus = new PostgresNotificationBus('postgres://test', createClient);

    await bus.subscribe('scraper:schedule:changed', handler);
    first.listeners.get('notification')!({
      channel: 'scraper:schedule:changed',
      payload: '{"action":"updated","scheduleId":7}',
    });
    expect(handler).toHaveBeenCalledWith('{"action":"updated","scheduleId":7}');

    first.listeners.get('end')!();
    await new Promise(resolve => setTimeout(resolve, 1200));

    expect(second.client.query).toHaveBeenCalledWith('LISTEN "scraper:schedule:changed"');
    await bus.disconnect();
    expect(second.client.end).toHaveBeenCalledOnce();
  }, 3000);

  it('rejects payloads that exceed PostgreSQL notification limits', async () => {
    const { client } = clientFixture();
    const bus = new PostgresNotificationBus('postgres://test', () => client);

    await expect(bus.publish('member:notices', 'x'.repeat(8001))).rejects.toThrow('exceeds 8000 bytes');
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('contains handler failures and rejects unknown channels', async () => {
    const fixture = clientFixture();
    const bus = new PostgresNotificationBus('postgres://test', () => fixture.client);
    const handler = vi.fn(() => { throw new Error('handler failed'); });

    await bus.subscribe('scrape:progress', handler);
    expect(() => fixture.listeners.get('notification')!({
      channel: 'scrape:progress',
      payload: '{}',
    })).not.toThrow();
    await expect(bus.publish('invalid' as never, '{}')).rejects.toThrow('Unsupported notification channel');
  });

  it('ignores notifications without a matching handler or payload', async () => {
    const fixture = clientFixture();
    const bus = new PostgresNotificationBus('postgres://test', () => fixture.client);

    await bus.subscribe('scrape:progress', vi.fn());
    expect(() => fixture.listeners.get('notification')!({ channel: 'member:notices', payload: '{}' })).not.toThrow();
    expect(() => fixture.listeners.get('notification')!({ channel: 'scrape:progress' })).not.toThrow();
    await bus.disconnect();
  });

  it('retries an initial listener connection failure', async () => {
    const first = clientFixture();
    first.client.connect = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const second = clientFixture();
    const createClient = vi.fn().mockReturnValueOnce(first.client).mockReturnValueOnce(second.client);
    const bus = new PostgresNotificationBus('postgres://test', createClient);

    await bus.subscribe('scrape:progress', vi.fn());
    await new Promise(resolve => setTimeout(resolve, 1100));

    expect(createClient).toHaveBeenCalledTimes(2);
    await bus.disconnect();
  }, 3000);

  it('closes a listener when it reports an error', async () => {
    const fixture = clientFixture();
    const bus = new PostgresNotificationBus('postgres://test', () => fixture.client);

    await bus.subscribe('scrape:progress', vi.fn());
    fixture.listeners.get('error')!(new Error('connection lost'));

    expect(fixture.client.end).toHaveBeenCalledOnce();
    await bus.disconnect();
  });

  it('does not issue LISTEN when the initial connection is unavailable', async () => {
    const fixture = clientFixture();
    fixture.client.connect = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const bus = new PostgresNotificationBus('postgres://test', () => fixture.client);

    await bus.subscribe('scrape:progress', vi.fn());

    expect(fixture.client.query).not.toHaveBeenCalled();
    await bus.disconnect();
  });

  it('keeps retrying when a reconnect attempt fails', async () => {
    const first = clientFixture();
    const failedReconnect = clientFixture();
    failedReconnect.client.connect = vi.fn().mockRejectedValue(new Error('still unavailable'));
    const createClient = vi.fn()
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(failedReconnect.client);
    const bus = new PostgresNotificationBus('postgres://test', createClient);

    await bus.subscribe('scrape:progress', vi.fn());
    first.listeners.get('end')!();
    await new Promise(resolve => setTimeout(resolve, 1100));
    await bus.disconnect();

    expect(createClient).toHaveBeenCalledTimes(2);
  }, 3000);

  it('does not reconnect after an explicit disconnect', async () => {
    const { client, listeners } = clientFixture();
    const createClient = vi.fn().mockReturnValue(client);
    const bus = new PostgresNotificationBus('postgres://test', createClient);

    await bus.subscribe('scrape:progress', vi.fn());
    await bus.disconnect();
    listeners.get('end')!();
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(createClient).toHaveBeenCalledOnce();
  });

  it('can disconnect before a listener is connected', async () => {
    const bus = new PostgresNotificationBus('postgres://test', vi.fn());

    await expect(bus.disconnect()).resolves.toBeUndefined();
  });

  it('ignores stale listener end events', async () => {
    const fixture = clientFixture();
    const bus = new PostgresNotificationBus('postgres://test', () => fixture.client);

    await bus.subscribe('scrape:progress', vi.fn());
    await bus.disconnect();
    fixture.listeners.get('end')!();

    expect(fixture.client.end).toHaveBeenCalledOnce();
  });
});

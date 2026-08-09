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
});

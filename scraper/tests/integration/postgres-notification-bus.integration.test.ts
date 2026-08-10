import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NOTIFICATION_CHANNELS } from '@movie-planner/scraper-protocol';
import { PostgresNotificationBus } from '../../src/bus/postgres-notification-bus.js';

const TEST_URL = process.env.PG_QUEUE_TEST_URL ?? process.env.PG_INIT_TEST_URL;

/** Resolve once `predicate` is true or reject after the timeout. */
function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error('Timed out waiting for notification delivery'));
      }
      setTimeout(check, 20);
    };
    check();
  });
}

/** Access the current listener client; null when the bus is disconnected. */
function listenerClient(bus: PostgresNotificationBus): { end(): Promise<void> } | null {
  return (bus as unknown as { client: { end(): Promise<void> } | null }).client;
}

describe.runIf(Boolean(TEST_URL))('Postgres notification bus integration', () => {
  let publisher: PostgresNotificationBus;
  let subscriber: PostgresNotificationBus;

  beforeAll(() => {
    publisher = new PostgresNotificationBus(TEST_URL);
    subscriber = new PostgresNotificationBus(TEST_URL);
  });

  afterAll(async () => {
    await Promise.all([publisher?.disconnect(), subscriber?.disconnect()]);
  });

  it('delivers a payload published after LISTEN to a live subscriber', async () => {
    let received: string | undefined;
    await subscriber.subscribe(NOTIFICATION_CHANNELS.progress, (payload) => {
      received = payload;
    });

    await publisher.publish(
      NOTIFICATION_CHANNELS.progress,
      '{"type":"started","total_theaters":1,"total_dates":1}',
    );

    await waitFor(() => received !== undefined);
    expect(received).toBe('{"type":"started","total_theaters":1,"total_dates":1}');
  });

  it('reconnects and re-delivers after the listener connection drops', async () => {
    let received: string | undefined;
    await subscriber.subscribe(NOTIFICATION_CHANNELS.scheduleChanged, (payload) => {
      received = payload;
    });

    // Drop the underlying listener connection; the bus must reconnect and
    // re-issue LISTEN for its subscribed channels before delivering again.
    const firstClient = listenerClient(subscriber);
    expect(firstClient).not.toBeNull();
    await firstClient!.end();

    await waitFor(() => listenerClient(subscriber) !== null && listenerClient(subscriber) !== firstClient);

    await publisher.publish(NOTIFICATION_CHANNELS.scheduleChanged, '{"action":"deleted","scheduleId":1}');
    await waitFor(() => received !== undefined);
    expect(received).toBe('{"action":"deleted","scheduleId":1}');
  });
});

import pg from 'pg';
import {
  NOTIFICATION_CHANNELS,
  pgConnectionConfig,
  type NotificationBus,
  type NotificationChannel,
} from '@movie-planner/scraper-protocol';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// PostgresNotificationBus — the PostgreSQL LISTEN/NOTIFY implementation of the
// `NotificationBus` port (issue #25, ADR 0009). It replaces the Redis pub/sub
// delegate in `PostgresBusConsumer`: the worker publishes progress and
// subscribes to schedule-change nudges over Postgres, the single stateful
// component.
//
// Delivery is ephemeral by design — a notification is dropped when no process
// listens, and a freshly-connected listener never receives historical events.
// PostgreSQL caps notification payloads at 8000 bytes; `publish` rejects
// anything larger. If a future payload legitimately exceeds the cap, switch to
// a notify-with-row-id-then-fetch pattern (the durable outcome already lives
// in a table row in every current use case).
// ---------------------------------------------------------------------------

const MAX_NOTIFICATION_BYTES = 8000;
const RECONNECT_DELAY_MS = 1000;

const VALID_CHANNELS = new Set<string>(Object.values(NOTIFICATION_CHANNELS));

function assertChannel(channel: string): asserts channel is NotificationChannel {
  if (!VALID_CHANNELS.has(channel)) {
    throw new Error(`Unsupported notification channel: ${channel}`);
  }
}

/** Minimal `pg.Client` surface the bus needs; injectable so tests can fake it. */
export type NotificationClient = Pick<pg.Client, 'connect' | 'query' | 'end'> & {
  on: pg.Client['on'];
};

export type NotificationClientFactory = (connectionString?: string) => NotificationClient;

/** Build a client from the same env the app uses (DATABASE_URL wins). */
export function defaultNotificationClientFactory(connectionString?: string): NotificationClient {
  return new pg.Client(connectionString ? { connectionString } : pgConnectionConfig());
}

export class PostgresNotificationBus implements NotificationBus {
  private client: NotificationClient | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connecting: Promise<void> | undefined;
  private readonly handlers = new Map<NotificationChannel, Set<(payload: string) => void>>();

  constructor(
    private readonly connectionString = process.env.DATABASE_URL,
    private readonly createClient: NotificationClientFactory = defaultNotificationClientFactory,
  ) {}

  /** Publish a payload to a channel. Never durable — see module header. */
  async publish(channel: NotificationChannel, payload: string): Promise<void> {
    assertChannel(channel);
    if (Buffer.byteLength(payload, 'utf8') > MAX_NOTIFICATION_BYTES) {
      throw new Error(`PostgreSQL notification payload exceeds ${MAX_NOTIFICATION_BYTES} bytes`);
    }

    // A short-lived dedicated connection per publish: NOTIFY does not survive
    // transaction rollback and needs no shared state, so reuse buys nothing.
    const client = this.createClient(this.connectionString);
    try {
      await client.connect();
      await client.query('SELECT pg_notify($1, $2)', [channel, payload]);
    } finally {
      await client.end();
    }
  }

  /** Register a listener; delivery of future payloads is ephemeral. */
  async subscribe(channel: NotificationChannel, handler: (payload: string) => void): Promise<void> {
    assertChannel(channel);

    let channelHandlers = this.handlers.get(channel);
    if (!channelHandlers) {
      channelHandlers = new Set();
      this.handlers.set(channel, channelHandlers);
    }
    channelHandlers.add(handler);

    if (!this.client) {
      try {
        await this.connect();
      } catch (error) {
        // Do not fail the caller on an unreachable database: the handler is
        // registered and the reconnect loop (or the next subscribe) will pick
        // it up once Postgres is reachable.
        logger.error('[PostgresNotificationBus] Listener connection failed', error);
        this.scheduleReconnect();
      }
    }
    if (this.client) {
      await this.client.query(`LISTEN "${channel}"`);
    }
  }

  /** Tear down the listener connection and stop reconnecting (graceful shutdown). */
  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const client = this.client;
    this.client = null;
    if (client) await client.end();
  }

  private async connect(): Promise<void> {
    // Serialize concurrent (re)connect attempts to one in-flight open.
    if (this.connecting) return this.connecting;
    this.connecting = this.openConnection();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async openConnection(): Promise<void> {
    const client = this.createClient(this.connectionString);

    client.on('notification', (message: { channel?: string; payload?: string }) => {
      const handlers = this.handlers.get(message.channel as NotificationChannel);
      if (!handlers || message.payload === undefined) return;
      for (const handler of handlers) {
        try {
          handler(message.payload);
        } catch (error) {
          logger.error('[PostgresNotificationBus] Notification handler failed', error);
        }
      }
    });

    client.on('error', (error: Error) => {
      logger.error('[PostgresNotificationBus] Listener error', error);
      if (this.client === client) this.client = null;
      void client.end().catch(() => {});
      this.scheduleReconnect();
    });

    client.on('end', () => {
      if (this.client !== client) return;
      this.client = null;
      this.scheduleReconnect();
    });

    await client.connect();
    this.client = client;
    // Re-issue LISTEN for every channel that has handlers — this is what
    // restores subscriptions after a reconnect.
    for (const channel of this.handlers.keys()) {
      await client.query(`LISTEN "${channel}"`);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.handlers.size === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((error) => {
        logger.error('[PostgresNotificationBus] Reconnect failed', error);
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }
}

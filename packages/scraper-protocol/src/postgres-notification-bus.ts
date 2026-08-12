import { NOTIFICATION_CHANNELS } from './notifications.js';
import type { NotificationBus, NotificationChannel } from './notifications.js';

// ---------------------------------------------------------------------------
// BasePostgresNotificationBus — the PostgreSQL LISTEN/NOTIFY implementation of
// the `NotificationBus` port (issue #25, ADR 0009). Shared between the `web`
// and `worker` roles so the connect/subscribe/publish/reconnect lifecycle
// lives in one place instead of being copied across workspaces.
//
// Delivery is ephemeral by design — a notification is dropped when no process
// listens, and a freshly-connected listener never receives historical events.
// PostgreSQL caps notification payloads at 8000 bytes; `publish` rejects
// anything larger. If a future payload legitimately exceeds the cap, switch to
// a notify-with-row-id-then-fetch pattern (the durable outcome already lives
// in a table row in every current use case).
//
// This module has no `pg` dependency: the client surface is the structural
// `NotificationClient` interface, and each role supplies a factory plus its
// own logger via a thin subclass (see `server/.../postgres-notification-bus.ts`
// and `scraper/.../postgres-notification-bus.ts`).
// ---------------------------------------------------------------------------

const MAX_NOTIFICATION_BYTES = 8000;
const RECONNECT_DELAY_MS = 1000;

const VALID_CHANNELS = new Set<string>(Object.values(NOTIFICATION_CHANNELS));

function assertChannel(channel: string): asserts channel is NotificationChannel {
  if (!VALID_CHANNELS.has(channel)) {
    throw new Error(`Unsupported notification channel: ${channel}`);
  }
}

/**
 * Minimal `pg.Client` surface the bus drives. Structural so this module needs
 * no `pg` dependency; the concrete factory in each workspace returns a real
 * `pg.Client`, which satisfies this shape. Injectable so tests can fake it.
 */
export interface NotificationClient {
  connect(): Promise<unknown>;
  query(text: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: 'notification', listener: (message: { channel?: string; payload?: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export type NotificationClientFactory = (connectionString?: string) => NotificationClient;

/** Logger surface the bus calls into; each role passes its own `utils/logger`. */
export interface NotificationLogger {
  error(message: string, meta?: unknown): void;
}

/**
 * PostgreSQL LISTEN/NOTIFY backend for the `NotificationBus` port. Subclassed
 * per role to bind a logger and a `pg.Client` factory; the lifecycle, publish
 * path, reconnect, and shutdown logic all live here.
 */
export class BasePostgresNotificationBus implements NotificationBus {
  private client: NotificationClient | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connecting: Promise<void> | undefined;
  private readonly handlers = new Map<NotificationChannel, Set<(payload: string) => void>>();

  constructor(
    private readonly logger: NotificationLogger,
    private readonly createClient: NotificationClientFactory,
    private readonly connectionString: string | undefined = process.env.DATABASE_URL,
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
        this.logger.error('[PostgresNotificationBus] Listener connection failed', error);
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
          this.logger.error('[PostgresNotificationBus] Notification handler failed', error);
        }
      }
    });

    client.on('error', (error: Error) => {
      this.logger.error('[PostgresNotificationBus] Listener error', error);
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
        this.logger.error('[PostgresNotificationBus] Reconnect failed', error);
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }
}

import pg from 'pg';
import { NOTIFICATION_CHANNELS, type NotificationBus, type NotificationChannel } from '@movie-planner/scraper-protocol';
import { logger } from '../utils/logger.js';

const MAX_NOTIFICATION_BYTES = 8000;
const VALID_CHANNELS = new Set<string>(Object.values(NOTIFICATION_CHANNELS));

function assertChannel(channel: string): asserts channel is NotificationChannel {
  if (!VALID_CHANNELS.has(channel)) throw new Error(`Unsupported notification channel: ${channel}`);
}

type NotificationClient = Pick<pg.Client, 'connect' | 'query' | 'end'> & { on: pg.Client['on'] };

function createClient(connectionString?: string): NotificationClient {
  return new pg.Client(connectionString ? { connectionString } : {
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || 'movie_planner',
  });
}

export class PostgresNotificationBus implements NotificationBus {
  private client: NotificationClient | null = null;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private connecting?: Promise<void>;
  private readonly handlers = new Map<NotificationChannel, Set<(payload: string) => void>>();

  constructor(private readonly connectionString = process.env.DATABASE_URL) {}

  async publish(channel: NotificationChannel, payload: string): Promise<void> {
    assertChannel(channel);
    if (Buffer.byteLength(payload, 'utf8') > MAX_NOTIFICATION_BYTES) {
      throw new Error(`PostgreSQL notification payload exceeds ${MAX_NOTIFICATION_BYTES} bytes`);
    }
    const client = createClient(this.connectionString);
    try {
      await client.connect();
      await client.query('SELECT pg_notify($1, $2)', [channel, payload]);
    } finally {
      await client.end();
    }
  }

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
        logger.error('[PostgresNotificationBus] Initial listener connection failed', error);
        this.scheduleReconnect();
      }
    }
    if (!this.client) return;
    await this.client!.query(`LISTEN "${channel}"`);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const client = this.client;
    this.client = null;
    if (client) await client.end();
  }

  private async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.openConnection();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async openConnection(): Promise<void> {
    const client = createClient(this.connectionString);
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
    for (const subscribedChannel of this.handlers.keys()) await client.query(`LISTEN "${subscribedChannel}"`);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.handlers.size === 0) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.connect();
      } catch (error) {
        logger.error('[PostgresNotificationBus] Reconnect failed', error);
        this.scheduleReconnect();
      }
    }, 1000);
  }
}

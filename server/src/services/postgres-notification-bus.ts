import pg from 'pg';
import {
  BasePostgresNotificationBus,
  pgConnectionConfig,
  type NotificationClient,
  type NotificationClientFactory,
} from '@movie-planner/scraper-protocol';
import { logger } from '../utils/logger.js';

export type { NotificationClient, NotificationClientFactory };

// ---------------------------------------------------------------------------
// PostgresNotificationBus — the `web` role's LISTEN/NOTIFY backend (issue #25,
// ADR 0009). It provides the notification backend used by `PostgresBusProducer`:
// progress fan-out and schedule-change nudges travel over Postgres, the single
// stateful component. The connect/subscribe/publish/reconnect lifecycle lives
// in the shared `BasePostgresNotificationBus`; this subclass binds the server
// logger and the `pg.Client` factory the base needs.
// ---------------------------------------------------------------------------

/**
 * Build a client from the same env the app uses (DATABASE_URL wins). The real
 * `pg.Client` satisfies the base's structural `NotificationClient` surface.
 */
export function defaultNotificationClientFactory(connectionString?: string): NotificationClient {
  return new pg.Client(connectionString ? { connectionString } : pgConnectionConfig());
}

export class PostgresNotificationBus extends BasePostgresNotificationBus {
  constructor(
    connectionString: string | undefined = process.env.DATABASE_URL,
    createClient: NotificationClientFactory = defaultNotificationClientFactory,
  ) {
    super(logger, createClient, connectionString);
  }
}

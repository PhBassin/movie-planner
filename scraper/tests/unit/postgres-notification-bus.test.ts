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

describe('PostgresNotificationBus (worker role adapter)', () => {
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

  describe('subclass wiring', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('binds the worker logger and factory to the shared base', async () => {
      // A factory whose client fails to connect exercises the base's
      // subscribe error path, which logs through the bound logger. Seeing the
      // mocked *workspace* logger called proves the subclass wired it through.
      const failingClient = {
        connect: vi.fn().mockRejectedValue(new Error('db down')),
        query: vi.fn().mockResolvedValue({ rows: [] }),
        end: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
      } as unknown as NotificationClient;
      const factory = vi.fn(() => failingClient) as unknown as NotificationClientFactory;
      const bus = new PostgresNotificationBus('postgres://test', factory);

      await expect(bus.subscribe(NOTIFICATION_CHANNELS.progress, vi.fn())).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Listener connection failed'),
        expect.anything(),
      );
    });
  });
});

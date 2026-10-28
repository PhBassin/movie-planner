import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runMigrations } from '../db/migrations.js';
import type { DB } from '../db/index.js';
import { SelectionService } from './selection-service.js';
import { getSelectionForExport } from '../db/selection-queries.js';
import { listMemberSubmissionsByTheater } from '../db/submission-queries.js';
import { rememberedChoicesCountAsActive } from '../billing/entitlement.js';

// Real-PostgreSQL integration test for the freemium Selection policy (issue
// #97, ADR 0011): the existing-member upgrade (D6), the Member lock under
// concurrent adds, and the Subscription-derived Entitlement (D1). Gated on a
// privileged Postgres URL; it creates and drops its own database.
const TEST_URL = process.env.PG_INIT_TEST_URL ?? process.env.PG_QUEUE_TEST_URL;
const TEST_DB_NAME = 'movie_planner_selection_test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INIT_SQL_PATH = join(__dirname, '../../../docker/init.sql');

function urlForDb(url: string, dbName: string): string {
  return url.replace(/\/[^/]*$/, `/${dbName}`);
}

function makeDb(pool: pg.Pool): DB {
  return {
    query: (text: string, params?: unknown[]) => pool.query(text, params),
    transaction: async <T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  } as unknown as DB;
}

describe.runIf(Boolean(TEST_URL))('Freemium Selection policy (PostgreSQL)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let db: DB;
  let memberSeq = 0;

  async function createMember(): Promise<number> {
    memberSeq += 1;
    const email = `quota${memberSeq}@example.com`;
    const result = await pool.query<{ id: number }>(
      `INSERT INTO users (username, email, password_hash, role_id, status)
       VALUES ($1, $1, 'x', (SELECT id FROM roles WHERE name = 'member'), 'active')
       RETURNING id`,
      [email],
    );
    return result.rows[0].id;
  }

  async function createTheaters(prefix: string, count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);
    for (const id of ids) {
      await pool.query(`INSERT INTO theaters (id, name, status) VALUES ($1, $1, 'active')`, [id]);
    }
    return ids;
  }

  async function select(memberId: number, theaterIds: string[], active = true): Promise<void> {
    for (const id of theaterIds) {
      await pool.query(
        'INSERT INTO member_selections (member_id, theater_id, active) VALUES ($1, $2, $3)',
        [memberId, id, active],
      );
    }
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: TEST_URL });
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await adminPool.query(`CREATE DATABASE ${TEST_DB_NAME}`);
    pool = new pg.Pool({ connectionString: urlForDb(TEST_URL!, TEST_DB_NAME), max: 10 });
    db = makeDb(pool);
    await pool.query(await readFile(INIT_SQL_PATH, 'utf8'));
  }, 60000);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await adminPool?.end();
  }, 60000);

  it('upgrade: a pre-#97 Member above 3 choices keeps every choice, active, after migrations (D6)', async () => {
    // Roll the schema back to its pre-#97 shape, with an existing Member at 5 choices.
    await pool.query('ALTER TABLE member_selections DROP COLUMN active');
    await pool.query('DROP TABLE subscriptions');
    const memberId = await createMember();
    const theaters = await createTheaters('U', 5);
    for (const id of theaters) {
      await pool.query('INSERT INTO member_selections (member_id, theater_id) VALUES ($1, $2)', [memberId, id]);
    }

    await runMigrations(db);
    await runMigrations(db); // idempotent

    const rows = await pool.query<{ theater_id: string; active: boolean }>(
      'SELECT theater_id, active FROM member_selections WHERE member_id = $1 ORDER BY theater_id',
      [memberId],
    );
    expect(rows.rows).toEqual(theaters.map((theater_id) => ({ theater_id, active: true })));

    // Billing disabled (production): unchanged behavior, 50 for everyone.
    vi.stubEnv('BILLING_PROVIDER', 'disabled');
    const service = new SelectionService(db);
    await expect(service.usage(memberId)).resolves.toEqual(expect.objectContaining({
      offer: null, activeCount: 5, selectionQuota: 50, overQuota: false,
    }));
    await expect(service.projection(memberId)).resolves.toEqual({ overQuota: false, theaterIds: theaters });

    // Billing enabled: derived over-quota state, nothing deactivated (D3).
    vi.stubEnv('BILLING_PROVIDER', 'fake');
    await expect(service.usage(memberId)).resolves.toEqual(expect.objectContaining({
      offer: 'free', activeCount: 5, selectionQuota: 3, overQuota: true,
    }));
    await expect(service.projection(memberId)).resolves.toEqual({ overQuota: true });
    const after = await pool.query('SELECT 1 FROM member_selections WHERE member_id = $1 AND active', [memberId]);
    expect(after.rows).toHaveLength(5);
  });

  it('concurrent adds never exceed the free quota', async () => {
    vi.stubEnv('BILLING_PROVIDER', 'fake');
    const memberId = await createMember();
    const [kept, ...candidates] = await createTheaters('C', 9);
    await select(memberId, [kept]);
    const service = new SelectionService(db);

    const results = await Promise.allSettled(candidates.map((id) => service.add(memberId, id)));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    for (const rejected of results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) {
      expect(rejected.reason).toEqual(expect.objectContaining({ statusCode: 409 }));
    }
    const count = await pool.query('SELECT 1 FROM member_selections WHERE member_id = $1', [memberId]);
    expect(count.rows).toHaveLength(3);
  });

  it('derives premium from a paid-through Subscription and loses it at the boundary (D1)', async () => {
    vi.stubEnv('BILLING_PROVIDER', 'fake');
    const memberId = await createMember();
    const theaters = await createTheaters('P', 5);
    await select(memberId, theaters.slice(0, 3));
    const service = new SelectionService(db);

    await expect(service.add(memberId, theaters[3])).rejects.toEqual(expect.objectContaining({ statusCode: 409 }));

    const sub = await pool.query<{ id: number }>(
      `INSERT INTO subscriptions (member_id, status, paid_through)
       VALUES ($1, 'active', NOW() + INTERVAL '30 days') RETURNING id`,
      [memberId],
    );
    await expect(service.add(memberId, theaters[3])).resolves.toEqual(expect.objectContaining({ id: theaters[3] }));
    await expect(service.usage(memberId)).resolves.toEqual(expect.objectContaining({ offer: 'premium', overQuota: false }));

    // The paid-through instant passes: free again, over quota, no write needed.
    await pool.query(`UPDATE subscriptions SET paid_through = NOW() - INTERVAL '1 second' WHERE id = $1`, [sub.rows[0].id]);
    await expect(service.usage(memberId)).resolves.toEqual(expect.objectContaining({
      offer: 'free', activeCount: 4, overQuota: true,
    }));
    await expect(service.add(memberId, theaters[4])).rejects.toEqual(expect.objectContaining({ statusCode: 409 }));
  });

  it('activates a remembered choice within quota and keeps it out of the projection otherwise', async () => {
    vi.stubEnv('BILLING_PROVIDER', 'fake');
    const memberId = await createMember();
    const theaters = await createTheaters('R', 4);
    await select(memberId, theaters.slice(0, 2));
    await select(memberId, theaters.slice(2), false);
    const service = new SelectionService(db);

    await expect(service.projection(memberId)).resolves.toEqual({ overQuota: false, theaterIds: theaters.slice(0, 2) });

    await service.add(memberId, theaters[2]);
    await expect(service.add(memberId, theaters[3])).rejects.toEqual(expect.objectContaining({ statusCode: 409 }));

    const rows = await pool.query<{ theater_id: string; active: boolean }>(
      'SELECT theater_id, active FROM member_selections WHERE member_id = $1 ORDER BY theater_id',
      [memberId],
    );
    expect(rows.rows.map((r) => r.active)).toEqual([true, true, true, false]);
  });

  it('reads one effective active state everywhere: list, projection, "Mes soumissions" and export (D6)', async () => {
    const memberId = await createMember();
    const [active, remembered] = await createTheaters('E', 2);
    await select(memberId, [active]);
    await select(memberId, [remembered], false);
    const report = await pool.query<{ id: number }>(
      `INSERT INTO scrape_reports (started_at, status, trigger_type) VALUES (NOW(), 'success', 'manual') RETURNING id`,
    );
    for (const id of [active, remembered]) {
      await pool.query(
        `INSERT INTO theater_submissions (member_id, url, theater_id, status, report_id)
         VALUES ($1, $2, $3, 'succeeded', $4)`,
        [memberId, `https://www.allocine.fr/seance/salle_gen_csalle=${id}.html`, id, report.rows[0].id],
      );
    }
    const service = new SelectionService(db);
    const read = async () => {
      const view = { rememberedCountsAsActive: rememberedChoicesCountAsActive() };
      const submissions = await listMemberSubmissionsByTheater(pool, memberId, { limit: 10, offset: 0 }, view);
      return {
        list: (await service.list(memberId)).map((c) => [c.id, c.active]),
        projection: await service.projection(memberId),
        inSelection: submissions.rows.map((r) => [r.theater_id, r.in_selection]).sort(),
        exported: (await getSelectionForExport(pool, memberId, view)).map((r) => [r.theater_id, r.active]),
      };
    };

    vi.stubEnv('BILLING_PROVIDER', 'fake');
    await expect(read()).resolves.toEqual({
      list: [[active, true], [remembered, false]],
      projection: { overQuota: false, theaterIds: [active] },
      inSelection: [[active, true], [remembered, false]],
      exported: [[active, true], [remembered, false]],
    });

    vi.stubEnv('BILLING_PROVIDER', 'disabled');
    await expect(read()).resolves.toEqual({
      list: [[active, true], [remembered, true]],
      projection: { overQuota: false, theaterIds: [active, remembered] },
      inSelection: [[active, true], [remembered, true]],
      exported: [[active, true], [remembered, true]],
    });
  });

  it('allows at most one non-terminal Subscription per Member and cascades on erasure', async () => {
    const memberId = await createMember();
    await pool.query(`INSERT INTO subscriptions (member_id, status, paid_through) VALUES ($1, 'ended', NOW())`, [memberId]);
    await pool.query(`INSERT INTO subscriptions (member_id, status, paid_through) VALUES ($1, 'active', NOW())`, [memberId]);
    await expect(
      pool.query(`INSERT INTO subscriptions (member_id, status, paid_through) VALUES ($1, 'past_due', NOW())`, [memberId]),
    ).rejects.toThrow();

    await pool.query('DELETE FROM users WHERE id = $1', [memberId]);
    const left = await pool.query('SELECT 1 FROM subscriptions WHERE member_id = $1', [memberId]);
    expect(left.rows).toHaveLength(0);
  });
});

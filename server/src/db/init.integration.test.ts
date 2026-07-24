import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runMigrations } from './migrations.js';
import { ensureInitialAdmin } from './admin-bootstrap.js';

// Real-PostgreSQL integration test for the consolidated baseline.
//
// Gated on PG_INIT_TEST_URL so it does not run in the normal unit suite. Set it
// to a privileged connection string (e.g. postgres://postgres:postgres@localhost:5432/postgres)
// to exercise this against a local PostgreSQL. CI provides one in PR 6 / the
// full verification suite.
const TEST_URL = process.env.PG_INIT_TEST_URL;
const TEST_DB_NAME = 'movie_planner_init_test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INIT_SQL_PATH = join(__dirname, '../../../docker/init.sql');

// Lightweight DB wrapper exposing the query() shape the app modules use.
function makeDb(pool: pg.Pool) {
  return {
    query: <T extends pg.QueryResultRow = any>(
      text: string,
      params?: any[]
    ) => pool.query<T>(text, params),
  } as any;
}

// Replace the database name in a postgres URL path.
function urlForDb(url: string, dbName: string): string {
  return url.replace(/\/[^/]*$/, `/${dbName}`);
}

// Skip entirely when no privileged Postgres URL is provided.
describe.runIf(Boolean(TEST_URL))(
  'PostgreSQL baseline (docker/init.sql) integration',
  () => {
    let adminPool: pg.Pool;
    let testPool: pg.Pool;
    let db: ReturnType<typeof makeDb>;

    beforeAll(async () => {
      adminPool = new pg.Pool({ connectionString: TEST_URL });

      // Start from a clean slate.
      await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
      await adminPool.query(`CREATE DATABASE ${TEST_DB_NAME}`);

      testPool = new pg.Pool({ connectionString: urlForDb(TEST_URL!, TEST_DB_NAME) });
      db = makeDb(testPool);

      // Apply the consolidated baseline exactly as Docker / db:init would.
      const sql = await readFile(INIT_SQL_PATH, 'utf8');
      await testPool.query(sql);
    }, 60000);

    afterAll(async () => {
      await testPool?.end();
      // Drop the test database from the maintenance connection.
      await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
      await adminPool?.end();
    }, 60000);

    it('creates all core tables', async () => {
      const result = await db.query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);
      const tables = result.rows.map((r) => r.table_name);
      for (const expected of [
        'theaters', 'movies', 'showtimes', 'weekly_programs',
        'users', 'roles', 'permissions', 'role_permissions',
        'app_settings', 'rate_limit_configs', 'rate_limit_audit_log',
        'scrape_schedules', 'scrape_reports', 'scrape_attempts',
        'refresh_tokens', 'permission_category_labels', 'schema_migrations',
      ]) {
        expect(tables, `missing table ${expected}`).toContain(expected);
      }
    });

    it('enables the pg_trgm extension and the movie-title trigram index', async () => {
      const ext = await db.query<{ extname: string }>(
        `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`
      );
      expect(ext.rows).toHaveLength(1);

      const idx = await db.query(
        `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_movies_title_trgm'`
      );
      expect(idx.rows).toHaveLength(1);
    });

    it('preserves the showtime deduplication business-key constraint', async () => {
      const result = await db.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'uq_showtimes_business_key'`
      );
      expect(result.rows).toHaveLength(1);
    });

    it('preserves the scrape_reports status check (includes rate_limited)', async () => {
      const result = await db.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'scrape_reports_status_check'`
      );
      expect(result.rows).toHaveLength(1);
      await expect(
        db.query(`INSERT INTO scrape_reports (started_at, status, trigger_type) VALUES (NOW(), 'bogus', 'manual')`)
      ).rejects.toThrow();
    });

    it('enforces singleton constraints on app_settings and rate_limit_configs', async () => {
      const result = await db.query<{ conname: string }>(`
        SELECT conname FROM pg_constraint
        WHERE conname = 'singleton_check'
        AND conrelid IN ('app_settings'::regclass, 'rate_limit_configs'::regclass)
      `);
      expect(result.rows).toHaveLength(2);
    });

    it('seeds the two system roles', async () => {
      const result = await db.query<{ name: string; is_system: boolean }>(
        `SELECT name, is_system FROM roles WHERE is_system = true ORDER BY name`
      );
      expect(result.rows.map((r) => r.name)).toEqual(['admin', 'operator']);
    });

    it('seeds the canonical permission set', async () => {
      const result = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM permissions`);
      expect(parseInt(result.rows[0].count, 10)).toBe(34);

      for (const name of [
        'users:read', 'theaters:read', 'roles:read', 'roles:list',
        'scraper:schedules:list', 'ratelimits:audit',
      ]) {
        const perm = await db.query(`SELECT 1 FROM permissions WHERE name = $1`, [name]);
        expect(perm.rows, `missing permission ${name}`).toHaveLength(1);
      }
    });

    it('grants the admin role every permission', async () => {
      const result = await db.query<{ count: string }>(`
        SELECT COUNT(*) as count
        FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id
        WHERE r.name = 'admin'
      `);
      expect(parseInt(result.rows[0].count, 10)).toBe(34);
    });

    it('grants the operator role the expected scoped permissions', async () => {
      const result = await db.query<{ count: string }>(`
        SELECT COUNT(*) as count
        FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id
        WHERE r.name = 'operator'
      `);
      // 2 scraper base + 4 schedule + 3 theaters write + theaters:read + users:read + 2 reports
      expect(parseInt(result.rows[0].count, 10)).toBe(13);
    });

    it('seeds the Movie Planner app_settings singleton with canonical defaults', async () => {
      const result = await db.query<{ site_name: string; email_from_name: string; email_from_address: string }>(
        `SELECT site_name, email_from_name, email_from_address FROM app_settings WHERE id = 1`
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].site_name).toBe('Movie Planner');
      expect(result.rows[0].email_from_name).toBe('Movie Planner');
      expect(result.rows[0].email_from_address).toBe('no-reply@movie-planner.local');
    });

    it('seeds the rate_limit_configs singleton and category labels', async () => {
      const rl = await db.query(`SELECT 1 FROM rate_limit_configs WHERE id = 1`);
      expect(rl.rows).toHaveLength(1);

      const labels = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM permission_category_labels`);
      expect(parseInt(labels.rows[0].count, 10)).toBe(9);
    });

    it('seeds the default weekly scrape schedule', async () => {
      const result = await db.query<{ name: string }>(
        `SELECT name FROM scrape_schedules WHERE name = 'Weekly Wednesday Scrape'`
      );
      expect(result.rows).toHaveLength(1);
    });

    it('leaves schema_migrations empty (baseline, no recorded migrations)', async () => {
      const result = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM schema_migrations`);
      expect(parseInt(result.rows[0].count, 10)).toBe(0);
    });

    it('migration runner succeeds with no pending files', async () => {
      await expect(runMigrations(db)).resolves.toBeUndefined();
      const result = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM schema_migrations`);
      expect(parseInt(result.rows[0].count, 10)).toBe(0);
    });

    it('bootstraps a secure initial administrator when none exists', async () => {
      await ensureInitialAdmin(db);

      const admin = await db.query<{ id: number; username: string; role_name: string; password_hash: string }>(`
        SELECT u.id, u.username, r.name AS role_name, u.password_hash
        FROM users u
        JOIN roles r ON r.id = u.role_id
        WHERE r.name = 'admin'
      `);
      expect(admin.rows).toHaveLength(1);
      expect(admin.rows[0].username).toBe('admin');
      expect(admin.rows[0].role_name).toBe('admin');
      expect(admin.rows[0].password_hash.startsWith('scrypt:')).toBe(true);
    });

    it('admin bootstrap is idempotent on subsequent runs', async () => {
      await ensureInitialAdmin(db);
      const result = await db.query<{ count: string }>(`
        SELECT COUNT(*) as count FROM users u
        JOIN roles r ON r.id = u.role_id WHERE r.name = 'admin'
      `);
      expect(parseInt(result.rows[0].count, 10)).toBe(1);
    });
  }
);

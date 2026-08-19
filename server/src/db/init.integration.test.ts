import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runMigrations } from './migrations.js';
import { ensureInitialAdmin } from './admin-bootstrap.js';
import { parseStrictInt } from '../utils/number.js';

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
        'scrape_jobs',
        'refresh_tokens', 'auth_email_tokens',
        'permission_category_labels', 'schema_migrations',
      ]) {
        expect(tables, `missing table ${expected}`).toContain(expected);
      }
    });

    it('carries the auth_email_tokens table (hashed, purpose-scoped tokens)', async () => {
      const cols = await db.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'auth_email_tokens'
        ORDER BY column_name
      `);
      expect(cols.rows.map((r) => r.column_name)).toEqual([
        'created_at', 'expires_at', 'id', 'purpose', 'token_hash', 'user_id',
      ]);

      // The purpose discriminator rejects unknown purposes.
      await expect(
        db.query(
          `INSERT INTO auth_email_tokens (user_id, purpose, token_hash, expires_at)
           VALUES (1, 'magic_link', 'x', NOW())`
        )
      ).rejects.toThrow();

      // Tokens cascade on user deletion.
      await db.query(
        `INSERT INTO users (username, email, password_hash, role_id, status)
         VALUES ('tok@example.com', 'tok@example.com', 'x', (SELECT id FROM roles WHERE name = 'member'), 'unverified')`
      );
      await db.query(
        `INSERT INTO auth_email_tokens (user_id, purpose, token_hash, expires_at)
         VALUES ((SELECT id FROM users WHERE email = 'tok@example.com'), 'email_verification', 'hash', NOW() + INTERVAL '30 minutes')`
      );
      await db.query(`DELETE FROM users WHERE email = 'tok@example.com'`);
      const leftover = await db.query(`SELECT 1 FROM auth_email_tokens`);
      expect(leftover.rows).toHaveLength(0);
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

    it('defines the theater provisioning lifecycle and active default', async () => {
      const columns = await db.query<{ column_default: string; is_nullable: string }>(`
        SELECT column_default, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'theaters' AND column_name = 'status'
      `);
      expect(columns.rows).toEqual([
        { column_default: "'provisioning'::text", is_nullable: 'NO' },
      ]);
      const check = await db.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'theaters_status_check'`
      );
      expect(check.rows).toHaveLength(1);
      await expect(
        db.query(`INSERT INTO theaters (id, name, status) VALUES ('invalid-status', 'Invalid', 'broken')`)
      ).rejects.toThrow();
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

    it('seeds the three system roles', async () => {
      const result = await db.query<{ name: string; is_system: boolean }>(
        `SELECT name, is_system FROM roles WHERE is_system = true ORDER BY name`
      );
      expect(result.rows.map((r) => r.name)).toEqual(['admin', 'member', 'operator']);
    });

    it('grants the member role no permissions', async () => {
      const result = await db.query<{ count: string }>(`
        SELECT COUNT(*) as count
        FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id
        WHERE r.name = 'member'
      `);
      expect(parseStrictInt(result.rows[0].count)).toBe(0);
    });

    it('carries the member columns and member_preferences table', async () => {
      const cols = await db.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name IN ('email', 'email_verified_at', 'status')
      `);
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
        'email', 'email_verified_at', 'status',
      ]);

      // Email is unique among Members only (Staff leave it NULL).
      await db.query(
        `INSERT INTO users (username, email, password_hash, role_id, status)
         VALUES ('m1@example.com', 'm1@example.com', 'x', (SELECT id FROM roles WHERE name = 'member'), 'unverified')`
      );
      await expect(
        db.query(
          `INSERT INTO users (username, email, password_hash, role_id, status)
           VALUES ('dup', 'M1@EXAMPLE.COM', 'x', (SELECT id FROM roles WHERE name = 'member'), 'unverified')`
        )
      ).rejects.toThrow();

      // The status discriminator rejects unknown states.
      await expect(
        db.query(
          `INSERT INTO users (username, password_hash, role_id, status)
           VALUES ('bogus', 'x', (SELECT id FROM roles WHERE name = 'member'), 'deleted')`
        )
      ).rejects.toThrow();

      // member_preferences cascades on member deletion.
      const pref = await db.query<{ appearance: string }>(`
        INSERT INTO member_preferences (member_id, appearance)
        VALUES ((SELECT id FROM users WHERE email = 'm1@example.com'), 'dark')
        RETURNING appearance
      `);
      expect(pref.rows[0].appearance).toBe('dark');
      await db.query(`DELETE FROM users WHERE email = 'm1@example.com'`);
      const leftover = await db.query(`SELECT 1 FROM member_preferences`);
      expect(leftover.rows).toHaveLength(0);
    });

    it('seeds the canonical permission set', async () => {
      const result = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM permissions`);
      expect(parseStrictInt(result.rows[0].count)).toBe(34);

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
      expect(parseStrictInt(result.rows[0].count)).toBe(34);
    });

    it('grants the operator role the expected scoped permissions', async () => {
      const result = await db.query<{ count: string }>(`
        SELECT COUNT(*) as count
        FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id
        WHERE r.name = 'operator'
      `);
      // 2 scraper base + 4 schedule + 3 theaters write + theaters:read + users:read + 2 reports
      expect(parseStrictInt(result.rows[0].count)).toBe(13);
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
      expect(parseStrictInt(labels.rows[0].count)).toBe(9);
    });

    it('seeds the default weekly scrape schedule', async () => {
      const result = await db.query<{ name: string }>(
        `SELECT name FROM scrape_schedules WHERE name = 'Weekly Wednesday Scrape'`
      );
      expect(result.rows).toHaveLength(1);
    });

    it('leaves schema_migrations empty (baseline, no recorded migrations)', async () => {
      const result = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM schema_migrations`);
      expect(parseStrictInt(result.rows[0].count)).toBe(0);
    });

    it('migration runner applies pending migrations and records them', async () => {
      await expect(runMigrations(db)).resolves.toBeUndefined();
      const result = await db.query<{ version: string }>(`
        SELECT version FROM schema_migrations ORDER BY version
      `);
       // 001 (scrape_jobs queue), 002 (auth_email_tokens), 003 (verification
       // rate-limit arm), 004 (password-reset rate-limit arms), and 005
       // (auth-email-token uniqueness) — all idempotent over the baseline.
      expect(result.rows.map((r) => r.version)).toEqual([
        '001_scrape_jobs_queue.sql',
        '002_auth_email_tokens.sql',
        '003_verification_rate_limit_arm.sql',
        '004_password_reset_rate_limit_arms.sql',
        '005_auth_email_token_uniqueness.sql',
      ]);

      // The queue table is present (created by the baseline; the migration is
      // idempotent so re-applying it over the baseline is a no-op).
      const table = await db.query(
        `SELECT 1 FROM pg_tables WHERE tablename = 'scrape_jobs'`
      );
      expect(table.rows).toHaveLength(1);

      const indexes = await db.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'scrape_jobs'
          AND indexname = 'idx_scrape_jobs_enqueued_at'
      `);
      expect(indexes.rows).toHaveLength(1);

      await expect(runMigrations(db)).resolves.toBeUndefined();
    });

    it('carries the verification rate-limit arm (baseline columns, register-shaped defaults)', async () => {
      const columns = await db.query<{ column_name: string; column_default: string }>(`
        SELECT column_name, column_default
        FROM information_schema.columns
        WHERE table_name = 'rate_limit_configs'
          AND column_name IN ('verification_max', 'verification_window_ms')
      `);
      expect(columns.rows.map((c) => c.column_name).sort()).toEqual([
        'verification_max',
        'verification_window_ms',
      ]);

      const row = await db.query<{ verification_max: number; verification_window_ms: number }>(`
        SELECT verification_max, verification_window_ms FROM rate_limit_configs WHERE id = 1
      `);
      expect(row.rows[0].verification_max).toBe(3);
      expect(row.rows[0].verification_window_ms).toBe(3600000);
    });

    it('carries both password-reset rate-limit arms with register-shaped defaults', async () => {
      const columns = await db.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'rate_limit_configs'
          AND column_name IN (
            'password_reset_max', 'password_reset_window_ms',
            'password_reset_email_max', 'password_reset_email_window_ms'
          )
      `);
      expect(columns.rows.map((c) => c.column_name).sort()).toEqual([
        'password_reset_email_max',
        'password_reset_email_window_ms',
        'password_reset_max',
        'password_reset_window_ms',
      ]);

      const row = await db.query<{
        password_reset_max: number;
        password_reset_window_ms: number;
        password_reset_email_max: number;
        password_reset_email_window_ms: number;
      }>(`
        SELECT password_reset_max, password_reset_window_ms,
               password_reset_email_max, password_reset_email_window_ms
        FROM rate_limit_configs WHERE id = 1
      `);
      expect(row.rows[0]).toEqual({
        password_reset_max: 3,
        password_reset_window_ms: 3600000,
        password_reset_email_max: 3,
        password_reset_email_window_ms: 3600000,
      });
    });

    it('enforces one live auth-email token per Member and purpose', async () => {
      const index = await db.query<{ indexname: string }>(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'auth_email_tokens'
          AND indexname = 'idx_auth_email_tokens_user_purpose'
      `);
      expect(index.rows).toHaveLength(1);
    });

    it('pins the mailer DEFAULT_FROM_* mirror to the Branding email_from_* baseline defaults', async () => {
      const { DEFAULT_FROM_NAME, DEFAULT_FROM_ADDRESS } = await import('../services/mailer.js');
      const branding = await db.query<{ email_from_name: string; email_from_address: string }>(`
        SELECT email_from_name, email_from_address FROM app_settings WHERE id = 1
      `);
      // The mailer's hardcoded sender fallback documents that it mirrors the
      // Branding defaults; this pins the mirror so a change to one side
      // without the other fails here instead of drifting silently.
      expect(branding.rows[0].email_from_name).toBe(DEFAULT_FROM_NAME);
      expect(branding.rows[0].email_from_address).toBe(DEFAULT_FROM_ADDRESS);
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
      expect(parseStrictInt(result.rows[0].count)).toBe(1);
    });
  }
);

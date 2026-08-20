-- Movie Planner — consolidated database baseline.
--
-- This file is the single reusable source of truth for initializing an empty
-- Movie Planner PostgreSQL database (canonical name: `movie_planner`). It is
-- mounted by the Docker postgres image on first startup and is also applied by
-- the host-side `npm run server:db:init` path for non-Docker development.
--
-- It consolidates the final state of the inherited initialization file and the
-- historical numbered migrations into one baseline. The application-level
-- migration runner (see `server/src/db/migrations.ts`) starts with an empty
-- `migrations/` directory after this baseline and tracks future changes
-- beginning at `001_*` in the `schema_migrations` table created below.
--
-- The application bootstrap — not this file — creates the initial administrator
-- with a securely generated random password. No static administrator credential
-- is placed in SQL.

-- ============================================================================
-- Extensions
-- ============================================================================

-- pg_trgm: trigram support for fuzzy movie-title search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================================
-- Identity, roles, permissions (RBAC)
-- ============================================================================

CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE permissions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  category TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- System roles.
INSERT INTO roles (name, description, is_system) VALUES
  ('admin', 'Full access', true),
  ('operator', 'Scraping and theater management', true),
  -- Member: the cinema-goer (see CONTEXT.md). System role with NO permissions
  -- granted below — a Member has no administrative reach by design.
  ('member', 'Self-registered cinema-goer', true);

-- Canonical permission set.
INSERT INTO permissions (name, description, category) VALUES
  ('users:list',                 'List users',                              'users'),
  ('users:create',               'Create users',                            'users'),
  ('users:update',               'Update users',                            'users'),
  ('users:delete',               'Delete users',                            'users'),
  ('users:read',                 'View user details',                       'users'),
  ('scraper:trigger',            'Trigger a global scrape',                 'scraper'),
  ('scraper:trigger_single',     'Trigger a scrape for one theater',        'scraper'),
  ('scraper:schedules:list',     'View scrape schedules',                   'scraper'),
  ('scraper:schedules:create',   'Create scrape schedules',                 'scraper'),
  ('scraper:schedules:update',   'Update scrape schedules',                 'scraper'),
  ('scraper:schedules:delete',   'Delete scrape schedules',                 'scraper'),
  ('theaters:create',            'Add a theater',                           'theaters'),
  ('theaters:update',            'Update a theater',                        'theaters'),
  ('theaters:delete',            'Delete a theater',                        'theaters'),
  ('theaters:read',              'View theaters list and details',          'theaters'),
  ('settings:read',              'Read admin settings',                     'settings'),
  ('settings:update',            'Update settings',                         'settings'),
  ('settings:reset',             'Reset settings to defaults',              'settings'),
  ('settings:export',            'Export settings',                         'settings'),
  ('settings:import',            'Import settings',                         'settings'),
  ('reports:list',               'List scrape reports',                     'reports'),
  ('reports:view',               'View a scrape report',                    'reports'),
  ('system:info',                'View system information',                 'system'),
  ('system:health',              'View system health',                      'system'),
  ('system:migrations',          'View database migrations',                'system'),
  ('roles:read',                 'View details of a role',                  'roles'),
  ('roles:list',                 'List roles',                              'roles'),
  ('roles:create',               'Create roles',                            'roles'),
  ('roles:update',               'Update roles and permissions',            'roles'),
  ('roles:delete',               'Delete roles',                            'roles'),
  ('ratelimits:read',            'View rate limit configurations',          'security'),
  ('ratelimits:update',          'Update rate limit configurations',        'security'),
  ('ratelimits:reset',           'Reset rate limit configurations',         'security'),
  ('ratelimits:audit',           'View rate limit change audit log',        'security');

-- Operator role: scraping, theater management, schedules, reports, read-only user/theater views.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.name IN (
  'scraper:trigger', 'scraper:trigger_single',
  'scraper:schedules:list', 'scraper:schedules:create',
  'scraper:schedules:update', 'scraper:schedules:delete',
  'theaters:create', 'theaters:update', 'theaters:delete', 'theaters:read',
  'reports:list', 'reports:view',
  'users:read'
)
WHERE r.name = 'operator'
ON CONFLICT DO NOTHING;

-- Admin role: every permission (admin also has an is_system bypass in code; the
-- explicit grants keep the database self-describing for tooling).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'admin' AND r.is_system = true
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Users
-- ============================================================================

-- Members identify by email, Staff by username (see CONTEXT.md). `username`
-- stays NOT NULL (Members get their email mirrored into it to satisfy the
-- shared-identity shape); `email` is the Member-facing identifier and is
-- unique among Members only — Staff rows leave it NULL (NULLs are distinct
-- in a unique index). `status` is the Member lifecycle discriminator
-- (unverified | active | suspended — "deleted" = row removed, see
-- CONTEXT.md); Staff rows carry 'active'.
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  email_verified_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('unverified', 'active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_users_email_member ON users(LOWER(email))
  WHERE email IS NOT NULL;
CREATE INDEX idx_users_role_id ON users(role_id);

-- ============================================================================
-- Member data (per-Member preferences; see CONTEXT.md → Appearance)
-- ============================================================================

CREATE TABLE member_preferences (
  member_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  appearance VARCHAR(10) NOT NULL DEFAULT 'light'
    CHECK (appearance IN ('light', 'dark'))
);

-- ============================================================================
-- Application settings (white-label, singleton)
-- ============================================================================

CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,

  -- Identity
  site_name TEXT NOT NULL DEFAULT 'Movie Planner',
  logo_base64 TEXT,
  favicon_base64 TEXT,

  -- Color palette (hex #RRGGBB)
  color_primary TEXT NOT NULL DEFAULT '#FECC00',
  color_secondary TEXT NOT NULL DEFAULT '#1F2937',
  color_accent TEXT NOT NULL DEFAULT '#F59E0B',
  color_background TEXT NOT NULL DEFAULT '#FFFFFF',
  color_surface TEXT NOT NULL DEFAULT '#F3F4F6',
  color_text_primary TEXT NOT NULL DEFAULT '#111827',
  color_text_secondary TEXT NOT NULL DEFAULT '#6B7280',
  color_success TEXT NOT NULL DEFAULT '#10B981',
  color_error TEXT NOT NULL DEFAULT '#EF4444',

  -- Typography
  font_primary TEXT NOT NULL DEFAULT 'Inter',
  font_secondary TEXT NOT NULL DEFAULT 'Roboto',

  -- Footer
  footer_text TEXT,
  footer_links JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Email branding
  email_from_name TEXT DEFAULT 'Movie Planner',
  email_from_address TEXT DEFAULT 'no-reply@movie-planner.local',

  -- Metadata
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id),

  CONSTRAINT singleton_check CHECK (id = 1)
);

INSERT INTO app_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE INDEX idx_app_settings_updated_at ON app_settings(updated_at);

-- ============================================================================
-- Rate limit configuration (singleton) + audit log
-- ============================================================================

CREATE TABLE rate_limit_configs (
  id INTEGER PRIMARY KEY DEFAULT 1,

  window_ms INTEGER NOT NULL DEFAULT 900000 CHECK (window_ms >= 60000 AND window_ms <= 3600000),

  general_max INTEGER NOT NULL DEFAULT 100 CHECK (general_max >= 10 AND general_max <= 1000),

  auth_max INTEGER NOT NULL DEFAULT 5 CHECK (auth_max >= 3 AND auth_max <= 50),

  register_max INTEGER NOT NULL DEFAULT 3 CHECK (register_max >= 1 AND register_max <= 20),
  register_window_ms INTEGER NOT NULL DEFAULT 3600000 CHECK (register_window_ms >= 300000 AND register_window_ms <= 86400000),

  -- Verification mail (verify-email link target + resend) rides its own arm
  -- (ADR 0006 sub-decision 6): register-shaped numbers, separate budget.
  verification_max INTEGER NOT NULL DEFAULT 3 CHECK (verification_max >= 1 AND verification_max <= 20),
  verification_window_ms INTEGER NOT NULL DEFAULT 3600000 CHECK (verification_window_ms >= 300000 AND verification_window_ms <= 86400000),

  -- Password reset uses separate per-IP and per-email budgets (ADR 0006).
  password_reset_max INTEGER NOT NULL DEFAULT 3 CHECK (password_reset_max >= 1 AND password_reset_max <= 20),
  password_reset_window_ms INTEGER NOT NULL DEFAULT 3600000 CHECK (password_reset_window_ms >= 300000 AND password_reset_window_ms <= 86400000),
  password_reset_email_max INTEGER NOT NULL DEFAULT 3 CHECK (password_reset_email_max >= 1 AND password_reset_email_max <= 20),
  password_reset_email_window_ms INTEGER NOT NULL DEFAULT 3600000 CHECK (password_reset_email_window_ms >= 300000 AND password_reset_email_window_ms <= 86400000),

  protected_max INTEGER NOT NULL DEFAULT 60 CHECK (protected_max >= 10 AND protected_max <= 500),

  scraper_max INTEGER NOT NULL DEFAULT 10 CHECK (scraper_max >= 5 AND scraper_max <= 100),

  public_max INTEGER NOT NULL DEFAULT 100 CHECK (public_max >= 20 AND public_max <= 1000),

  health_max INTEGER NOT NULL DEFAULT 10 CHECK (health_max >= 5 AND health_max <= 100),
  health_window_ms INTEGER NOT NULL DEFAULT 60000 CHECK (health_window_ms = 60000),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id),
  environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('development', 'staging', 'production')),

  CONSTRAINT singleton_check CHECK (id = 1)
);

CREATE TABLE rate_limit_audit_log (
  id SERIAL PRIMARY KEY,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  changed_by INTEGER NOT NULL REFERENCES users(id),
  changed_by_username TEXT NOT NULL,
  changed_by_role TEXT NOT NULL,
  field_name TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  user_ip TEXT,
  user_agent TEXT
);

INSERT INTO rate_limit_configs (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE INDEX idx_rate_limit_configs_updated_at ON rate_limit_configs(updated_at);
CREATE INDEX idx_rate_limit_audit_log_changed_at ON rate_limit_audit_log(changed_at DESC);
CREATE INDEX idx_rate_limit_audit_log_changed_by ON rate_limit_audit_log(changed_by);

-- ============================================================================
-- Permission category display labels
-- ============================================================================

CREATE TABLE permission_category_labels (
  id SERIAL PRIMARY KEY,
  category_key TEXT NOT NULL UNIQUE,
  label_en TEXT NOT NULL,
  label_fr TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_permission_category_labels_key ON permission_category_labels(category_key);

INSERT INTO permission_category_labels (category_key, label_en, label_fr) VALUES
  ('users',    'Users',     'Utilisateurs'),
  ('roles',    'Roles',     'Rôles'),
  ('scraper',  'Scraping',  'Scraping'),
  ('schedules','Schedules', 'Planification'),
  ('theaters', 'Theaters',  'Theaters'),
  ('settings', 'Settings',  'Paramètres'),
  ('reports',  'Reports',   'Rapports'),
  ('system',   'System',    'Système'),
  ('security', 'Security',  'Sécurité')
ON CONFLICT (category_key) DO NOTHING;

-- ============================================================================
-- Theaters and movies
-- ============================================================================

CREATE TABLE theaters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning', 'active')),
  address TEXT,
  postal_code TEXT,
  city TEXT,
  image_url TEXT,
  url TEXT,
  source VARCHAR(50) NOT NULL DEFAULT 'allocine'
);

-- Member Selection: references shared active Theaters, never a data copy.
CREATE TABLE member_selections (
  theater_id TEXT NOT NULL REFERENCES theaters(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (member_id, theater_id)
);

CREATE INDEX idx_member_selections_theater_id ON member_selections(theater_id);

CREATE TABLE movies (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  original_title TEXT,
  poster_url TEXT,
  duration_minutes INTEGER,
  release_date TEXT,
  rerelease_date TEXT,
  genres TEXT,
  nationality TEXT,
  director TEXT,
  screenwriters TEXT,
  actors TEXT,
  synopsis TEXT,
  certificate TEXT,
  press_rating REAL,
  audience_rating REAL,
  source_url TEXT NOT NULL,
  trailer_url TEXT
);

CREATE INDEX idx_movies_title_trgm ON movies USING gin(title gin_trgm_ops);

-- ============================================================================
-- Showtimes and weekly programs
-- ============================================================================

CREATE TABLE showtimes (
  id TEXT PRIMARY KEY,
  movie_id INTEGER NOT NULL REFERENCES movies(id),
  theater_id TEXT NOT NULL REFERENCES theaters(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  datetime_iso TEXT NOT NULL,
  version TEXT,
  format TEXT,
  experiences TEXT,
  week_start TEXT NOT NULL,
  CONSTRAINT uq_showtimes_business_key
    UNIQUE (theater_id, movie_id, date, time, version, format)
);

CREATE INDEX idx_showtimes_theater_date ON showtimes(theater_id, date);
CREATE INDEX idx_showtimes_movie_date ON showtimes(movie_id, date);
CREATE INDEX idx_showtimes_week ON showtimes(week_start);

CREATE TABLE weekly_programs (
  id SERIAL PRIMARY KEY,
  theater_id TEXT NOT NULL REFERENCES theaters(id) ON DELETE CASCADE,
  movie_id INTEGER NOT NULL REFERENCES movies(id),
  week_start TEXT NOT NULL,
  is_new_this_week INTEGER NOT NULL DEFAULT 0,
  scraped_at TEXT NOT NULL,
  UNIQUE(theater_id, movie_id, week_start)
);

CREATE INDEX idx_weekly_programs_week ON weekly_programs(week_start);

-- ============================================================================
-- Scrape scheduling, reports, and per-theater attempts
-- ============================================================================

-- updated_at maintenance trigger shared by scrape_schedules.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE scrape_schedules (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  cron_expression VARCHAR(100) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  target_theaters JSONB,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,
  UNIQUE(name)
);

CREATE TRIGGER update_scrape_schedules_updated_at
  BEFORE UPDATE ON scrape_schedules
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_scrape_schedules_enabled ON scrape_schedules(enabled);
CREATE INDEX idx_scrape_schedules_name ON scrape_schedules(name);

-- Default schedule: weekly Wednesday 03:00. External cron execution is gated
-- by ENABLE_SCRAPE_CRON=true at runtime; the row exists regardless.
INSERT INTO scrape_schedules (name, description, cron_expression, enabled)
VALUES ('Weekly Wednesday Scrape', 'Default weekly scrape - every Wednesday at 3am', '0 3 * * 3', true)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE scrape_reports (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial_success', 'failed', 'rate_limited')),
  trigger_type TEXT NOT NULL,
  total_theaters INTEGER,
  successful_theaters INTEGER,
  failed_theaters INTEGER,
  total_movies_scraped INTEGER,
  total_showtimes_scraped INTEGER,
  errors JSONB,
  progress_log JSONB,
  schedule_id INTEGER REFERENCES scrape_schedules(id),
  parent_report_id INTEGER REFERENCES scrape_reports(id)
);

CREATE INDEX idx_scrape_reports_started_at ON scrape_reports(started_at DESC);
CREATE INDEX idx_scrape_reports_status ON scrape_reports(status);

CREATE TABLE scrape_attempts (
  id SERIAL PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES scrape_reports(id) ON DELETE CASCADE,
  theater_id TEXT NOT NULL REFERENCES theaters(id),
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'success', 'failed', 'rate_limited', 'not_attempted')
  ),
  error_type TEXT,
  error_message TEXT,
  http_status_code INTEGER,
  movies_scraped INTEGER DEFAULT 0,
  showtimes_scraped INTEGER DEFAULT 0,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(report_id, theater_id, date)
);

CREATE INDEX idx_scrape_attempts_report_id ON scrape_attempts(report_id);
CREATE INDEX idx_scrape_attempts_report_status ON scrape_attempts(report_id, status);
CREATE INDEX idx_scrape_attempts_theater_date ON scrape_attempts(theater_id, date);

-- ============================================================================
-- Scraping: Postgres-backed job queue (ADR 0009)
-- ============================================================================
-- The worker role claims the oldest row
-- with `FOR UPDATE SKIP LOCKED` (delete-and-return); see migration 001 and the
-- BusConsumer implementation. FIFO is by `id` (BIGSERIAL); `enqueued_at` is
-- retained for queue ordering and audit timestamps.

CREATE TABLE scrape_jobs (
  id BIGSERIAL PRIMARY KEY,
  payload JSONB NOT NULL,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scrape_jobs_enqueued_at ON scrape_jobs(enqueued_at);

-- ============================================================================
-- Authentication: refresh tokens
-- ============================================================================

CREATE TABLE refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

-- ============================================================================
-- Authentication: one-purpose email tokens (verification, password reset)
-- ============================================================================
-- Raw token values are never stored: only the SHA-256 hash of the raw token.
-- At most one live token per (user, purpose): issuing a fresh token replaces
-- the prior row through the repository upsert. The 30-minute lifetime is
-- application policy (`AUTH_TOKEN_TTL_MS`, ADR 0006), not a schema concern.

CREATE TABLE auth_email_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup is always by (purpose, hash) at consume time.
CREATE INDEX idx_auth_email_tokens_hash ON auth_email_tokens(purpose, token_hash);
CREATE INDEX idx_auth_email_tokens_user_id ON auth_email_tokens(user_id);
CREATE UNIQUE INDEX idx_auth_email_tokens_user_purpose ON auth_email_tokens(user_id, purpose);

-- ============================================================================
-- Migration tracking
-- ============================================================================
-- Empty by design: docker/init.sql is the consolidated baseline, so no rows are
-- pre-recorded here. The application migration runner (AUTO_MIGRATE) records
-- future 001_* migrations in this table.

CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_schema_migrations_applied_at ON schema_migrations(applied_at);

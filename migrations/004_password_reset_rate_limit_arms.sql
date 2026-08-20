-- Password-reset rate-limit arms (ADR 0006, sub-decision 6).
-- The request route has independent per-IP and per-email budgets so rotating
-- source addresses cannot bombard one Member's inbox.

BEGIN;

ALTER TABLE rate_limit_configs
  ADD COLUMN IF NOT EXISTS password_reset_max INTEGER NOT NULL DEFAULT 3 CHECK (password_reset_max >= 1 AND password_reset_max <= 20);

ALTER TABLE rate_limit_configs
  ADD COLUMN IF NOT EXISTS password_reset_window_ms INTEGER NOT NULL DEFAULT 3600000 CHECK (password_reset_window_ms >= 300000 AND password_reset_window_ms <= 86400000);

ALTER TABLE rate_limit_configs
  ADD COLUMN IF NOT EXISTS password_reset_email_max INTEGER NOT NULL DEFAULT 3 CHECK (password_reset_email_max >= 1 AND password_reset_email_max <= 20);

ALTER TABLE rate_limit_configs
  ADD COLUMN IF NOT EXISTS password_reset_email_window_ms INTEGER NOT NULL DEFAULT 3600000 CHECK (password_reset_email_window_ms >= 300000 AND password_reset_email_window_ms <= 86400000);

COMMIT;

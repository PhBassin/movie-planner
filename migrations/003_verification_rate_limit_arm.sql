-- Verification rate-limit arm (ADR 0006, sub-decision 6): the verify-email
-- link target and resend-verification endpoints ride a dedicated arm of
-- RateLimitConfig (peer of register), so resends cannot be starved by signup
-- volume nor strand an unverified Member behind an exhausted shared budget.
-- Register-shaped defaults; idempotent for the same reason as every
-- migration here.

BEGIN;

ALTER TABLE rate_limit_configs
  ADD COLUMN IF NOT EXISTS verification_max INTEGER NOT NULL DEFAULT 3 CHECK (verification_max >= 1 AND verification_max <= 20);

ALTER TABLE rate_limit_configs
  ADD COLUMN IF NOT EXISTS verification_window_ms INTEGER NOT NULL DEFAULT 3600000 CHECK (verification_window_ms >= 300000 AND verification_window_ms <= 86400000);

COMMIT;

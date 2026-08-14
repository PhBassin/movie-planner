-- auth_email_tokens: one-purpose email tokens (verification, password reset).
--
-- Raw token values are never stored: only the SHA-256 hash of the raw token.
-- At most one live token per (user, purpose): issuing a fresh token supersedes
-- (deletes) prior outstanding ones. The 30-minute lifetime is application
-- policy (`AUTH_TOKEN_TTL_MS`, ADR 0006), not a schema concern. Consumed and
-- superseded tokens are deleted outright (the row is only useful while live).

BEGIN;

CREATE TABLE IF NOT EXISTS auth_email_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup is always by (purpose, hash) at consume time.
CREATE INDEX IF NOT EXISTS idx_auth_email_tokens_hash ON auth_email_tokens(purpose, token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_email_tokens_user_id ON auth_email_tokens(user_id);

COMMIT;

-- Freemium Selection quotas (issue #97, ADR 0011 D1–D3, D6).
--
-- `member_selections.active` distinguishes an **active** choice (feeds the
-- Homepage) from a **remembered** one (kept, excluded from the Homepage). Every
-- existing row stays active: no choice is removed or deactivated by the
-- rollout (D6) — a Member above the free quota is in the derived over-quota
-- state instead (D3).
--
-- `subscriptions` holds only what the Entitlement derivation reads (D1): a
-- Member is premium while a non-terminal Subscription's paid-through instant
-- is in the future. Checkout, tariff versions and provider references arrive
-- with the subscription slice (#99). At most one non-terminal Subscription per
-- Member (D10). Rows cascade on Member erasure (ADR 0004).
--
-- Both are already part of the docker/init.sql baseline; this numbered
-- migration carries them to databases initialized before. Idempotent, like
-- every migration here.

BEGIN;

ALTER TABLE member_selections ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'ended')),
  paid_through TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_open_per_member
  ON subscriptions(member_id) WHERE status <> 'ended';

COMMIT;

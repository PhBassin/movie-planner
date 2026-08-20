-- Member Selection (issue #60): a reference relationship from Members to the
-- shared Theater catalog — never a copy of Theater data. The table is already
-- part of the docker/init.sql baseline; this numbered migration carries it to
-- databases initialized before the baseline gained it, so `/api/me` can count
-- Selection rows everywhere. Idempotent, like every migration here.

BEGIN;

CREATE TABLE IF NOT EXISTS member_selections (
  theater_id TEXT NOT NULL REFERENCES theaters(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (member_id, theater_id)
);

CREATE INDEX IF NOT EXISTS idx_member_selections_theater_id ON member_selections(theater_id);

COMMIT;

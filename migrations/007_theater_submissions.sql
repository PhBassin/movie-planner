-- TheaterSubmission (issue #62): a Member's act of introducing a Theater not
-- yet in the shared catalog, recorded `pending` the moment the URL is accepted
-- and resolved `succeeded`/`failed` by the resolver (issue #63). `report_id`
-- joins the `add_theater` ScrapeJob and is load-bearing for resolution
-- (ADR 0005). The table is already part of the docker/init.sql baseline; this
-- numbered migration carries it to databases initialized before the baseline
-- gained it. Idempotent, like every migration here.

BEGIN;

CREATE TABLE IF NOT EXISTS theater_submissions (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  theater_id TEXT NOT NULL REFERENCES theaters(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  report_id INTEGER NOT NULL REFERENCES scrape_reports(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_theater_submissions_member_id
  ON theater_submissions(member_id);
CREATE INDEX IF NOT EXISTS idx_theater_submissions_report_id
  ON theater_submissions(report_id);
CREATE INDEX IF NOT EXISTS idx_theater_submissions_status
  ON theater_submissions(status);

COMMIT;

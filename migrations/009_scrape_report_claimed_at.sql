-- Stale-pending expiry (issue #119, ADR 0010): `claimed_at` records when a
-- worker claimed the report's job, so the reconciliation sweep measures a
-- submission scrape's age from the start of actual work — never from the
-- enqueue, which would count time spent queued behind a long scrape. NULL
-- while the job is still queued. The column is already part of the
-- docker/init.sql baseline; this numbered migration carries it to databases
-- initialized before the baseline gained it. Idempotent, like every migration
-- here.

BEGIN;

ALTER TABLE scrape_reports ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Backfill: a `running` report whose job is no longer queued was claimed by a
-- worker that predates this column (or died mid-job — the stuck submissions
-- this migration exists to heal). Its creation time is the best available
-- claim time.
UPDATE scrape_reports r
SET claimed_at = r.started_at
WHERE r.status = 'running'
  AND r.claimed_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM scrape_jobs j WHERE j.payload->>'reportId' = r.id::text
  );

COMMIT;

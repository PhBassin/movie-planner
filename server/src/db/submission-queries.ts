import type { DB } from './index.js';
import { getMemberLifecycle, type MemberLifecycleRow } from './user-queries.js';

type QueryableDB = Pick<DB, 'query'>;

/**
 * TheaterSubmission lifecycle statuses (see CONTEXT.md → TheaterSubmission).
 * The row is created `pending` (issue #62); the resolver (issue #63) writes the
 * terminal `succeeded` / `failed` status.
 */
export type SubmissionStatus = 'pending' | 'succeeded' | 'failed';

export interface TheaterSubmissionRow {
  id: number;
  member_id: number;
  url: string;
  theater_id: string;
  status: SubmissionStatus;
  report_id: number;
  created_at: string;
  resolved_at: string | null;
}

/** The Member lifecycle slice the submission boundary reads (see user-queries). */
export type SubmissionMemberRow = MemberLifecycleRow;

/**
 * Read a Member's lifecycle slice without locking — the pre-gate check that
 * runs before the dedup fast path (so a suspended Member with a stale token
 * cannot reach even the Selection-add downgrade).
 */
export async function getMemberForSubmission(
  db: QueryableDB,
  memberId: number,
): Promise<SubmissionMemberRow | undefined> {
  return getMemberLifecycle(db, memberId);
}

/** Lock the Member row for the authoritative submit decision (verification + throttle). */
export async function lockMemberForSubmission(
  db: QueryableDB,
  memberId: number,
): Promise<SubmissionMemberRow | undefined> {
  return getMemberLifecycle(db, memberId, { forUpdate: true });
}

/** Count a Member's new-cinema submissions within the throttle window. */
export async function countNewSubmissionsSince(
  db: QueryableDB,
  memberId: number,
  since: Date,
): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM theater_submissions
     WHERE member_id = $1 AND created_at >= $2`,
    [memberId, since],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Lock an existing Theater row for the retry decision (ADR 0010): serializes
 * concurrent re-submissions of the same URL — by any Member — so exactly one
 * of them sees "no pending attempt" and enqueues the new scrape.
 */
export async function lockTheaterForSubmission(
  db: QueryableDB,
  theaterId: string,
): Promise<{ id: string; status: 'provisioning' | 'active' } | undefined> {
  const result = await db.query<{ id: string; status: 'provisioning' | 'active' }>(
    'SELECT id, status FROM theaters WHERE id = $1 FOR UPDATE',
    [theaterId],
  );
  return result.rows[0];
}

/** How many TheaterSubmission attempts a Theater has, and how many are still pending. */
export async function countSubmissionAttempts(
  db: QueryableDB,
  theaterId: string,
): Promise<{ total: number; pending: number }> {
  const result = await db.query<{ total: number; pending: number }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
     FROM theater_submissions
     WHERE theater_id = $1`,
    [theaterId],
  );
  return result.rows[0] ?? { total: 0, pending: 0 };
}

/** Insert a pending TheaterSubmission row, returning the created row. */
export async function insertSubmission(
  db: QueryableDB,
  input: { memberId: number; url: string; theaterId: string; reportId: number },
): Promise<TheaterSubmissionRow> {
  const result = await db.query<TheaterSubmissionRow>(
    `INSERT INTO theater_submissions (member_id, url, theater_id, status, report_id)
     VALUES ($1, $2, $3, 'pending', $4)
     RETURNING id, member_id, url, theater_id, status, report_id, created_at, resolved_at`,
    [input.memberId, input.url, input.theaterId, input.reportId],
  );
  return result.rows[0];
}

/**
 * The pending TheaterSubmission joined to a `report_id`, for the live
 * resolution path (a terminal ProgressEvent just named that report).
 */
export async function getPendingSubmissionByReport(
  db: QueryableDB,
  reportId: number,
): Promise<TheaterSubmissionRow | undefined> {
  const result = await db.query<TheaterSubmissionRow>(
    `SELECT id, member_id, url, theater_id, status, report_id, created_at, resolved_at
     FROM theater_submissions
     WHERE report_id = $1 AND status = 'pending'
     ORDER BY id`,
    [reportId],
  );
  return result.rows[0];
}

/**
 * Reconciliation sweep (ADR 0005 sub-decision 8): pending submissions whose
 * `report_id` joins a terminal ScrapeReport — the ones whose terminal
 * ProgressEvent was missed (deploy, crash, dropped notification). Each row
 * carries the joined report's status so the sweep can derive the outcome
 * without a second query.
 */
export interface ResolvableSubmission extends TheaterSubmissionRow {
  report_status: 'success' | 'partial_success' | 'failed';
}

export async function getResolvablePendingSubmissions(
  db: QueryableDB,
): Promise<ResolvableSubmission[]> {
  const result = await db.query<ResolvableSubmission>(
    `SELECT s.id, s.member_id, s.url, s.theater_id, s.status, s.report_id, s.created_at, s.resolved_at,
            r.status AS report_status
     FROM theater_submissions s
     JOIN scrape_reports r ON r.id = s.report_id
     WHERE s.status = 'pending' AND r.status IN ('success', 'partial_success', 'failed')
     ORDER BY s.id`,
  );
  return result.rows;
}

/**
 * Stale-pending expiry (ADR 0010): fail the still-`running` ScrapeReport of
 * every pending submission created before `createdBefore` — a worker that
 * died mid-scrape never makes it terminal — and drop its queued job if the
 * worker never claimed it, so no zombie scrape runs after the expiry. The
 * reconciliation sweep then resolves those submissions `failed` through the
 * normal routine. Only submission-linked reports are touched; Staff scrapes
 * are not. Returns the expired report ids.
 */
export async function expireStalePendingSubmissionReports(
  db: QueryableDB,
  createdBefore: Date,
): Promise<number[]> {
  const result = await db.query<{ id: number }>(
    `WITH expired AS (
       UPDATE scrape_reports r
       SET status = 'failed', completed_at = NOW(), errors = $2::jsonb
       WHERE r.status = 'running'
         AND r.id IN (
           SELECT s.report_id FROM theater_submissions s
           WHERE s.status = 'pending' AND s.created_at < $1
         )
       RETURNING r.id
     ), dropped AS (
       DELETE FROM scrape_jobs j
       USING expired e
       WHERE j.payload->>'reportId' = e.id::text
       RETURNING j.id
     )
     SELECT id FROM expired ORDER BY id`,
    [createdBefore, JSON.stringify([{ theater_name: 'System', error: 'Submission scrape timed out' }])],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Write the terminal status of a submission — idempotent by construction:
 * the `WHERE status = 'pending'` guard means only the FIRST resolution (live
 * event or reconciliation, whichever arrives) flips the row; the loser's
 * UPDATE matches nothing and returns no row, which guards the rare
 * notification-vs-reconcile race.
 */
export async function resolveSubmission(
  db: QueryableDB,
  submissionId: number,
  status: Exclude<SubmissionStatus, 'pending'>,
): Promise<TheaterSubmissionRow | undefined> {
  const result = await db.query<TheaterSubmissionRow>(
    `UPDATE theater_submissions
     SET status = $2, resolved_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING id, member_id, url, theater_id, status, report_id, created_at, resolved_at`,
    [submissionId, status],
  );
  return result.rows[0];
}

/**
 * A Member's full TheaterSubmission history for the data export (ADR 0004
 * sub-decision 6), newest first. Internal plumbing (`member_id`,
 * `report_id`) stays out: the export carries the Member's own acts only.
 */
export type SubmissionExportRow = Pick<
  TheaterSubmissionRow,
  'id' | 'url' | 'theater_id' | 'status' | 'created_at' | 'resolved_at'
>;

export async function getSubmissionHistoryForExport(
  db: QueryableDB,
  memberId: number,
): Promise<SubmissionExportRow[]> {
  const result = await db.query<SubmissionExportRow>(
    `SELECT id, url, theater_id, status, created_at, resolved_at
     FROM theater_submissions
     WHERE member_id = $1
     ORDER BY created_at DESC, id DESC`,
    [memberId],
  );
  return result.rows;
}

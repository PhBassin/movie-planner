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

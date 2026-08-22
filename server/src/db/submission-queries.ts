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

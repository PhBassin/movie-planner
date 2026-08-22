import type { DB } from './index.js';
import type { Theater } from '../types/scraper.js';
import type { MemberStatus } from '../types/user.js';
import { mapTheaterRow, type TheaterRow } from './theater-queries.js';

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

/**
 * The Member lifecycle slice the submission boundary reads under `FOR UPDATE`:
 * role (defense in depth), status (suspension), and verification state.
 */
export interface SubmissionMemberRow {
  id: number;
  role_name: string;
  status: MemberStatus;
  email_verified_at: string | null;
}

/**
 * Read a Member's lifecycle slice without locking — the pre-gate check that
 * runs before the dedup fast path (so a suspended Member with a stale token
 * cannot reach even the Selection-add downgrade).
 */
export async function getMemberForSubmission(
  db: QueryableDB,
  memberId: number,
): Promise<SubmissionMemberRow | undefined> {
  return querySubmissionMember(db, memberId, false);
}

/** Lock the Member row for the authoritative submit decision (verification + throttle). */
export async function lockMemberForSubmission(
  db: QueryableDB,
  memberId: number,
): Promise<SubmissionMemberRow | undefined> {
  return querySubmissionMember(db, memberId, true);
}

async function querySubmissionMember(
  db: QueryableDB,
  memberId: number,
  forUpdate: boolean,
): Promise<SubmissionMemberRow | undefined> {
  const lockClause = forUpdate ? ' FOR UPDATE OF u' : '';
  const result = await db.query<SubmissionMemberRow>(
    `SELECT u.id, r.name AS role_name, u.status, u.email_verified_at
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1${lockClause}`,
    [memberId],
  );
  return result.rows[0];
}

/** Look up a Theater by id in any lifecycle status (dedup key, issue #62). */
export async function getTheaterById(
  db: QueryableDB,
  theaterId: string,
): Promise<Theater | undefined> {
  const result = await db.query<TheaterRow>(
    `SELECT id, name, status, address, postal_code, city, image_url, url
     FROM theaters
     WHERE id = $1`,
    [theaterId],
  );
  const row = result.rows[0];
  return row ? mapTheaterRow(row) : undefined;
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

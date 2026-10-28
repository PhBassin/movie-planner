import type { DB } from './index.js';
import { getMemberLifecycle, type MemberLifecycleRow } from './user-queries.js';
import { effectiveActiveSql, type SelectionChoiceView } from './selection-queries.js';

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

export interface LockedTheaterRow {
  id: string;
  url: string;
  status: 'provisioning' | 'active';
}

/**
 * Lock an existing Theater row for the retry decision (ADR 0010): serializes
 * concurrent re-submissions of the same URL — by any Member — so exactly one
 * of them sees "no pending attempt" and enqueues the new scrape.
 */
export async function lockTheaterForSubmission(
  db: QueryableDB,
  theaterId: string,
): Promise<LockedTheaterRow | undefined> {
  const result = await db.query<LockedTheaterRow>(
    'SELECT id, url, status FROM theaters WHERE id = $1 FOR UPDATE',
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
 * every pending submission whose job a worker claimed before `claimedBefore`
 * — a worker that died mid-scrape never makes it terminal. The clock is the
 * report's `claimed_at`, never the submission's `created_at`, so a job still
 * queued (`claimed_at IS NULL`, e.g. behind a long Staff scrape) never
 * expires. The reconciliation sweep then resolves those submissions `failed`
 * through the normal routine. Only submission-linked reports are touched;
 * Staff scrapes are not. Returns the expired report ids.
 */
export async function expireStalePendingSubmissionReports(
  db: QueryableDB,
  claimedBefore: Date,
): Promise<number[]> {
  const result = await db.query<{ id: number }>(
    `UPDATE scrape_reports r
     SET status = 'failed', completed_at = NOW(), errors = $2::jsonb
     WHERE r.status = 'running'
       AND r.claimed_at < $1
       AND r.id IN (
         SELECT s.report_id FROM theater_submissions s WHERE s.status = 'pending'
       )
     RETURNING r.id`,
    [claimedBefore, JSON.stringify([{ theater_name: 'System', error: 'Submission scrape timed out' }])],
  );
  return result.rows.map((row) => row.id).sort((a, b) => a - b);
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

/**
 * One row per Theater of a Member's "Mes soumissions" view (issue #120): the
 * latest attempt for each `theater_id`, the Member's attempt count for it,
 * the joined Theater, and whether it is currently in the Member's Selection
 * (derived at read time, never persisted).
 */
export interface MemberSubmissionRow {
  id: number;
  url: string;
  status: SubmissionStatus;
  created_at: string;
  resolved_at: string | null;
  attempts: number;
  theater_id: string;
  theater_status: 'provisioning' | 'active';
  theater_name: string;
  theater_city: string | null;
  /** An effectively active choice (ADR 0011 D6): a remembered one is not "in the Selection". */
  in_selection: boolean;
  /** A stored but remembered choice (ADR 0011 D2): kept, not active — never true while billing is disabled. */
  remembered: boolean;
}

/**
 * One page of "Mes soumissions" plus its `total` (distinct submitted
 * Theaters), read in a single statement so both come from the same snapshot.
 * The total row is always present; the LATERAL page is NULL past the end.
 */
export async function listMemberSubmissionsByTheater(
  db: QueryableDB,
  memberId: number,
  page: { limit: number; offset: number },
  view: SelectionChoiceView,
): Promise<{ rows: MemberSubmissionRow[]; total: number }> {
  // `id` is NULL on the lone total row of an empty page.
  const result = await db.query<Omit<MemberSubmissionRow, 'id'> & { id: number | null; total: number }>(
    `WITH attempts AS (
       SELECT s.id, s.url, s.status, s.created_at, s.resolved_at, s.theater_id,
              COUNT(*) OVER (PARTITION BY s.theater_id)::int AS attempts,
              ROW_NUMBER() OVER (PARTITION BY s.theater_id ORDER BY s.created_at DESC, s.id DESC) AS rank
       FROM theater_submissions s
       WHERE s.member_id = $1
     ),
     latest AS (
       SELECT * FROM attempts WHERE rank = 1
     )
     SELECT tot.total, p.*
     FROM (SELECT COUNT(*)::int AS total FROM latest) tot
     LEFT JOIN LATERAL (
       SELECT a.id, a.url, a.status, a.created_at, a.resolved_at, a.attempts, a.theater_id,
              t.status AS theater_status, t.name AS theater_name, t.city AS theater_city,
              (ms.theater_id IS NOT NULL AND ${effectiveActiveSql('$4')}) AS in_selection,
              (ms.theater_id IS NOT NULL AND NOT ${effectiveActiveSql('$4')}) AS remembered
       FROM latest a
       JOIN theaters t ON t.id = a.theater_id
       LEFT JOIN member_selections ms ON ms.member_id = $1 AND ms.theater_id = a.theater_id
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $2 OFFSET $3
     ) p ON true
     ORDER BY p.created_at DESC, p.id DESC`,
    [memberId, page.limit, page.offset, view.rememberedCountsAsActive],
  );
  const total = result.rows[0]?.total ?? 0;
  const rows = result.rows
    .filter((row): row is MemberSubmissionRow & { total: number } => row.id !== null)
    .map(({ total: _total, ...row }) => row);
  return { rows, total };
}

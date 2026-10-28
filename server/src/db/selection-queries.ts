import type { DB } from './index.js';
import type { Theater } from '../types/scraper.js';
import { mapTheaterRow, THEATER_COLUMNS, type TheaterRow } from './theater-queries.js';
import { getMemberLifecycle, type MemberLifecycleRow } from './user-queries.js';
import { paidThroughSubscriptionExistsSql } from './subscription-queries.js';

type QueryableDB = Pick<DB, 'query'>;

export async function lockMemberForSelection(
  db: QueryableDB,
  memberId: number,
): Promise<MemberLifecycleRow | undefined> {
  return getMemberLifecycle(db, memberId, { forUpdate: true });
}

export async function getActiveTheater(
  db: QueryableDB,
  theaterId: string,
): Promise<Theater | undefined> {
  const result = await db.query<TheaterRow>(
    `SELECT ${THEATER_COLUMNS} FROM theaters WHERE id = $1 AND status = 'active'`,
    [theaterId],
  );
  const row = result.rows[0];
  return row ? mapTheaterRow(row) : undefined;
}

/**
 * How a query reads a choice's active flag. `rememberedCountsAsActive` comes
 * from `rememberedChoicesCountAsActive` (billing/entitlement.ts), the single
 * definition of the effective active state (ADR 0011 D6).
 */
export interface SelectionChoiceView {
  rememberedCountsAsActive: boolean;
}

/**
 * The effective active state of the `ms` (member_selections) row, with
 * `param` bound to `SelectionChoiceView.rememberedCountsAsActive`. NULL for a
 * missing LEFT JOINed row only when the view is false — callers that LEFT JOIN
 * must guard on `ms.theater_id IS NOT NULL`.
 */
export function effectiveActiveSql(param: string): string {
  return `(ms.active OR ${param}::boolean)`;
}

/** A stored Selection choice: the referenced Theater and whether it is active or remembered (ADR 0011 D2). */
export type SelectionChoice = Theater & { active: boolean };

export async function getSelection(
  db: QueryableDB,
  memberId: number,
  view: SelectionChoiceView,
): Promise<SelectionChoice[]> {
  const result = await db.query<TheaterRow & { active: boolean }>(
    `SELECT t.id, t.name, t.status, t.address, t.postal_code, t.city, t.image_url, t.url,
            ${effectiveActiveSql('$2')} AS active
     FROM member_selections ms
     JOIN theaters t ON t.id = ms.theater_id
     WHERE ms.member_id = $1 AND t.status = 'active'
     ORDER BY t.name, t.id`,
    [memberId, view.rememberedCountsAsActive],
  );
  return result.rows.map((row) => ({ ...mapTheaterRow(row), active: row.active }));
}

/**
 * Everything the Entitlement decision and a personal projection need, read in
 * one statement so they share one snapshot (ADR 0011 D3): an expiring
 * Subscription or a concurrent add cannot slip between the over-quota check
 * and the projected Theaters.
 *
 * - `paidThrough`: a non-terminal Subscription is paid through now (D1);
 * - `active` / `total`: stored choice counts — every row, whatever the Theater
 *   status, like the former 50 cap: `active` feeds the quota, `total` the
 *   50-choice bound (D2);
 * - `projectedTheaterIds`: active choices of active catalog Theaters, the
 *   input of the Homepage movies, showtimes, search and New section.
 */
export interface SelectionSnapshot {
  paidThrough: boolean;
  active: number;
  total: number;
  projectedTheaterIds: string[];
}

export async function getSelectionSnapshot(
  db: QueryableDB,
  memberId: number,
  view: SelectionChoiceView,
): Promise<SelectionSnapshot> {
  const result = await db.query<{
    paid_through: boolean;
    active: number;
    total: number;
    projected_theater_ids: string[];
  }>(
    `SELECT ${paidThroughSubscriptionExistsSql('$1')} AS paid_through,
            COUNT(ms.theater_id) FILTER (WHERE ${effectiveActiveSql('$2')})::int AS active,
            COUNT(ms.theater_id)::int AS total,
            COALESCE(
              array_agg(t.id ORDER BY t.name, t.id)
                FILTER (WHERE t.status = 'active' AND ${effectiveActiveSql('$2')}),
              '{}'
            ) AS projected_theater_ids
     FROM (SELECT 1) AS one
     LEFT JOIN member_selections ms ON ms.member_id = $1
     LEFT JOIN theaters t ON t.id = ms.theater_id`,
    [memberId, view.rememberedCountsAsActive],
  );
  const row = result.rows[0];
  return {
    paidThrough: row?.paid_through ?? false,
    active: row?.active ?? 0,
    total: row?.total ?? 0,
    projectedTheaterIds: row?.projected_theater_ids ?? [],
  };
}

/** The stored choice for one Theater, or undefined when the Member has none. */
export async function getSelectionChoice(
  db: QueryableDB,
  memberId: number,
  theaterId: string,
  view: SelectionChoiceView,
): Promise<{ active: boolean } | undefined> {
  const result = await db.query<{ active: boolean }>(
    `SELECT ${effectiveActiveSql('$3')} AS active
     FROM member_selections ms WHERE ms.member_id = $1 AND ms.theater_id = $2`,
    [memberId, theaterId, view.rememberedCountsAsActive],
  );
  return result.rows[0];
}

/** Turn a remembered choice back into an active one. */
export async function activateSelection(
  db: QueryableDB,
  memberId: number,
  theaterId: string,
): Promise<void> {
  await db.query(
    'UPDATE member_selections SET active = TRUE WHERE member_id = $1 AND theater_id = $2',
    [memberId, theaterId],
  );
}

export async function insertSelection(
  db: QueryableDB,
  memberId: number,
  theaterId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO member_selections (theater_id, member_id)
     VALUES ($1, $2)
     ON CONFLICT (member_id, theater_id) DO NOTHING`,
    [theaterId, memberId],
  );
}

export async function removeSelection(
  db: QueryableDB,
  memberId: number,
  theaterId: string,
): Promise<boolean> {
  const result = await db.query(
    'DELETE FROM member_selections WHERE member_id = $1 AND theater_id = $2',
    [memberId, theaterId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * A Member's whole Selection for the data export (ADR 0004 sub-decision 6):
 * every `member_selections` row, whatever the Theater's status — unlike
 * `getSelection`, which serves the Member-facing view of active Theaters.
 */
export interface SelectionExportRow {
  theater_id: string;
  name: string;
  city: string | null;
  url: string | null;
  status: 'provisioning' | 'active';
  /** false for a remembered choice (ADR 0011 D15); always true while billing is disabled (D6). */
  active: boolean;
}

export async function getSelectionForExport(
  db: QueryableDB,
  memberId: number,
  view: SelectionChoiceView,
): Promise<SelectionExportRow[]> {
  const result = await db.query<SelectionExportRow>(
    `SELECT t.id AS theater_id, t.name, t.city, t.url, t.status, ${effectiveActiveSql('$2')} AS active
     FROM member_selections ms
     JOIN theaters t ON t.id = ms.theater_id
     WHERE ms.member_id = $1
     ORDER BY t.name, t.id`,
    [memberId, view.rememberedCountsAsActive],
  );
  return result.rows;
}

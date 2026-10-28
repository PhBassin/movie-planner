import type { DB } from './index.js';
import type { Theater } from '../types/scraper.js';
import { mapTheaterRow, THEATER_COLUMNS, type TheaterRow } from './theater-queries.js';
import { getMemberLifecycle, type MemberLifecycleRow } from './user-queries.js';

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

/** A stored Selection choice: the referenced Theater and whether it is active or remembered (ADR 0011 D2). */
export type SelectionChoice = Theater & { active: boolean };

export async function getSelection(db: QueryableDB, memberId: number): Promise<SelectionChoice[]> {
  const result = await db.query<TheaterRow & { active: boolean }>(
    `SELECT t.id, t.name, t.status, t.address, t.postal_code, t.city, t.image_url, t.url, ms.active
     FROM member_selections ms
     JOIN theaters t ON t.id = ms.theater_id
     WHERE ms.member_id = $1 AND t.status = 'active'
     ORDER BY t.name, t.id`,
    [memberId],
  );
  return result.rows.map((row) => ({ ...mapTheaterRow(row), active: row.active }));
}

/**
 * The Theaters feeding a personal projection (Homepage movies, showtimes,
 * New section): active catalog Theaters only, and only active choices unless
 * `includeRemembered` (billing disabled — ADR 0011 D6 fallback).
 */
export async function getProjectedSelectionTheaterIds(
  db: QueryableDB,
  memberId: number,
  options: { includeRemembered: boolean },
): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT t.id
     FROM member_selections ms
     JOIN theaters t ON t.id = ms.theater_id
     WHERE ms.member_id = $1 AND t.status = 'active'${options.includeRemembered ? '' : ' AND ms.active'}
     ORDER BY t.name, t.id`,
    [memberId],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Stored choice counts — every row, whatever the Theater status, like the
 * former 50 cap: `active` feeds the Entitlement quota, `total` the 50-choice
 * bound (ADR 0011 D2).
 */
export interface SelectionCounts {
  active: number;
  total: number;
}

export async function getSelectionCounts(db: QueryableDB, memberId: number): Promise<SelectionCounts> {
  const result = await db.query<SelectionCounts>(
    `SELECT COUNT(*) FILTER (WHERE active)::int AS active, COUNT(*)::int AS total
     FROM member_selections WHERE member_id = $1`,
    [memberId],
  );
  return result.rows[0] ?? { active: 0, total: 0 };
}

/** The stored choice for one Theater, or undefined when the Member has none. */
export async function getSelectionChoice(
  db: QueryableDB,
  memberId: number,
  theaterId: string,
): Promise<{ active: boolean } | undefined> {
  const result = await db.query<{ active: boolean }>(
    'SELECT active FROM member_selections WHERE member_id = $1 AND theater_id = $2',
    [memberId, theaterId],
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
  /** false for a remembered choice (ADR 0011 D15). */
  active: boolean;
}

export async function getSelectionForExport(
  db: QueryableDB,
  memberId: number,
): Promise<SelectionExportRow[]> {
  const result = await db.query<SelectionExportRow>(
    `SELECT t.id AS theater_id, t.name, t.city, t.url, t.status, ms.active
     FROM member_selections ms
     JOIN theaters t ON t.id = ms.theater_id
     WHERE ms.member_id = $1
     ORDER BY t.name, t.id`,
    [memberId],
  );
  return result.rows;
}

import type { DB } from './index.js';
import type { Theater } from '../types/scraper.js';
import { mapTheaterRow, type TheaterRow } from './theater-queries.js';

type QueryableDB = Pick<DB, 'query'>;

export interface SelectionMemberRow {
  id: number;
  role_name: string;
}

export async function lockMemberForSelection(
  db: QueryableDB,
  memberId: number,
): Promise<SelectionMemberRow | undefined> {
  const result = await db.query<SelectionMemberRow>(
    `SELECT u.id, r.name AS role_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1
      FOR UPDATE OF u`,
    [memberId],
  );
  return result.rows[0];
}

export async function getActiveTheater(
  db: QueryableDB,
  theaterId: string,
): Promise<Theater | undefined> {
  const result = await db.query<TheaterRow>(
    `SELECT id, name, status, address, postal_code, city, image_url, url
     FROM theaters
     WHERE id = $1 AND status = 'active'`,
    [theaterId],
  );
  const row = result.rows[0];
  return row ? mapTheaterRow(row) : undefined;
}

export async function getSelection(db: QueryableDB, memberId: number): Promise<Theater[]> {
  const result = await db.query<TheaterRow>(
    `SELECT t.id, t.name, t.status, t.address, t.postal_code, t.city, t.image_url, t.url
     FROM member_selections ms
     JOIN theaters t ON t.id = ms.theater_id
     WHERE ms.member_id = $1 AND t.status = 'active'
     ORDER BY t.name, t.id`,
    [memberId],
  );
  return result.rows.map(mapTheaterRow);
}

export async function getSelectionCount(db: QueryableDB, memberId: number): Promise<number> {
  const result = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM member_selections WHERE member_id = $1',
    [memberId],
  );
  return result.rows[0]?.count ?? 0;
}

export async function isTheaterSelected(
  db: QueryableDB,
  memberId: number,
  theaterId: string,
): Promise<boolean> {
  const result = await db.query(
    'SELECT 1 FROM member_selections WHERE member_id = $1 AND theater_id = $2',
    [memberId, theaterId],
  );
  return result.rows.length > 0;
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

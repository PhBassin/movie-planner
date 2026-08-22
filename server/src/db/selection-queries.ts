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

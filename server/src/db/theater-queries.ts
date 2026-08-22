// fallow-ignore-file security-sink
import { type DB, type DBQueryExecutor } from './index.js';
import type { Theater } from '../types/scraper.js';

export interface TheaterRow {
  id: string;
  name: string;
  status: Theater['status'];
  address: string | null;
  postal_code: string | null;
  city: string | null;
  image_url: string | null;
  url: string | null;
}

/** Minimal Theater identity + source URL — the shape the catalog write and scrape-config reads share. */
export interface TheaterInput {
  id: string;
  name: string;
  url: string;
}

export function mapTheaterRow(row: TheaterRow): Theater {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    address: row.address ?? undefined,
    postal_code: row.postal_code ?? undefined,
    city: row.city ?? undefined,
    image_url: row.image_url ?? undefined,
    url: row.url ?? undefined,
  };
}

/** Canonical Theater column list for single-theater lookups (mapTheaterRow's input). */
export const THEATER_COLUMNS = 'id, name, status, address, postal_code, city, image_url, url';

/** Look up a Theater by id in any lifecycle status. */
export async function getTheaterById(db: DBQueryExecutor, theaterId: string): Promise<Theater | undefined> {
  const result = await db.query<TheaterRow>(
    `SELECT ${THEATER_COLUMNS} FROM theaters WHERE id = $1`,
    [theaterId],
  );
  const row = result.rows[0];
  return row ? mapTheaterRow(row) : undefined;
}

// Récupérer tous les theaters
export async function getTheaters(db: DB): Promise<Theater[]> {
  const result = await db.query<TheaterRow>("SELECT * FROM theaters WHERE status = 'active' ORDER BY name");

  return result.rows.map(mapTheaterRow);
}

// Insertion ou mise à jour d'un theater
export async function upsertTheater(db: DB, theater: Theater): Promise<void> {
  await db.query(
    `
      INSERT INTO theaters (id, name, address, postal_code, city, image_url, url)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(id) DO UPDATE SET
        name = $2,
        address = $3,
        postal_code = $4,
        city = $5,
        image_url = $6,
        url = COALESCE($7, theaters.url)
    `,
    [
      theater.id,
      theater.name,
      theater.address ?? null,
      theater.postal_code ?? null,
      theater.city ?? null,
      theater.image_url ?? null,
      theater.url ?? null,
    ]
  );
}

// Récupérer les theaters configurés pour le scraping (ceux avec une URL)
export async function getTheaterConfigs(db: DB): Promise<TheaterInput[]> {
  const result = await db.query<TheaterInput>(
    "SELECT id, name, url FROM theaters WHERE url IS NOT NULL ORDER BY name"
  );
  return result.rows;
}

// Ajouter un nouveau theater
export async function addTheater(
  db: DBQueryExecutor,
  theater: TheaterInput
): Promise<TheaterInput> {
  const result = await db.query<{ id: string; name: string; url: string; status: Theater['status'] }>(
    `INSERT INTO theaters (id, name, url, status) VALUES ($1, $2, $3, 'provisioning') RETURNING id, name, url, status`,
    [theater.id, theater.name, theater.url]
  );
  return result.rows[0];
}

// Mettre à jour la configuration d'un theater
export async function updateTheaterConfig(
  db: DB,
  id: string,
  updates: {
    name?: string;
    url?: string;
    address?: string;
    postal_code?: string;
    city?: string;
  }
): Promise<Theater | undefined> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.url !== undefined) {
    fields.push(`url = $${paramIndex++}`);
    values.push(updates.url);
  }
  if (updates.address !== undefined) {
    fields.push(`address = $${paramIndex++}`);
    values.push(updates.address);
  }
  if (updates.postal_code !== undefined) {
    fields.push(`postal_code = $${paramIndex++}`);
    values.push(updates.postal_code);
  }
  if (updates.city !== undefined) {
    fields.push(`city = $${paramIndex++}`);
    values.push(updates.city);
  }

  values.push(id);
  const result = await db.query<TheaterRow>(
    `UPDATE theaters SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );

  const row = result.rows[0];
  if (!row) return undefined;

  return mapTheaterRow(row);
}

// Get total theater count
export async function getTheaterCount(db: DB): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM theaters',
    []
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

// Supprimer un theater (et ses séances via CASCADE)
export async function deleteTheater(db: DB, id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM theaters WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

import { type DB } from '../db/index.js';

/**
 * Count how many users currently hold the given role.
 * Used by the role-deletion route to enforce "role must not be in use".
 *
 * Throws if the row exists but the count is non-numeric or null — that
 * indicates a malformed response (SQL bug, schema drift, broken migration),
 * which the route handler must NOT silently treat as "role is unused".
 */
export async function getRoleInUseCount(db: DB, roleId: number): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT COUNT(*) as count FROM users WHERE role_id = $1',
    [roleId]
  );
  const row = result.rows[0];
  if (!row) return 0;
  const count = parseInt(row.count, 10);
  if (Number.isNaN(count)) {
    throw new Error('getRoleInUseCount: unexpected non-numeric count from database');
  }
  return count;
}

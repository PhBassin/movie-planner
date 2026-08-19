import { type DB, type DBQueryExecutor } from './index.js';
import { type MemberStatus } from '../types/user.js';

/**
 * Member queries — the Member specialization of the shared User identity
 * (see CONTEXT.md → Member). Members identify by email; Staff by username.
 */

/**
 * User row for the Member login path (lookup by email). Extends the staff
 * login row shape with the Member lifecycle columns.
 */
export interface MemberCredentialRow {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  role_id: number;
  role_name: string;
  is_system_role: boolean;
  status: MemberStatus;
  email_verified_at: string | null;
  created_at: string;
}

/** The `/api/me` profile shape for an authenticated Member. */
export interface MemberProfileRow {
  id: number;
  email: string;
  username: string;
  role_name: string;
  status: MemberStatus;
  email_verified_at: string | null;
  appearance: 'light' | 'dark';
  created_at: string;
}

/** The public shape returned by the signup route. */
export interface MemberSignupResult {
  id: number;
  username: string;
  email: string;
  role_id: number;
  role_name: string;
  status: string;
  created_at: string;
}

/**
 * True when the row is a Member still awaiting email verification — the
 * eligibility predicate for (re)sending a verification link. Lives next to
 * the query so the lifecycle rule stays with the data it reads.
 */
export function isPendingVerification(user: MemberCredentialRow): boolean {
  return user.role_name === 'member' && user.email_verified_at === null;
}

/**
 * Look up a user by email (case-insensitive). The primary use is the Member
 * login path, so it selects the Member lifecycle columns as well.
 */
export async function getUserByEmail(
  db: DB,
  email: string
): Promise<MemberCredentialRow | undefined> {
  const result = await db.query<MemberCredentialRow>(
    `SELECT u.id, u.username, u.email, u.password_hash, u.role_id,
            r.name AS role_name, r.is_system AS is_system_role,
            u.status, u.email_verified_at, u.created_at
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE LOWER(u.email) = LOWER($1)`,
    [email]
  );
  return result.rows[0];
}

/**
 * Look up a Member by id with the credential fields needed by auth services.
 * Staff rows are excluded so email-keyed Member flows cannot be used for them.
 */
export async function getMemberById(
  db: DBQueryExecutor,
  userId: number,
): Promise<MemberCredentialRow | undefined> {
  const result = await db.query<MemberCredentialRow>(
    `SELECT u.id, u.username, u.email, u.password_hash, u.role_id,
            r.name AS role_name, r.is_system AS is_system_role,
            u.status, u.email_verified_at, u.created_at
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1 AND r.name = 'member'`,
    [userId],
  );
  return result.rows[0];
}

/**
 * Create a Member account: a `users` row carrying the `member` role, the
 * email mirrored into `username` (the shared-identity shape stays NOT NULL),
 * and the `unverified` lifecycle status.
 */
export async function createMember(
  db: DB,
  email: string,
  passwordHash: string
): Promise<MemberSignupResult> {
  const result = await db.query<MemberSignupResult>(
    `INSERT INTO users (username, email, password_hash, role_id, status)
     VALUES ($1, $1, $2, (SELECT id FROM roles WHERE name = 'member'), 'unverified')
     RETURNING id, username, email, role_id,
       (SELECT name FROM roles WHERE id = role_id) AS role_name,
       status, created_at`,
    [email, passwordHash]
  );
  return result.rows[0];
}

/**
 * Load a Member's own profile for `/api/me`. The appearance comes from
 * `member_preferences` and defaults to 'light' when no row exists yet
 * (the Appearance ticket owns preference writes).
 */
export async function getMemberProfile(
  db: DB,
  userId: number
): Promise<MemberProfileRow | undefined> {
  const result = await db.query<MemberProfileRow>(
    `SELECT u.id, u.email, u.username, r.name AS role_name,
            u.status, u.email_verified_at,
            COALESCE(mp.appearance, 'light') AS appearance,
            u.created_at
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN member_preferences mp ON mp.member_id = u.id
     WHERE u.id = $1`,
    [userId]
  );
  return result.rows[0];
}

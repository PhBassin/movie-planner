import { type DB } from './index.js';
import { logger } from '../utils/logger.js';
import { generateRandomPassword } from './user-queries.js';
import { hashPassword } from '../utils/password.js';

/**
 * Ensure an initial administrator exists.
 *
 * The consolidated `docker/init.sql` baseline intentionally contains no static
 * administrator credential. After the schema is in place (via init.sql or the
 * migration runner), this creates the first `admin` user with a securely
 * generated random password when no administrator is present. The password is
 * logged exactly once and never persisted in plaintext.
 *
 * Idempotent: if any user holding the `admin` role already exists, this is a
 * no-op. Safe to call on every startup.
 *
 * @param db - Database client
 */
export async function ensureInitialAdmin(db: DB): Promise<void> {
  const adminRoleResult = await db.query<{ id: number }>(
    `SELECT id FROM roles WHERE name = 'admin' LIMIT 1`
  );

  if (adminRoleResult.rows.length === 0) {
    logger.error('Admin role not found — cannot bootstrap initial administrator');
    return;
  }

  const adminRoleId = adminRoleResult.rows[0].id;

  const adminCountResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM users WHERE role_id = $1`,
    [adminRoleId]
  );
  const adminCount = parseInt(adminCountResult.rows[0].count, 10);

  if (adminCount > 0) {
    logger.info(`Admin user already exists (count: ${adminCount}), skipping bootstrap`);
    return;
  }

  const password = generateRandomPassword();
  const passwordHash = await hashPassword(password);

  await db.query(
    `INSERT INTO users (username, password_hash, role_id) VALUES ($1, $2, $3)`,
    ['admin', passwordHash, adminRoleId]
  );

  logger.warn('═══════════════════════════════════════════════════════════');
  logger.warn('🔐 DEFAULT ADMIN USER CREATED');
  logger.warn('═══════════════════════════════════════════════════════════');
  logger.warn('Username: admin');
  console.log(`Password: ${password}`);
  logger.warn('═══════════════════════════════════════════════════════════');
  logger.warn('⚠️  SECURITY WARNING:');
  logger.warn('1. Save this password immediately');
  logger.warn('2. Change it after first login');
  logger.warn('3. This password will NOT be logged or shown again');
  logger.warn('═══════════════════════════════════════════════════════════');
}

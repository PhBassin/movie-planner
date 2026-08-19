import crypto from 'crypto';
import type { DB, DBQueryExecutor } from '../db/index.js';
import { AUTH_TOKEN_TTL_MS } from '../services/auth-tokens.js';
import { parseStrictInt } from '../utils/number.js';

/**
 * One-purpose auth email tokens (email verification, password reset).
 *
 * Deep module in the shape of the refresh-token repository: the public
 * surface deals exclusively in raw tokens — hashing (SHA-256) is an internal
 * detail and never crosses this seam. Tokens are stored hashed, carry the
 * shared 30-minute `AUTH_TOKEN_TTL_MS` lifetime (ADR 0006), and are strictly
 * single-use: consuming deletes the row, and issuing a fresh token supersedes
 * any prior outstanding token for the same (user, purpose), so at most one
 * token per purpose is live at a time.
 */

export type AuthEmailTokenPurpose = 'email_verification' | 'password_reset';

function hashToken(rawToken: string): string {
  // Not a password: the raw token is 256 bits of crypto-random data, so a
  // fast hash is the correct storage (same shape as the refresh-token
  // repository; bcrypt is for low-entropy secrets). CodeQL only sees a
  // password-ish path because the lifecycle tests chain issue→consume —
  // production code never feeds one function's output to the other.
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex'); // codeql[js/insufficient-password-hash]
}

/**
 * Issue a fresh token for (userId, purpose): atomically replaces any prior
 * outstanding token for that pair, stores the new token's hash, and returns
 * the raw token for the mailer to embed in a link.
 */
export async function issueAuthEmailToken(
  db: DB,
  userId: number,
  purpose: AuthEmailTokenPurpose,
): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_MS);

  // Supersession: at most one live token per (user, purpose) — a fresh issue
  // invalidates any outstanding one (ADR 0006 sub-decision 2). The upsert is
  // deliberately one statement so concurrent requests cannot both leave a
  // live token behind.
  await db.query(
    `INSERT INTO auth_email_tokens (user_id, token_hash, expires_at, purpose)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, purpose) DO UPDATE
     SET token_hash = EXCLUDED.token_hash,
         expires_at = EXCLUDED.expires_at,
         created_at = NOW()`,
    [userId, tokenHash, expiresAt, purpose],
  );

  return rawToken;
}

/**
 * Consume a token: single-statement delete-returning scoped to the purpose
 * and not yet expired, so a token is strictly single-use and an expired or
 * unknown token resolves to null (the caller's rejection path).
 */
export async function consumeAuthEmailToken(
  db: DBQueryExecutor,
  rawToken: string,
  purpose: AuthEmailTokenPurpose,
): Promise<number | null> {
  const tokenHash = hashToken(rawToken);
  const result = await db.query<{ id: number; user_id: number }>(
    `DELETE FROM auth_email_tokens
     WHERE purpose = $1 AND token_hash = $2 AND expires_at > $3
     RETURNING id, user_id`,
    [purpose, tokenHash, new Date()],
  );
  return result.rows[0]?.user_id ?? null;
}

/**
 * Sweep expired tokens (GC in the shape of the refresh-token cleanup). Tokens
 * are deleted on consume/supersede, so this only clears rows whose owner never
 * followed the link.
 */
export async function cleanupExpiredAuthEmailTokens(db: DB): Promise<number> {
  const result = await db.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM auth_email_tokens WHERE expires_at <= NOW() RETURNING id
     )
     SELECT COUNT(*)::text AS count FROM deleted`,
  );
  return parseStrictInt(result.rows[0].count) || 0;
}

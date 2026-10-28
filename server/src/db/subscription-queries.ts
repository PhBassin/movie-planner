import type { DBQueryExecutor } from './index.js';

/**
 * Subscription reads for the Entitlement derivation (ADR 0011 D1). A Member is
 * premium while a non-terminal Subscription's paid-through instant is in the
 * future — evaluated against the database clock, so expiry takes effect at
 * the exact boundary with no sweep. Checkout and provider sync (#99) write
 * these rows; this slice only reads them.
 */
export async function hasPaidThroughSubscription(
  db: DBQueryExecutor,
  memberId: number,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM subscriptions
     WHERE member_id = $1 AND status <> 'ended' AND paid_through > NOW()
     LIMIT 1`,
    [memberId],
  );
  return result.rows.length > 0;
}

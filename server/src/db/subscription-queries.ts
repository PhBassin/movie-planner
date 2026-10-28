/**
 * Subscription predicate for the Entitlement derivation (ADR 0011 D1). A
 * Member is premium while a non-terminal Subscription's paid-through instant
 * is in the future — evaluated against the database clock, so expiry takes
 * effect at the exact boundary with no sweep. Checkout and provider sync (#99)
 * write these rows; this slice only reads them, inside the Selection snapshot
 * (`getSelectionSnapshot`) so the Entitlement and the counts share one
 * statement.
 *
 * The clock is `statement_timestamp()`, not `NOW()`: `NOW()` is frozen at
 * transaction start, and a Selection add reads this after waiting on the
 * Member lock — a Subscription expiring during that wait must not still
 * count as paid.
 *
 * `memberParam` is the SQL placeholder bound to the Member id (e.g. `$1`).
 */
export function paidThroughSubscriptionExistsSql(memberParam: string): string {
  return `EXISTS (
       SELECT 1 FROM subscriptions
       WHERE member_id = ${memberParam} AND status <> 'ended' AND paid_through > statement_timestamp()
     )`;
}

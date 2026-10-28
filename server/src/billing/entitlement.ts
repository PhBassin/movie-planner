import type { DBQueryExecutor } from '../db/index.js';
import { hasPaidThroughSubscription } from '../db/subscription-queries.js';
import { logger } from '../utils/logger.js';

/**
 * Billing mode (ADR 0011 §1.5) — the single `BILLING_PROVIDER` setting.
 * `disabled` (default, production today) keeps every Member at 50 active
 * choices; `fake` applies the freemium quotas (3 free / 50 premium) for dev,
 * tests and e2e. The real provider arrives with its own issue (#124).
 */
export type BillingMode = 'disabled' | 'fake';

const BILLING_MODES: readonly BillingMode[] = ['disabled', 'fake'];

/** Active Selection choices for a free Member while billing is enabled. */
export const FREE_SELECTION_QUOTA = 3;
/** Active Selection choices for a premium Member — and everyone while billing is disabled. */
export const PREMIUM_SELECTION_QUOTA = 50;

/**
 * The offer a Member's Entitlement stems from: `null` while billing is
 * disabled (no offer exists, every Member may hold 50).
 */
export type Offer = 'free' | 'premium' | null;

export interface Entitlement {
  offer: Offer;
  /** Maximum number of **active** Selection choices. */
  selectionQuota: number;
}

export function resolveBillingMode(): BillingMode {
  const raw = process.env.BILLING_PROVIDER?.trim();
  return raw && (BILLING_MODES as readonly string[]).includes(raw) ? (raw as BillingMode) : 'disabled';
}

/**
 * Startup validation: an unknown `BILLING_PROVIDER` is a misconfiguration
 * (no real adapter exists yet), and the fake adapter is refused in production
 * (ADR 0011 §1.4) — same shape as `validateMailerConfiguration`.
 */
export function validateBillingConfiguration(): void {
  const raw = process.env.BILLING_PROVIDER?.trim();
  if (raw && !(BILLING_MODES as readonly string[]).includes(raw)) {
    logger.error(`❌ Unknown BILLING_PROVIDER: ${raw}`);
    throw new Error(
      `FATAL: BILLING_PROVIDER must be one of ${BILLING_MODES.join(', ')} (got "${raw}").`,
    );
  }
  if (raw === 'fake' && process.env.NODE_ENV === 'production') {
    logger.error('❌ BILLING_PROVIDER=fake in production');
    throw new Error(
      'FATAL: BILLING_PROVIDER=fake is refused in production (ADR 0011). ' +
      'Unset it (billing disabled) or configure a real provider.',
    );
  }
}

/**
 * Derive a Member's Entitlement (ADR 0011 D1) — on every Selection write and
 * personal projection, never from the JWT. Pass the transaction client when
 * the caller holds the Member lock so the read joins the decision.
 */
export async function getEntitlement(
  db: DBQueryExecutor,
  memberId: number,
  mode: BillingMode = resolveBillingMode(),
): Promise<Entitlement> {
  if (mode === 'disabled') {
    return { offer: null, selectionQuota: PREMIUM_SELECTION_QUOTA };
  }
  return (await hasPaidThroughSubscription(db, memberId))
    ? { offer: 'premium', selectionQuota: PREMIUM_SELECTION_QUOTA }
    : { offer: 'free', selectionQuota: FREE_SELECTION_QUOTA };
}

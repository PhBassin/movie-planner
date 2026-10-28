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

/**
 * The one parse of `BILLING_PROVIDER`: unset or blank is `disabled`; any other
 * value outside the known modes is a misconfiguration and throws — never a
 * silent fallback, whether or not startup validation ran (tests, scripts).
 * The raw value is not echoed: it comes from the process environment.
 */
export function resolveBillingMode(): BillingMode {
  const raw = process.env.BILLING_PROVIDER?.trim();
  if (!raw) return 'disabled';
  if (!(BILLING_MODES as readonly string[]).includes(raw)) {
    throw new Error(`FATAL: BILLING_PROVIDER must be one of ${BILLING_MODES.join(', ')}.`);
  }
  return raw as BillingMode;
}

/**
 * Startup validation: an unknown `BILLING_PROVIDER` is a misconfiguration
 * (no real adapter exists yet), and the fake adapter is refused in production
 * (ADR 0011 §1.4) — same shape as `validateMailerConfiguration`.
 */
export function validateBillingConfiguration(): void {
  let mode: BillingMode;
  try {
    mode = resolveBillingMode();
  } catch (error) {
    logger.error('❌ Unknown BILLING_PROVIDER value');
    throw error;
  }
  if (mode === 'fake' && process.env.NODE_ENV === 'production') {
    logger.error('❌ BILLING_PROVIDER=fake in production');
    throw new Error(
      'FATAL: BILLING_PROVIDER=fake is refused in production (ADR 0011). ' +
      'Unset it (billing disabled) or configure a real provider.',
    );
  }
}

/**
 * Whether a remembered choice counts as active — the single definition of the
 * effective active state (ADR 0011 D6): while billing is disabled every stored
 * choice is active (quota, Homepage, Catalog, "Mes soumissions", export).
 */
export function rememberedChoicesCountAsActive(mode: BillingMode = resolveBillingMode()): boolean {
  return mode === 'disabled';
}

/**
 * A Member's Entitlement (ADR 0011 D1), derived on every Selection write and
 * personal projection from the Subscription paid-through state read in the
 * same statement as the counts — never from the JWT.
 */
export function entitlementFor(mode: BillingMode, paidThrough: boolean): Entitlement {
  if (mode === 'disabled') {
    return { offer: null, selectionQuota: PREMIUM_SELECTION_QUOTA };
  }
  return paidThrough
    ? { offer: 'premium', selectionQuota: PREMIUM_SELECTION_QUOTA }
    : { offer: 'free', selectionQuota: FREE_SELECTION_QUOTA };
}

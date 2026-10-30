import type { DB, DBQueryExecutor } from '../db/index.js';
import {
  activateSelection,
  getActiveTheater,
  getSelection,
  getSelectionCounts,
  getSelectionSnapshot,
  insertSelection,
  lockMemberForSelection,
  removeSelection,
  type SelectionChoice,
  type SelectionCounts,
} from '../db/selection-queries.js';
import {
  entitlementFor,
  PREMIUM_SELECTION_QUOTA,
  rememberedChoicesCountAsActive,
  resolveBillingMode,
  type BillingMode,
  type Offer,
} from '../billing/entitlement.js';
import { AppError, ForbiddenError, NotFoundError } from '../utils/errors.js';
import { MEMBER_ONLY_ENDPOINT_MESSAGE } from '../types/role.js';
import type { Theater } from '../types/scraper.js';

/**
 * Bound on stored choices, active and remembered together (ADR 0011 D2): a
 * Member never stores more choices than premium could activate.
 */
export const MAX_SELECTION_CHOICES = PREMIUM_SELECTION_QUOTA;

/**
 * Outcome of the one Selection add policy (ADR 0011 D2) shared by the manual
 * add, remembered-choice activation, the dedup add and the submission
 * auto-add. `quota_reached` / `choices_full` wrote nothing.
 */
export type SelectionAddOutcome =
  | 'already_active'
  | 'activated'
  | 'added'
  | 'quota_reached'
  | 'choices_full';

/**
 * A Member's Selection usage against their Entitlement — the profile counter
 * and the over-quota projection guard (ADR 0011 D3: derived, never stored).
 */
export interface SelectionUsage {
  offer: Offer;
  activeCount: number;
  rememberedCount: number;
  selectionQuota: number;
  choiceLimit: number;
  overQuota: boolean;
}

/** The current billing mode's view of a choice's active flag (D6). */
function choiceView(mode: BillingMode): { rememberedCountsAsActive: boolean } {
  return { rememberedCountsAsActive: rememberedChoicesCountAsActive(mode) };
}

/** Derive the usage from counts read under `mode`. */
function usageFrom(mode: BillingMode, counts: Omit<SelectionCounts, 'choice'>): SelectionUsage {
  const entitlement = entitlementFor(mode, counts.paidThrough);
  return {
    offer: entitlement.offer,
    activeCount: counts.active,
    rememberedCount: counts.total - counts.active,
    selectionQuota: entitlement.selectionQuota,
    choiceLimit: MAX_SELECTION_CHOICES,
    overQuota: counts.active > entitlement.selectionQuota,
  };
}

type SelectionAddDecision =
  | { outcome: 'already_active' | 'activated' | 'added' }
  /** Nothing was written, so `usage` is the fresh state the 409 reports. */
  | { outcome: 'quota_reached' | 'choices_full'; usage: SelectionUsage };

/**
 * Apply the Selection add policy for an active catalog Theater. The caller
 * MUST hold the Member lock (`lockMemberForSelection`) in `tx`, so concurrent
 * adds serialize and cannot exceed the Entitlement read here.
 *
 * - an active choice is idempotent and consumes no slot;
 * - a remembered choice is activated when the active count is below quota;
 * - a new choice needs the active count below quota **and** the total below
 *   50 — it is always stored active, never as remembered.
 *
 * While billing is disabled every stored choice counts as active (D6).
 */
async function decideSelectionAdd(
  tx: DBQueryExecutor,
  memberId: number,
  theaterId: string,
): Promise<SelectionAddDecision> {
  const mode = resolveBillingMode();
  const counts = await getSelectionCounts(tx, memberId, choiceView(mode), theaterId);
  if (counts.choice?.active) {
    return { outcome: 'already_active' };
  }

  const usage = usageFrom(mode, counts);
  if (usage.activeCount >= usage.selectionQuota) {
    return { outcome: 'quota_reached', usage };
  }

  // A remembered choice removed concurrently (removal does not take the
  // Member lock) updates nothing: it is then a new choice, held to the total
  // bound below — never reported as activated when it is gone.
  if (counts.choice && await activateSelection(tx, memberId, theaterId)) {
    return { outcome: 'activated' };
  }

  if (counts.total >= MAX_SELECTION_CHOICES) {
    return { outcome: 'choices_full', usage };
  }

  await insertSelection(tx, memberId, theaterId);
  return { outcome: 'added' };
}

/** The one Selection add policy (see `decideSelectionAdd`), for callers that only need the outcome. */
export async function applySelectionAdd(
  tx: DBQueryExecutor,
  memberId: number,
  theaterId: string,
): Promise<SelectionAddOutcome> {
  return (await decideSelectionAdd(tx, memberId, theaterId)).outcome;
}

export class SelectionService {
  constructor(private readonly db: DB) {}

  /** Stored choices with their effective active flag (remembered ones count as active while billing is disabled, D6). */
  async list(memberId: number): Promise<SelectionChoice[]> {
    return getSelection(this.db, memberId, choiceView(resolveBillingMode()));
  }

  /** Counts only — the `GET /api/me` read, so no Theater join or projection. */
  async usage(memberId: number): Promise<SelectionUsage> {
    const mode = resolveBillingMode();
    return usageFrom(mode, await getSelectionCounts(this.db, memberId, choiceView(mode)));
  }

  /**
   * The Theaters a personal projection may read (Homepage movies, showtimes,
   * search, New section), or `over_quota` when the Member holds more active
   * choices than their Entitlement — then no personal data is projected
   * (ADR 0011 D3). The quota check and the Theater ids come from one
   * statement, so they cannot disagree.
   */
  async projection(memberId: number): Promise<{ overQuota: true } | { overQuota: false; theaterIds: string[] }> {
    const mode = resolveBillingMode();
    const snapshot = await getSelectionSnapshot(this.db, memberId, choiceView(mode));
    if (usageFrom(mode, snapshot).overQuota) {
      return { overQuota: true };
    }
    return { overQuota: false, theaterIds: snapshot.projectedTheaterIds };
  }

  async add(memberId: number, theaterId: string): Promise<Theater> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as DB;
      const member = await lockMemberForSelection(tx, memberId);
      if (!member) {
        throw new NotFoundError('Member not found');
      }
      if (member.role_name !== 'member') {
        throw new ForbiddenError(MEMBER_ONLY_ENDPOINT_MESSAGE);
      }

      const theater = await getActiveTheater(tx, theaterId);
      if (!theater) {
        throw new NotFoundError(`Active theater not found: ${theaterId}`);
      }

      const decision = await decideSelectionAdd(tx, memberId, theaterId);
      if (decision.outcome === 'quota_reached' || decision.outcome === 'choices_full') {
        throw selectionConflict(decision.outcome, decision.usage);
      }
      return theater;
    });
  }

  async remove(memberId: number, theaterId: string): Promise<boolean> {
    return removeSelection(this.db, memberId, theaterId);
  }
}

/**
 * The 409 for a rejected add. `details` carries the reason and the fresh
 * usage so a browser with a stale count can recover without guessing.
 */
function selectionConflict(reason: 'quota_reached' | 'choices_full', usage: SelectionUsage): AppError {
  const message = reason === 'choices_full'
    ? `Selection holds ${MAX_SELECTION_CHOICES} choices (active and remembered); remove a remembered theater to add another`
    : usage.offer === 'free'
      ? `Free offer allows ${usage.selectionQuota} active theaters; premium allows up to ${MAX_SELECTION_CHOICES}`
      : `Selection contains ${usage.activeCount} active theaters; maximum is ${usage.selectionQuota}`;
  return new AppError(message, 409, [{ reason, usage }]);
}

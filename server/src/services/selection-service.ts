import type { DB, DBQueryExecutor } from '../db/index.js';
import {
  activateSelection,
  getActiveTheater,
  getProjectedSelectionTheaterIds,
  getSelection,
  getSelectionChoice,
  getSelectionCounts,
  insertSelection,
  lockMemberForSelection,
  removeSelection,
  type SelectionChoice,
} from '../db/selection-queries.js';
import {
  getEntitlement,
  PREMIUM_SELECTION_QUOTA,
  resolveBillingMode,
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
export async function applySelectionAdd(
  tx: DBQueryExecutor,
  memberId: number,
  theaterId: string,
): Promise<SelectionAddOutcome> {
  const mode = resolveBillingMode();
  const existing = await getSelectionChoice(tx, memberId, theaterId);
  if (existing && (existing.active || mode === 'disabled')) {
    return 'already_active';
  }

  const entitlement = await getEntitlement(tx, memberId, mode);
  const counts = await getSelectionCounts(tx, memberId);
  const activeCount = mode === 'disabled' ? counts.total : counts.active;
  if (activeCount >= entitlement.selectionQuota) {
    return 'quota_reached';
  }

  if (existing) {
    await activateSelection(tx, memberId, theaterId);
    return 'activated';
  }

  if (counts.total >= MAX_SELECTION_CHOICES) {
    return 'choices_full';
  }

  await insertSelection(tx, memberId, theaterId);
  return 'added';
}

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

export class SelectionService {
  constructor(private readonly db: DB) {}

  /** Stored choices as the Member sees them: remembered ones count as active while billing is disabled (D6). */
  async list(memberId: number): Promise<SelectionChoice[]> {
    const choices = await getSelection(this.db, memberId);
    if (resolveBillingMode() !== 'disabled') return choices;
    return choices.map((choice) => ({ ...choice, active: true }));
  }

  async usage(memberId: number, db: DBQueryExecutor = this.db): Promise<SelectionUsage> {
    const mode = resolveBillingMode();
    const entitlement = await getEntitlement(db, memberId, mode);
    const counts = await getSelectionCounts(db, memberId);
    const activeCount = mode === 'disabled' ? counts.total : counts.active;
    return {
      offer: entitlement.offer,
      activeCount,
      rememberedCount: counts.total - activeCount,
      selectionQuota: entitlement.selectionQuota,
      choiceLimit: MAX_SELECTION_CHOICES,
      overQuota: activeCount > entitlement.selectionQuota,
    };
  }

  /**
   * The Theaters a personal projection may read (Homepage movies, showtimes,
   * search, New section), or `over_quota` when the Member holds more active
   * choices than their Entitlement — then no personal data is projected
   * (ADR 0011 D3).
   */
  async projection(memberId: number): Promise<{ overQuota: true } | { overQuota: false; theaterIds: string[] }> {
    const usage = await this.usage(memberId);
    if (usage.overQuota) {
      return { overQuota: true };
    }
    const theaterIds = await getProjectedSelectionTheaterIds(this.db, memberId, {
      includeRemembered: usage.offer === null,
    });
    return { overQuota: false, theaterIds };
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

      const outcome = await applySelectionAdd(tx, memberId, theaterId);
      if (outcome === 'quota_reached' || outcome === 'choices_full') {
        throw await this.conflict(tx, memberId, outcome);
      }
      return theater;
    });
  }

  async remove(memberId: number, theaterId: string): Promise<boolean> {
    return removeSelection(this.db, memberId, theaterId);
  }

  /**
   * The 409 for a rejected add. `details` carries the reason and the fresh
   * usage so a browser with a stale count can recover without guessing.
   */
  private async conflict(
    tx: DBQueryExecutor,
    memberId: number,
    reason: 'quota_reached' | 'choices_full',
  ): Promise<AppError> {
    const usage = await this.usage(memberId, tx);
    const message = reason === 'choices_full'
      ? `Selection holds ${MAX_SELECTION_CHOICES} choices (active and remembered); remove a remembered theater to add another`
      : usage.offer === 'free'
        ? `Free offer allows ${usage.selectionQuota} active theaters; premium allows up to ${MAX_SELECTION_CHOICES}`
        : `Selection contains ${usage.activeCount} active theaters; maximum is ${usage.selectionQuota}`;
    return new AppError(message, 409, [{ reason, usage }]);
  }
}

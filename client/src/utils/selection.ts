import type { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/core.js';
import type { MemberProfile, Offer } from '../api/me.js';
import { ME_QUERY_KEY } from '../api/query-keys.js';

/**
 * A rejected Selection add (409, ADR 0011 D2). The server's `details` carry
 * the reason and fresh usage, so a stale browser count still explains the
 * actual limit. Every path that adds to the Selection can hit it: the manual
 * add, remembered activation, the dedup submission and its "Réessayer".
 */
interface SelectionConflictDetail {
  reason?: 'quota_reached' | 'choices_full';
  usage?: { offer: Offer; selectionQuota: number; choiceLimit: number };
}

function selectionConflictDetail(error: unknown): SelectionConflictDetail | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const detail = (error.data as { details?: SelectionConflictDetail[] } | undefined)?.details?.[0];
  return detail?.reason === 'quota_reached' || detail?.reason === 'choices_full' ? detail : undefined;
}

/** A 409 whose `details` name a Selection limit — not another conflict (e.g. a submission in flight). */
export function isSelectionConflict(error: unknown): error is ApiError {
  return selectionConflictDetail(error) !== undefined;
}

/** French copy for a Selection-limit 409; server messages are English and never shown as-is. */
export function selectionConflictMessage(error: ApiError, profile: MemberProfile | undefined): string {
  const detail = selectionConflictDetail(error);
  const choiceLimit = detail?.usage?.choiceLimit ?? profile?.choiceLimit ?? 50;
  if (detail?.reason === 'choices_full') {
    return `Vous avez déjà ${choiceLimit} cinémas enregistrés. Retirez un cinéma mémorisé pour en ajouter un autre.`;
  }
  const offer = detail?.usage ? detail.usage.offer : profile?.offer;
  const quota = detail?.usage?.selectionQuota ?? profile?.selectionLimit;
  if (offer === 'free') {
    return `L’offre gratuite permet ${quota ?? 3} cinémas actifs. Premium permet d’en suivre jusqu’à ${choiceLimit}.`;
  }
  return quota !== undefined
    ? `Votre Selection est pleine (${quota} cinémas actifs).`
    : 'Votre Selection est pleine : retirez un cinéma avant d’en ajouter un autre.';
}

/**
 * Reload everything a Selection write (add, activation, removal) or a
 * rejected one can change: the choices, the profile usage and the Homepage
 * projection — whose cached `overQuota` would otherwise outlive the fix.
 */
export function invalidateMemberSelection(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['selection'] }),
    queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: ['selection-movies'] }),
  ]);
}

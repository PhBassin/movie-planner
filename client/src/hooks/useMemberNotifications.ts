import { useContext, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AuthContext } from '../contexts/AuthContext.js';
import { subscribeToMemberNotifications } from '../api/me.js';
import { MEMBER_SUBMISSIONS_QUERY_KEY } from '../api/query-keys.js';
import { invalidateMemberSelection } from '../utils/selection.js';
import type { MemberNotice } from '../types/index.js';

/**
 * Transient toast surface for Member notifications (ADR 0005): no entity, no
 * persistence, no unread count — durability lives in the submission rows.
 * A toast is the "it just happened" nudge for a Member who happens to be
 * online; it auto-dismisses.
 */
export interface MemberNotificationToast {
  id: number;
  kind: 'success' | 'cap-blocked' | 'error';
  message: string;
  actions?: Array<{ label: string; to: string }>;
}

/** Every resolution outcome is also durable on "Mes soumissions". */
const SUBMISSIONS_ACTION = { label: 'Mes soumissions', to: '/submissions' };

const TOAST_DURATION_MS = 8000;

/**
 * The cap-blocked copy names the limit that refused the auto-add, like the
 * synchronous 409 does: the offer's active quota, or the 50 stored choices.
 */
function selectionFullMessage(notice: MemberNotice): string {
  const inCatalog = `« ${notice.theaterName} » est dans le catalogue`;
  switch (notice.selectionRefusal) {
    case 'quota_reached':
      return `${inCatalog}, mais votre Selection compte déjà autant de cinémas actifs que votre offre le permet. Libérez une place puis ajoutez-le depuis la liste des cinémas.`;
    case 'choices_full':
      return `${inCatalog}, mais vous avez déjà 50 cinémas enregistrés. Retirez un cinéma mémorisé puis ajoutez-le depuis la liste des cinémas.`;
    default:
      return `${inCatalog}, mais votre Selection est pleine. Libérez une place puis ajoutez-le depuis la liste des cinémas.`;
  }
}

export function noticeToToast(notice: MemberNotice, id: number): MemberNotificationToast {
  switch (notice.outcome) {
    case 'succeeded':
      return {
        id,
        kind: 'success',
        message: `« ${notice.theaterName} » a rejoint votre Selection.`,
        actions: [SUBMISSIONS_ACTION],
      };
    case 'succeeded_selection_full':
      return {
        id,
        kind: 'cap-blocked',
        message: selectionFullMessage(notice),
        actions: [{ label: 'Voir les cinémas', to: '/cinemas' }, SUBMISSIONS_ACTION],
      };
    case 'failed':
      // Only the sanitized Member-facing reason rides the wire.
      return {
        id,
        kind: 'error',
        message: notice.reason ?? 'La soumission a échoué.',
        actions: [SUBMISSIONS_ACTION],
      };
  }
}

/**
 * Subscribe the signed-in Member to their live notification stream and render
 * a transient toast per notice. Mounted once in the Layout so outcomes land
 * wherever the Member happens to be; on success/cap-block the Member's
 * Selection-backed views revalidate so the new cinema card appears.
 */
export function useMemberNotifications() {
  const { isAuthenticated, user } = useContext(AuthContext);
  const isMember = isAuthenticated && user?.role_name === 'member';
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<MemberNotificationToast | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    if (!isMember) return undefined;

    const unsubscribe = subscribeToMemberNotifications((notice) => {
      void Promise.all([
        invalidateMemberSelection(queryClient),
        queryClient.invalidateQueries({ queryKey: MEMBER_SUBMISSIONS_QUERY_KEY }),
      ]);
      counter.current += 1;
      setToast(noticeToToast(notice, counter.current));
    });

    return unsubscribe;
  }, [isMember, queryClient]);

  useEffect(() => {
    if (!toast) return undefined;
    const timeoutId = window.setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  return { toast, dismiss: () => setToast(null) };
}

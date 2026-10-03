import { useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AuthContext } from '../contexts/AuthContext.js';
import { subscribeToMemberNotifications } from '../api/me.js';
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
  action?: { label: string; to: string };
}

const TOAST_DURATION_MS = 8000;

export function noticeToToast(notice: MemberNotice, id: number): MemberNotificationToast {
  switch (notice.outcome) {
    case 'succeeded':
      return {
        id,
        kind: 'success',
        message: `« ${notice.theaterName} » a rejoint votre Selection.`,
      };
    case 'succeeded_selection_full':
      return {
        id,
        kind: 'cap-blocked',
        message: `« ${notice.theaterName} » est dans le catalogue, mais votre Selection est pleine. Libérez une place puis ajoutez-le depuis la liste des cinémas.`,
        action: { label: 'Voir les cinémas', to: '/cinemas' },
      };
    case 'failed':
      // Only the sanitized Member-facing reason rides the wire.
      return { id, kind: 'error', message: notice.reason ?? 'La soumission a échoué.' };
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
        queryClient.invalidateQueries({ queryKey: ['selection'] }),
        queryClient.invalidateQueries({ queryKey: ['me'] }),
        queryClient.invalidateQueries({ queryKey: ['selection-movies'] }),
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

const TOAST_STYLES: Record<MemberNotificationToast['kind'], string> = {
  success: 'border-green-200 bg-green-50 text-green-900',
  'cap-blocked': 'border-amber-200 bg-amber-50 text-amber-900',
  error: 'border-red-200 bg-red-50 text-red-900',
};

export default function MemberNotifications() {
  const { toast, dismiss } = useMemberNotifications();

  if (!toast) return null;

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 flex max-w-sm items-start gap-4 rounded-xl border px-4 py-3 shadow-lg ${TOAST_STYLES[toast.kind]}`}
      role="alert"
      data-testid="member-notification"
      data-kind={toast.kind}
    >
      <span className="flex-1">
        {toast.message}
        {toast.action && (
          <Link
            to={toast.action.to}
            className="ml-2 font-semibold underline underline-offset-2 hover:opacity-80"
            onClick={dismiss}
          >
            {toast.action.label}
          </Link>
        )}
      </span>
      <button
        type="button"
        className="text-sm font-semibold hover:opacity-80"
        aria-label="Fermer la notification"
        onClick={dismiss}
      >
        Fermer
      </button>
    </div>
  );
}

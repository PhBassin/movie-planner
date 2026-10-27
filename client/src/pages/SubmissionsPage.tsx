import { useContext, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/core.js';
import { resendVerification } from '../api/auth.js';
import {
  addToSelection,
  getMemberProfile,
  getMemberSubmissions,
  submitTheater,
  type MemberSubmission,
} from '../api/me.js';
import { MEMBER_SUBMISSIONS_QUERY_KEY, ME_QUERY_KEY } from '../api/query-keys.js';
import { AuthContext } from '../contexts/AuthContext.js';
import { ErrorMessage, LoadingSpinner } from '../components/ui/PageStates.js';

/** Items per "Voir plus" page. */
export const SUBMISSIONS_PAGE_SIZE = 20;

/** "En cours depuis X min" for a pending attempt, from its `created_at`. */
export function pendingSinceLabel(createdAt: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - new Date(createdAt).getTime()) / 60_000);
  if (minutes < 1) return 'En cours depuis moins d’une minute';
  return `En cours depuis ${minutes} min`;
}

/** How often a pending row re-renders its "En cours depuis" label (no fetch). */
const PENDING_LABEL_TICK_MS = 60_000;

/**
 * French Member-facing copy for a failed "Réessayer" call. Server messages are
 * English, so they are never shown as-is.
 */
function retryErrorMessage(error: Error): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'Vous avez atteint la limite de propositions. Réessayez plus tard.';
    if (error.status === 409) return 'Ce cinéma est déjà en cours d’ajout.';
    if (error.status === 403) return 'Action impossible pour ce compte.';
  }
  return 'Impossible de relancer cette proposition.';
}

/**
 * One row per Theater, even when offset pages overlap because a new attempt
 * shifted the newest-first list between "Voir plus" fetches.
 */
function uniqueByTheater(items: MemberSubmission[]): MemberSubmission[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.theater.id) && seen.add(item.theater.id));
}

/**
 * "Mes soumissions" (issue #120): the durable view of the Member's
 * TheaterSubmissions — one row per Theater (its latest attempt). Member
 * notifications stay the transient nudge; they only invalidate this list.
 */
export default function SubmissionsPage() {
  const { user } = useContext(AuthContext);
  const isMember = user?.role_name === 'member';

  const profileQuery = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: getMemberProfile,
    enabled: isMember,
  });
  const submissionsQuery = useInfiniteQuery({
    queryKey: MEMBER_SUBMISSIONS_QUERY_KEY,
    queryFn: ({ pageParam }) => getMemberSubmissions({ limit: SUBMISSIONS_PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.offset + lastPage.items.length;
      return lastPage.items.length > 0 && nextOffset < lastPage.total ? nextOffset : undefined;
    },
    enabled: isMember,
  });

  if (!isMember) return <Navigate to="/" replace />;
  if (profileQuery.isLoading || submissionsQuery.isLoading) return <LoadingSpinner />;

  // The profile only feeds the unverified empty state: its failure never hides the list.
  if (submissionsQuery.error) {
    return <ErrorMessage message={submissionsQuery.error.message || 'Impossible de charger vos soumissions.'} />;
  }

  const items = uniqueByTheater(submissionsQuery.data?.pages.flatMap((page) => page.items) ?? []);
  const profile = profileQuery.data;

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Vos propositions</p>
        <h1 className="mt-2 text-4xl font-bold text-gray-900" data-testid="submissions-heading">Mes soumissions</h1>
        {items.length > 0 && (
          <p className="mt-2 text-sm text-gray-600" data-testid="submissions-throttle-reminder">
            Le nombre de nouvelles propositions est limité sur une période glissante : si la limite est atteinte, patientez avant d’en proposer d’autres.
          </p>
        )}
      </div>

      {items.length === 0 ? (
        profile && !profile.email_verified
          ? <UnverifiedState email={profile.email} />
          : <EmptyState />
      ) : (
        <>
          <ul className="space-y-3" data-testid="submissions-list">
            {items.map((submission) => (
              <SubmissionRow key={submission.theater.id} submission={submission} />
            ))}
          </ul>
          {submissionsQuery.hasNextPage && (
            <div className="mt-6 text-center">
              <button
                type="button"
                onClick={() => void submissionsQuery.fetchNextPage()}
                disabled={submissionsQuery.isFetchingNextPage}
                className="rounded-xl border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-800 shadow-sm transition hover:bg-gray-50 disabled:opacity-50"
                data-testid="submissions-load-more"
              >
                {submissionsQuery.isFetchingNextPage ? 'Chargement…' : 'Voir plus'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function UnverifiedState({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  const handleResend = async () => {
    setState('sending');
    try {
      await resendVerification(email);
      setState('sent');
    } catch {
      setState('error');
    }
  };

  return (
    <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 p-10 text-center" data-testid="submissions-unverified">
      <p className="font-semibold text-gray-700">Vérifiez votre email pour proposer un cinéma.</p>
      {state === 'sent' ? (
        <p className="mt-3 text-sm text-gray-600" role="status">Un nouvel email de vérification vous a été envoyé.</p>
      ) : (
        <button
          type="button"
          onClick={() => void handleResend()}
          disabled={state === 'sending'}
          className="mt-4 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-yellow-500 disabled:opacity-50"
          data-testid="submissions-resend-verification"
        >
          {state === 'sending' ? 'Envoi…' : 'Renvoyer l’email de vérification'}
        </button>
      )}
      {state === 'error' && (
        <p className="mt-3 text-sm text-red-600" role="alert">Impossible d’envoyer l’email. Réessayez plus tard.</p>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 p-10 text-center" data-testid="submissions-empty">
      <p className="font-semibold text-gray-700">Vous n’avez encore proposé aucun cinéma.</p>
      <p className="mt-1 text-sm text-gray-500">
        Un cinéma manque au catalogue ? Proposez sa page AlloCiné : vous suivrez ici son ajout.
      </p>
      <Link
        to="/cinemas"
        className="mt-4 inline-block font-semibold text-gray-900 underline underline-offset-2 hover:text-primary"
        data-testid="submissions-empty-link"
      >
        Proposer un cinéma
      </Link>
    </div>
  );
}

function SubmissionRow({ submission }: { submission: MemberSubmission }) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const { theater } = submission;
  const isActive = theater.status === 'active';
  // A failed attempt whose Theater another Member's retry activated is in the
  // catalog: it offers the Selection add, never a retry.
  const canAdd = isActive && submission.in_selection === false;
  const canRetry = submission.status === 'failed' && !isActive;

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: MEMBER_SUBMISSIONS_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: ['selection'] }),
    queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
  ]);

  const addMutation = useMutation({
    mutationFn: () => addToSelection(theater.id),
    onSuccess: async () => {
      setActionError(null);
      await refresh();
    },
    onError: (error: Error) => {
      setActionError(error instanceof ApiError && error.status === 409
        ? 'Votre Sélection est pleine : retirez un cinéma avant d’ajouter celui-ci.'
        : 'Impossible d’ajouter ce cinéma à votre Sélection.');
    },
  });

  const retryMutation = useMutation({
    mutationFn: () => submitTheater(submission.url),
    onSuccess: async () => {
      setActionError(null);
      await refresh();
    },
    onError: (error: Error) => setActionError(retryErrorMessage(error)),
  });

  return (
    <li
      className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
      data-testid="submission-row"
      data-status={submission.status}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {isActive ? (
            <Link to={`/theater/${theater.id}`} className="font-semibold text-gray-900 hover:text-primary" data-testid="submission-theater-link">
              {theater.name}
              {theater.city && <span className="font-normal text-gray-500"> · {theater.city}</span>}
            </Link>
          ) : (
            <p className="break-all font-semibold text-gray-900">{submission.url}</p>
          )}
          {isActive && <p className="mt-0.5 break-all text-xs text-gray-500">{submission.url}</p>}
          <p className="mt-2 text-sm" data-testid="submission-state">
            <SubmissionStateLabel submission={submission} />
          </p>
          {submission.attempts > 1 && (
            <p className="mt-1 text-xs text-gray-500" data-testid="submission-attempts">{submission.attempts} tentatives</p>
          )}
        </div>

        {canAdd && (
          <button
            type="button"
            onClick={() => addMutation.mutate()}
            disabled={addMutation.isPending}
            className="shrink-0 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-black transition hover:bg-yellow-500 disabled:opacity-50"
            data-testid="submission-add"
          >
            {addMutation.isPending ? 'Ajout…' : 'Ajouter à ma Sélection'}
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            onClick={() => retryMutation.mutate()}
            disabled={retryMutation.isPending}
            className="shrink-0 rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 transition hover:bg-gray-50 disabled:opacity-50"
            data-testid="submission-retry"
          >
            {retryMutation.isPending ? 'Envoi…' : 'Réessayer'}
          </button>
        )}
      </div>
      {actionError && (
        <p className="mt-3 text-sm text-red-600" role="alert" data-testid="submission-action-error">{actionError}</p>
      )}
    </li>
  );
}

function SubmissionStateLabel({ submission }: { submission: MemberSubmission }) {
  if (submission.status === 'pending') return <PendingSince createdAt={submission.created_at} />;
  // An active Theater is in the catalog whatever this Member's last attempt did.
  if (submission.theater.status === 'active') {
    return submission.in_selection
      ? <span className="text-green-700">Ajouté à votre Sélection</span>
      : <span className="text-gray-700">Ajouté au catalogue, pas dans votre Sélection</span>;
  }
  return <span className="text-red-700">Échec : {submission.reason ?? 'la soumission a échoué.'}</span>;
}

/** Re-renders every minute so the elapsed time stays current without polling the API. */
function PendingSince({ createdAt }: { createdAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), PENDING_LABEL_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  return <span className="text-amber-700">{pendingSinceLabel(createdAt, now)}</span>;
}

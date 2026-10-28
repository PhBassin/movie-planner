import { useContext, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/core.js';
import { addToSelection, getMemberProfile, getSelection, removeFromSelection, submitTheater, type MemberProfile, type Offer } from '../api/me.js';
import { ME_QUERY_KEY } from '../api/query-keys.js';
import { getTheaters } from '../api/theaters.js';
import { AuthContext } from '../contexts/AuthContext.js';
import type { Theater } from '../types/index.js';
import { LoadingSpinner, ErrorMessage } from '../components/ui/PageStates.js';

function theaterSearchText(theater: Theater): string {
  return [theater.name, theater.id, theater.city, theater.address, theater.postal_code]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

/**
 * French copy for a rejected Selection add (409). The server's `details`
 * carry the reason and fresh usage, so a stale browser count still explains
 * the actual limit (ADR 0011 D2).
 */
interface SelectionConflictDetail {
  reason?: 'quota_reached' | 'choices_full';
  usage?: { offer: Offer; selectionQuota: number; choiceLimit: number };
}

function selectionConflictMessage(error: ApiError, profile: MemberProfile | undefined): string {
  const detail = (error.data as { details?: SelectionConflictDetail[] } | undefined)?.details?.[0];
  const choiceLimit = detail?.usage?.choiceLimit ?? profile?.choiceLimit ?? 50;
  if (detail?.reason === 'choices_full') {
    return `Vous avez déjà ${choiceLimit} cinémas enregistrés. Retirez un cinéma mémorisé pour en ajouter un autre.`;
  }
  const offer = detail?.usage ? detail.usage.offer : profile?.offer;
  const quota = detail?.usage?.selectionQuota ?? profile?.selectionLimit;
  if (offer === 'free') {
    return `L’offre gratuite permet ${quota ?? 3} cinémas actifs. Premium permet d’en suivre jusqu’à ${choiceLimit}.`;
  }
  return quota !== undefined ? `Votre Selection est pleine (${quota} cinémas actifs).` : error.message;
}

export default function CinemasPage() {
  const queryClient = useQueryClient();
  const { user } = useContext(AuthContext);
  const isMember = user?.role_name === 'member';
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<{ message: string; trackSubmission?: boolean } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timeoutId = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  const theatersQuery = useQuery({
    queryKey: ['theaters'],
    queryFn: getTheaters,
  });
  const profileQuery = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: getMemberProfile,
    enabled: isMember,
  });
  const selectionQuery = useQuery({
    queryKey: ['selection'],
    queryFn: getSelection,
    enabled: isMember,
  });

  // Stored choices by Theater: `true` = active, `false` = remembered.
  const choiceStates = useMemo(
    () => new Map((selectionQuery.data ?? []).map((choice) => [choice.id, choice.active])),
    [selectionQuery.data],
  );
  const refreshMemberSelection = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['selection'] }),
    queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
  ]);

  // Propose a new cinema (TheaterSubmission): the synchronous outcomes resolve
  // in this response — dedup degrades to a Selection add, a genuinely new
  // cinema is queued and its resolution arrives later as a live notification.
  const [submissionUrl, setSubmissionUrl] = useState('');
  const submitMutation = useMutation({
    mutationFn: submitTheater,
    onSuccess: async (result) => {
      setSubmissionUrl('');
      if (result.outcome === 'selection_added') {
        setNotice({ message: `« ${result.theater.name} » est déjà dans le catalogue — il a été ajouté à votre Selection.` });
        await refreshMemberSelection();
        return;
      }
      setNotice({
        message: 'Proposition enregistrée. Vous serez notifié dès que ce cinéma sera disponible.',
        trackSubmission: true,
      });
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
    onError: (error: Error) => {
      setNotice({ message: error.message || 'Impossible de proposer ce cinéma.' });
    },
  });
  const filteredTheaters = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    const activeTheaters = (theatersQuery.data ?? []).filter((theater) => theater.status === 'active');
    if (!normalizedSearch) return activeTheaters;
    return activeTheaters.filter((theater) => theaterSearchText(theater).includes(normalizedSearch));
  }, [search, theatersQuery.data]);

  const addMutation = useMutation({
    mutationFn: addToSelection,
    onSuccess: async () => {
      setNotice(null);
      await refreshMemberSelection();
    },
    onError: async (error: Error) => {
      // A stale count (other tab, concurrent add, changed offer): the server
      // stays authoritative — explain the limit and reload the usage.
      if (error instanceof ApiError && error.status === 409) {
        setNotice({ message: selectionConflictMessage(error, profileQuery.data) });
        await refreshMemberSelection();
        return;
      }
      setNotice({ message: error.message || 'Impossible d’ajouter ce cinéma à votre Selection.' });
    },
  });

  const removeMutation = useMutation({
    mutationFn: removeFromSelection,
    onSuccess: async () => {
      setNotice(null);
      await refreshMemberSelection();
    },
    onError: (error: Error) => setNotice({ message: error.message || 'Impossible de retirer ce cinéma de votre Selection.' }),
  });

  const isLoading = theatersQuery.isLoading || (isMember && (profileQuery.isLoading || selectionQuery.isLoading));
  const error = theatersQuery.error || profileQuery.error || selectionQuery.error;
  const profile = profileQuery.data;
  const selectionCount = profile?.selectionCount ?? selectionQuery.data?.filter((choice) => choice.active).length ?? 0;
  const selectionLimit = profile?.selectionLimit;
  const rememberedCount = profile?.rememberedCount ?? 0;
  const isAtQuota = isMember && selectionLimit !== undefined && selectionCount >= selectionLimit;
  const isChoicesFull = isMember && profile !== undefined && selectionCount + rememberedCount >= profile.choiceLimit;

  if (isLoading) return <LoadingSpinner />;
  if (error) {
    return <ErrorMessage message={error instanceof Error ? error.message : 'Impossible de charger les cinémas.'} />;
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Le catalogue</p>
          <h1 className="mt-2 text-4xl font-bold text-gray-900">Tous les cinémas</h1>
          <p className="mt-2 max-w-2xl text-gray-600">
            Explorez les cinémas actifs et leurs horaires. Les cinémas en préparation restent invisibles jusqu’à leur première collecte.
          </p>
        </div>
        {isMember && (
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600 shadow-sm" data-testid="selection-counter">
            <span className="font-semibold text-gray-900">Ma Selection</span>
            <span className="ml-2" data-testid="selection-usage">{selectionCount} / {selectionLimit} actifs</span>
            {rememberedCount > 0 && (
              <span className="ml-2 text-gray-500" data-testid="selection-remembered">
                + {rememberedCount} mémorisé{rememberedCount > 1 ? 's' : ''}
              </span>
            )}
            {profile?.offer === 'free' && (
              <p className="mt-1 text-xs text-gray-500" data-testid="selection-offer">
                Offre gratuite : {selectionLimit} cinémas actifs. Premium : jusqu’à {profile.choiceLimit}.
              </p>
            )}
            {profile?.offer === 'premium' && (
              <p className="mt-1 text-xs text-gray-500" data-testid="selection-offer">
                Premium : jusqu’à {selectionLimit} cinémas actifs.
              </p>
            )}
          </div>
        )}
      </div>

      {isMember && profile?.selectionOverQuota && (
        <div
          className="mb-8 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900"
          role="status"
          data-testid="selection-over-quota"
        >
          Votre Selection compte {selectionCount} cinémas actifs, votre offre en permet {selectionLimit}.
          Retirez des cinémas pour retrouver votre page d’accueil — aucun n’est supprimé automatiquement.
        </div>
      )}

      {notice && (
        <div
          className="fixed bottom-6 right-6 z-50 flex max-w-sm items-start gap-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 shadow-lg"
          role="alert"
          data-testid="selection-toast"
        >
          <span className="flex-1">
            {notice.message}
            {notice.trackSubmission && (
              <Link
                to="/submissions"
                className="ml-2 font-semibold underline underline-offset-2 hover:text-amber-950"
                data-testid="submission-track-link"
              >
                Suivre l’avancement
              </Link>
            )}
          </span>
          <button
            type="button"
            className="text-sm font-semibold text-amber-800 hover:text-amber-950"
            aria-label="Fermer la notification"
            onClick={() => setNotice(null)}
          >
            Fermer
          </button>
        </div>
      )}

      {isMember && (
        <section className="mb-8 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-bold text-gray-900">Un cinéma manque ?</h2>
          <p className="mt-1 text-sm text-gray-600">
            Proposez la page AlloCiné d’un cinéma absent du catalogue. S’il est validé, il est ajouté automatiquement à votre Selection.
          </p>
          <form
            className="mt-4 flex flex-col gap-3 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (submissionUrl.trim()) submitMutation.mutate(submissionUrl.trim());
            }}
            data-testid="submission-form"
          >
            <input
              type="url"
              value={submissionUrl}
              onChange={(event) => setSubmissionUrl(event.target.value)}
              placeholder="https://www.allocine.fr/seance/salle_gen_csalle=C0153.html"
              className="flex-1 rounded-xl border border-gray-300 bg-white px-4 py-2.5 shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              aria-label="URL AlloCiné du cinéma"
              data-testid="submission-url"
            />
            <button
              type="submit"
              disabled={submitMutation.isPending || !submissionUrl.trim()}
              className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-yellow-500 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="submission-submit"
            >
              {submitMutation.isPending ? 'Envoi…' : 'Proposer ce cinéma'}
            </button>
          </form>
        </section>
      )}

      <label className="mb-6 block">
        <span className="sr-only">Rechercher un cinéma</span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Rechercher par nom, ville ou identifiant..."
          className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
          data-testid="cinemas-search"
        />
      </label>

      {filteredTheaters.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 p-12 text-center">
          <p className="font-semibold text-gray-700">Aucun cinéma trouvé.</p>
          <p className="mt-1 text-sm text-gray-500">Essayez un autre nom, une autre ville ou un autre identifiant.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredTheaters.map((theater) => {
            const choice = choiceStates.get(theater.id);
            const isSelected = choice === true;
            const isRemembered = choice === false;
            const addBlocked = isRemembered ? isAtQuota : isAtQuota || isChoicesFull;
            return (
              <article key={theater.id} className="flex min-h-52 flex-col rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <div className="flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-xl font-bold text-gray-900">{theater.name}</h2>
                      <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-gray-400">{theater.id}</p>
                    </div>
                    {isSelected && (
                      <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-800" data-testid={`selected-${theater.id}`}>
                        Dans ma Selection
                      </span>
                    )}
                    {isRemembered && (
                      <span
                        className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700"
                        data-testid={`remembered-${theater.id}`}
                        title="Mémorisé : gardé dans vos choix, absent de votre page d’accueil"
                      >
                        Mémorisé
                      </span>
                    )}
                  </div>
                  {(theater.city || theater.address) && (
                    <p className="mt-4 text-sm text-gray-600">{[theater.address, theater.postal_code, theater.city].filter(Boolean).join(', ')}</p>
                  )}
                </div>
                <div className="mt-5 flex items-center gap-2">
                  <Link
                    to={`/theater/${theater.id}`}
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-center text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
                  >
                    Voir les horaires
                  </Link>
                  {isMember && (
                    <button
                      type="button"
                      className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-black transition hover:bg-yellow-500 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isSelected || addBlocked || addMutation.isPending || removeMutation.isPending}
                      onClick={() => addMutation.mutate(theater.id)}
                      data-testid={`add-selection-${theater.id}`}
                      title={!isSelected && addBlocked
                        ? isAtQuota
                          ? `Selection pleine (${selectionCount} / ${selectionLimit} actifs)`
                          : `${profile?.choiceLimit ?? 50} cinémas déjà enregistrés`
                        : undefined}
                    >
                      {isSelected ? 'Ajouté' : isRemembered ? 'Réactiver' : 'Ajouter'}
                    </button>
                  )}
                  {isMember && (isSelected || isRemembered) && (
                    <button
                      type="button"
                      className="rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
                      disabled={removeMutation.isPending}
                      onClick={() => removeMutation.mutate(theater.id)}
                      data-testid={`remove-selection-${theater.id}`}
                    >
                      Retirer
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

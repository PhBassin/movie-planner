import { useContext, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/core.js';
import { addToSelection, getMemberProfile, getSelection, removeFromSelection } from '../api/me.js';
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

export default function CinemasPage() {
  const queryClient = useQueryClient();
  const { user } = useContext(AuthContext);
  const isMember = user?.role_name === 'member';
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

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
    queryKey: ['me'],
    queryFn: getMemberProfile,
    enabled: isMember,
  });
  const selectionQuery = useQuery({
    queryKey: ['selection'],
    queryFn: getSelection,
    enabled: isMember,
  });

  const selectedIds = useMemo(
    () => new Set((selectionQuery.data ?? []).map((theater) => theater.id)),
    [selectionQuery.data],
  );
  const refreshMemberSelection = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['selection'] }),
    queryClient.invalidateQueries({ queryKey: ['me'] }),
  ]);
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
      if (error instanceof ApiError && error.status === 409) {
        setNotice(error.message);
        await queryClient.invalidateQueries({ queryKey: ['me'] });
        return;
      }
      setNotice(error.message || 'Impossible d’ajouter ce cinéma à votre Selection.');
    },
  });

  const removeMutation = useMutation({
    mutationFn: removeFromSelection,
    onSuccess: async () => {
      setNotice(null);
      await refreshMemberSelection();
    },
    onError: (error: Error) => setNotice(error.message || 'Impossible de retirer ce cinéma de votre Selection.'),
  });

  const isLoading = theatersQuery.isLoading || (isMember && (profileQuery.isLoading || selectionQuery.isLoading));
  const error = theatersQuery.error || profileQuery.error || selectionQuery.error;
  const selectionCount = profileQuery.data?.selectionCount ?? selectionQuery.data?.length ?? 0;
  const selectionLimit = profileQuery.data?.selectionLimit;
  const isAtLimit = isMember && selectionLimit !== undefined && selectionCount >= selectionLimit;

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
            <span className="ml-2">{selectionCount} / {selectionLimit}</span>
          </div>
        )}
      </div>

      {notice && (
        <div
          className="fixed bottom-6 right-6 z-50 flex max-w-sm items-start gap-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 shadow-lg"
          role="alert"
          data-testid="selection-toast"
        >
          <span className="flex-1">{notice}</span>
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
            const isSelected = selectedIds.has(theater.id);
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
                      disabled={isSelected || isAtLimit || addMutation.isPending || removeMutation.isPending}
                      onClick={() => addMutation.mutate(theater.id)}
                      data-testid={`add-selection-${theater.id}`}
                      title={isAtLimit && !isSelected ? `Selection pleine (${selectionCount})` : undefined}
                    >
                      {isSelected ? 'Ajouté' : 'Ajouter'}
                    </button>
                  )}
                  {isMember && isSelected && (
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

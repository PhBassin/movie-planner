import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateAppearance, type Appearance, type MemberProfile } from '../api/me.js';
import { ME_QUERY_KEY } from '../api/query-keys.js';

interface AppearanceToggleProps {
  appearance: Appearance;
}

const SAVE_ERROR_MESSAGE = 'Impossible d’enregistrer votre choix. Réessayez.';

/**
 * The homepage light/dark control — the only visual control a Member owns
 * (see CONTEXT.md → Appearance). Persists server-side via `/api/me/appearance`
 * so the choice survives sessions and devices.
 *
 * Optimistic: the shared profile cache flips immediately (so `useAppearance`
 * repaints at once) and is rolled back, with a visible message, if the
 * write fails.
 *
 * Accessible as a toggle button: a stable name ("Mode sombre") whose state
 * is carried by `aria-pressed`.
 */
export default function AppearanceToggle({ appearance }: AppearanceToggleProps) {
  const queryClient = useQueryClient();
  const [saveFailed, setSaveFailed] = useState(false);

  const setCachedAppearance = (next: Appearance) =>
    queryClient.setQueryData<MemberProfile>(ME_QUERY_KEY, (current) =>
      current ? { ...current, appearance: next } : current
    );

  const mutation = useMutation({
    mutationFn: updateAppearance,
    onMutate: async (next: Appearance) => {
      setSaveFailed(false);
      await queryClient.cancelQueries({ queryKey: ME_QUERY_KEY });
      const previous = queryClient.getQueryData<MemberProfile>(ME_QUERY_KEY)?.appearance;
      setCachedAppearance(next);
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) {
        setCachedAppearance(context.previous);
      }
      setSaveFailed(true);
    },
    onSuccess: (saved) => {
      setCachedAppearance(saved);
    },
  });

  const isDark = appearance === 'dark';

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-testid="appearance-toggle"
        aria-pressed={isDark}
        onClick={() => mutation.mutate(isDark ? 'light' : 'dark')}
        disabled={mutation.isPending}
        className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-gray-100 transition"
      >
        <span aria-hidden="true">{isDark ? '🌙' : '☀️'}</span>
        <span>Mode sombre</span>
      </button>
      {saveFailed && (
        <p role="alert" data-testid="appearance-toggle-error" className="text-xs text-red-600">
          {SAVE_ERROR_MESSAGE}
        </p>
      )}
    </div>
  );
}

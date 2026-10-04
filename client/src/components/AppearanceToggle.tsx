import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateAppearance, type Appearance, type MemberProfile } from '../api/me.js';

interface AppearanceToggleProps {
  appearance: Appearance;
}

/**
 * The homepage light/dark control — the only visual control a Member owns
 * (see CONTEXT.md → Appearance). Persists server-side via `/api/me/appearance`
 * so the choice survives sessions and devices; the class on `<html>` is kept
 * in sync by `useAppearance` from the shared `['me']` cache.
 */
export default function AppearanceToggle({ appearance }: AppearanceToggleProps) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: updateAppearance,
    onSuccess: (updated) => {
      queryClient.setQueryData<MemberProfile>(['me'], (current) =>
        current ? { ...current, appearance: updated } : current
      );
    },
  });

  const isDark = appearance === 'dark';

  return (
    <button
      type="button"
      data-testid="appearance-toggle"
      aria-pressed={isDark}
      aria-label={isDark ? 'Passer en mode clair' : 'Passer en mode sombre'}
      onClick={() => mutation.mutate(isDark ? 'light' : 'dark')}
      disabled={mutation.isPending}
      className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-gray-100 transition"
    >
      <span aria-hidden="true">{isDark ? '☀️' : '🌙'}</span>
      <span>{isDark ? 'Mode clair' : 'Mode sombre'}</span>
    </button>
  );
}

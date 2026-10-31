/** Items per "Voir plus" page. */
export const SUBMISSIONS_PAGE_SIZE = 20;

/** "En cours depuis X min" for a pending attempt, from its `created_at`. */
export function pendingSinceLabel(createdAt: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - new Date(createdAt).getTime()) / 60_000);
  if (minutes < 1) return 'En cours depuis moins d’une minute';
  return `En cours depuis ${minutes} min`;
}

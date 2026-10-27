/**
 * React Query keys shared across pages and hooks. Kept in one place so a
 * cache write (e.g. the Appearance toggle) and its readers never drift.
 */

/** The Member's own profile (`GET /api/me`). */
export const ME_QUERY_KEY = ['me'] as const;

/** The Member's "Mes soumissions" pages (`GET /api/me/submissions`). */
export const MEMBER_SUBMISSIONS_QUERY_KEY = ['me', 'submissions'] as const;

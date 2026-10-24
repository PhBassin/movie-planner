import { parseStrictInt } from '../../utils/number.js';
import { ValidationError } from '../../utils/errors.js';
import type { AuthRequest } from '../../middleware/auth.js';
import type { ActingUser } from '../../services/user-service.js';

/**
 * Shared plumbing for the admin account routers (`/api/users`, `/api/members`).
 */

/** Largest page a list route returns; larger requested limits are clamped. */
export const MAX_LIST_LIMIT = 100;

/** Largest accepted offset; anything beyond is a 400, not a deep table scan. */
export const MAX_LIST_OFFSET = 10_000;

/** The authenticated Staff user acting on the request, for audit logging. */
export const actingUserFrom = (req: AuthRequest): ActingUser => ({ id: req.user!.id, username: req.user!.username });

/** Parse a URL id or throw a 400 `ValidationError` naming `label`. */
export const parseIdOrThrow = (raw: unknown, label: string): number => {
  const id = parseStrictInt(raw);
  if (Number.isNaN(id)) throw new ValidationError(`Invalid ${label}`);
  return id;
};

/**
 * Parse `limit`/`offset` query params. The limit defaults to and is clamped at
 * `MAX_LIST_LIMIT`; the offset defaults to 0 and must lie in
 * `[0, MAX_LIST_OFFSET]`. Invalid values throw a 400 `ValidationError`.
 */
export const parsePaginationOrThrow = (query: AuthRequest['query']): { limit: number; offset: number } => {
  const requestedLimit = query.limit ? parseStrictInt(query.limit) : MAX_LIST_LIMIT;
  const offset = query.offset ? parseStrictInt(query.offset) : 0;
  if (Number.isNaN(requestedLimit) || requestedLimit < 1) throw new ValidationError('Invalid limit parameter');
  if (Number.isNaN(offset) || offset < 0 || offset > MAX_LIST_OFFSET) {
    throw new ValidationError('Invalid offset parameter');
  }
  return { limit: Math.min(requestedLimit, MAX_LIST_LIMIT), offset };
};

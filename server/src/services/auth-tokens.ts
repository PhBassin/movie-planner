/**
 * Shared lifetime for the two one-purpose auth email tokens (email
 * verification and password reset). A single `const` by policy — ADR 0006
 * (sub-decision 3): 30 minutes clears any realistic SMTP delivery delay while
 * keeping a stolen token's useful window small, and one constant keeps the
 * two token lifetimes from drifting apart. Not env-tuned.
 */
export const AUTH_TOKEN_TTL_MS = 30 * 60 * 1000;

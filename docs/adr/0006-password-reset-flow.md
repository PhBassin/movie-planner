# 0006. Password-reset flow — email-keyed, single-use, session-revoking

- **Status:** Accepted
- **Date:** 2026-07-23

## Context

Issue #2 (the SaaS transformation) opens a self-registering **Member** actor whose identity is an **email** (Staff, by contrast, identify by `username` and are Admin-created). The SMTP mailer introduced there carries two payloads: **email verification** and **password reset**. This ADR closes the password-reset half — verification has its own concerns and is not decided here.

The open questions in issue #2 were: *token lifetime, single-use vs reusable, and what happens to existing Sessions on reset.* Three things make these non-trivial:

1. **A reset is an unauthenticated credential change.** Unlike `changePassword` (which requires the current password as proof), reset proves identity only through email ownership at click-time. Every parameter (lifetime, reuse, session handling) is a trade between "a legitimate Member can recover" and "an attacker who briefly controls the inbox cannot entrench."
2. **There is a direct precedent to stay symmetric with.** `SessionService.changePassword` (`server/src/services/session-service.ts:228`) calls `revokeAllUserTokens(db, userId)` immediately after the password write — "changing the password nukes every Session on every device." Reset reaching a *different* session outcome would be a surprise-driven asymmetry.
3. **The public request endpoint is an abuse surface.** A public, email-keyed `POST …/password-reset/request` is both an **enumeration oracle** ("does this email belong to a Member?") and an **email-bombing vector** (flood one Member's inbox). Both are pure policy — no implementation detail closes them.

Relevant existing infrastructure: the rate-limit middleware with per-endpoint arms (`authLimiter`, `registerLimiter` in `middleware/rate-limit.js`) resolved from `RateLimitConfig` (`services/rate-limit-source.ts`); the `refresh_tokens` table and its cleanup; `validatePasswordStrength` (`utils/security.ts`).

## Decision

**Password reset is Member-only, email-keyed, single-use, and revokes every Session on success — mirroring `changePassword`.** The requester is then redirected to log in; reset never mints a Session itself. The decision was reached by grilling (issue #2, *Password-reset flow specifics*); the seven sub-decisions below are the resolution.

1. **Member-only, keyed by email.** The reset request looks up by `email` and serves only Users with the `member` role. **Staff password reset stays Admin-mediated** through the existing admin user-management path. Email is guaranteed on Members and nullable on Staff, so an email-keyed flow cannot reliably serve Staff anyway; Staff are few and Admin-created, so self-service reset for them would add username-enumeration surface for no real gain. Keeping the public endpoint to one key (`email`) and one population makes the enumeration defense trivially correct.

2. **Strictly single-use; a new request supersedes prior outstanding tokens; one live token per Member.** Consuming a token marks it used (and rejects any second submission with it). Requesting a reset while a prior token is still outstanding **invalidates** that prior token — at most one live reset token per Member at a time. This bounds the validity window to "from request until use or supersession," prevents a leaked-but-unused token from lingering after the Member recovered by other means, and keeps the shape symmetric with the verification token (one current truth per Member). The cost — a Member who double-clicks "send" gets only the latest link working — is the desired behavior; UX copy says so.

3. **30-minute lifetime, a single `const`, not env-tuned, shared with the verification token.** `const AUTH_TOKEN_TTL_MS = 30 * 60 * 1000` lives in the auth module and is read by both reset and verification. 30 minutes clears any realistic SMTP delivery delay so a legitimate Member essentially never sees "expired" on first try, while keeping a stolen token's useful window small (and already tightly bounded by hashed storage, single-use, and supersession). This follows issue #2's own rule that **product/security *policy* is a const** while only **infra *tuning*** (e.g. the submission throttle) is env-configured. A single lifetime constant for both auth tokens avoids two values drifting apart for no reason.

4. **A successful reset revokes all the Member's Sessions — identical to `changePassword`.** Reset's terminal step calls the same `revokeAllUserTokens(db, userId)` (`server/src/services/session-service.ts:236`). Reset and change-password are two routes to the same event ("this User's password is now different"); giving them different session outcomes would be a bug-prone asymmetry, and a meaningful fraction of resets are *because* the Member suspects compromise — in which case killing the attacker's Sessions is the entire point.

5. **Redirect to login after reset; reset never mints a Session.** `/api/auth/login` stays the **sole** Session-issuance path (today and after this ADR). A reset endpoint that also auto-logged-in the clicker would be a *second* Session-minting surface keyed off a token-click instead of a password proof — two issuance paths to audit and keep symmetric. Requiring the Member to log in with the new password also (a) confirms they actually know it, catching a typo'd new password *during* recovery rather than on the next failed visit, and (b) resolves the suspended/unverified edge cases for free (see below). The UX cost is one extra screen — the same "reset → log in" flow the industry uses universally.

6. **Enumeration-safe request endpoint + two-axis rate limit.**
   - **Always-200, identical body, normalized timing** — whether or not the email matched a Member, and whether that Member is active/unverified/suspended. Critically the *no-match* path must not be observably faster than the *match-and-send-SMTP* path (a fixed minimum latency, or a fire-and-forget background send, closes the timing oracle). This is the part teams forget, and it is the one that actually leaks membership. Enumeration here directly undermines the verification-gate abuse control (ADR 0003), so it is load-bearing, not cosmetic.
   - **Two rate-limit axes**, both env-tuned as a new arm of `RateLimitConfig` (peer of `auth`/`register`):
     - **Per-IP** (the existing limiter shape) — caps one source spraying the endpoint.
     - **Per-email** (new) — caps how many reset emails land in *one* inbox in a window. This is the defense against email-bombing an inbox, which per-IP alone misses (rotating IPs still hits one inbox). With supersession (sub-decision 2), bombardment also DOSes the Member's legitimate in-flight token, so the per-email throttle is doubly justified. The *numbers* are tuning and are not decided here, consistent with how the submission throttle's thresholds are handled.

7. **Send a post-reset confirmation email.** On a successful reset, the same mailer sends a token-less notification ("your password was changed at \<time\>; if this wasn't you, [reset it / contact support]") to the address. It is the only signal a non-initiating Member gets — if someone else triggered the reset, the Member typically won't know until they are next locked out. It carries no token (cannot be replayed) and always sends once the reset succeeded (no new oracle on the hardened request endpoint). It is explicitly **not** a recovery mechanism against full inbox compromise — only against the "reset happened without my knowledge but I still read this inbox" case, which is the case the confirmation email exists for across the industry.

### Resolved as consequences of the above (no separate grilling)

- **Unverified Members may reset.** They can log in (only `suspended` blocks login), so reset is consistent; allowing it opens no new hole, because the **verification** flow (ADR 0003) is already the email-ownership gate — an attacker who controls the unverified email could just complete verification instead.
- **Suspended Members may reset.** Reset ≠ login: the suspended Member requests a link (enumeration-safe), resets, and is redirected to login, which correctly refuses them per the existing "suspended blocks login" rule. Reset does not unsuspend; the right behavior falls out of sub-decision 5 with no special case.
- **Reset does NOT change verification status.** Verification and password-reset are disjoint concerns; a reset does not verify an unverified Member.
- **Token storage and GC are implementation detail.** Tokens are stored hashed, with expiry (issue #2 schema). Expired/consumed rows are swept by a periodic GC in the shape of the existing `refresh_tokens` cleanup. The exact route path (`POST /api/auth/password-reset/request` + `POST /api/auth/password-reset/confirm`, or similar) and the new-password strength check (reuse `validatePasswordStrength`) are also implementation detail.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Reset also serves Staff (username-keyed) | `email` is nullable on Staff, so the flow cannot reliably serve them; Staff are few and Admin-created, so self-service adds a username-enumeration surface for a population that doesn't need it. Admin-mediated reset is one hop. |
| Reusable reset tokens | A standing credential-theft risk for zero benefit — a Member who needs to reset again can request a new link. Single-use is the natural completion of "hashed, with expiry." |
| N concurrent live tokens per Member (tolerate double-clicks) | Double-click is already handled by supersession + idempotent consume. N tokens widen the validity window and let a leaked token linger after recovery. |
| 15-minute lifetime | Too tight for a laggy shared SMTP relay — a legitimate Member's first experience of the feature would be "expired." |
| 1-hour lifetime | Looser than necessary given the other bounds (hashed, single-use, superseded) already shrink exposure. |
| Env-tuned lifetime | Violates issue #2's rule that product/security *policy* is a const, only infra *tuning* is env-configured. An operator who needs a different window changes the constant. |
| Reset keeps other Sessions alive (gentler than changePassword) | Two routes to the same event ("password is different") with different session outcomes is a surprise-driven asymmetry; and it defeats the suspected-compromise use case, where killing other Sessions is the point. |
| Auto-login on successful reset | Creates a second Session-minting path (token-click instead of password proof); loses the "confirm I know the new password" catch; forces explicit special-casing for suspended Members. |
| Reveal "no such email" on the request endpoint | A direct enumeration oracle, undermining the verification-gate abuse control (ADR 0003). |
| Per-IP rate limit only | An attacker rotating IPs can still bombard one Member's inbox; supersession turns that into a DOS of the Member's legitimate recovery. Per-email closes it. |
| No post-reset confirmation email | Removes the only signal a non-initiating Member gets; the email is cheap (one more transactional mail on a path that already sends one) and is standard industry practice. |

## Consequences

**Easier:**
- One Session-minting path (`/api/auth/login`); reset only changes the password.
- Reuses `revokeAllUserTokens` — no new revocation mechanism, and reset/change-password stay symmetric.
- Suspended/unverified edge cases fall out of the architecture with no special-casing.
- One token-lifetime constant shared with verification; the two auth tokens cannot drift.
- The request endpoint's defenses (enumeration + two-axis throttle) reuse the existing `RateLimitConfig` arm pattern.

**Harder:**
- A Member who resets is logged out of every device, including the one they reset from (expected and industry-standard, but a UX consideration in copy).
- Timing normalization adds a small delay on the no-match path, or requires a fire-and-forget send (a minor implementation care).
- The per-email rate limit is a new limiter axis (small, but new).
- A confirmation email is a second email on the reset path (cheap, but real mail volume and a bounce/complaint path to monitor).
- Reset tokens need a GC sweep (reuses the `refresh_tokens` cleanup shape — no new mechanism, but a new table to sweep).
- The no-match path silently drops the request (no email sent); this is correct but means logs/observability must distinguish "sent" from "silently dropped for non-Member email" without leaking it to the caller.

## Cross-references

- CONTEXT.md — *Authentication → Session*: password change **and** email reset both revoke all Sessions.
- ADR 0003 — the verification gate; this ADR relies on it to make reset-for-unverified-Members safe (no new hole).
- ADR 0004 — Member erasure; the Member states that can self-serve (unverified/active) align, and suspended-Member reset is consistent with suspended-Member erasure being Admin-mediated.
- ADR 0005 — confirms email is auth-only (verification + reset); this ADR is the reset half of that scope.
- issue #2 — *Password-reset flow specifics*, the open grilling topic this ADR resolves.

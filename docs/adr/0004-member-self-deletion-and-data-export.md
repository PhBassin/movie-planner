# 0004. Member self-deletion and data export (RGPD erasure & portability)

- **Status:** Accepted
- **Date:** 2026-07-22

## Context

movie-planner is being opened to a self-registering **Member** actor (issue #2). The fork inherits an **Admin-only** user-deletion path (`DELETE /api/users/:id` → `userService.deleteUser` → `DELETE FROM users`, guarded by a last-admin invariant), and `refresh_tokens` already cascade on user deletion. Two RGPD rights bear on Members:

- **Article 17 — right to erasure.** A Member must be able to have their personal data removed.
- **Article 20 — right to data portability.** A Member is entitled to receive the personal data they provided, in a structured, machine-readable form.

Two complications make this non-trivial:

1. A Member does not only *consume* data — via a **TheaterSubmission** they can introduce **Theaters** into the *shared* catalog (CONTEXT.md: "A Member does not own Theater rows"). Deleting a Member therefore brushes against shared data that other Members (and Visitors) may rely on.
2. The per-Member **submission throttle** (ADR 0003) is keyed to the Member row. Hard-delete frees the email immediately, so a Member could self-delete and re-register to reset the throttle — a bypass of an abuse control the docs call load-bearing.

The open question in issue #2 was: *can a Member self-delete and/or export their data, or is deletion Admin-only?*

## Decision

**Self-deletion is a first-class Member power, and a minimal JSON data export ships alongside it.** Both are Member-scoped; Admin-deletion keeps its existing shape. The decision was reached by grilling (issue #2, *Account self-service deletion & data export*); the eight sub-decisions below are the resolution.

1. **Immediate, hard, terminal.** Self-deletion is a single irreversible transition `active → deleted`. No soft-delete, no grace window, no reactivation. This matches the codebase-wide hard-delete philosophy (ADR 0001 for Theaters; the `refresh_tokens` cascade) and the strongest RGPD posture — erasure that actually erases, not "soft-deleted for 30 days." The `suspended ↔ active` pair remains the *only* reversible cut-off; deletion stays cleanly terminal.
2. **Cascade rule — what erasure removes vs retains.** Deleting a Member removes: their identity and credentials, all their **Sessions** (via the existing `refresh_tokens` cascade), their **Selection**, their **Appearance**, and their **TheaterSubmission** rows. It does **not** remove any **Theater** — whether `active` or still `provisioning` — that the Member introduced into the shared catalog. The submitter is not the owner; the catalog is single-source and Staff-curated. The new `member_selections`, `member_preferences`, and `theater_submissions` tables are defined with `ON DELETE CASCADE` on `member_id`.
3. **No email tombstone; the throttle-reset hole is accepted.** No email hash or residue is retained after erasure. A Member may therefore self-delete and re-register with the same email to reset their submission throttle. This is accepted on the threat model: the abuser's payoff is near-zero (successful submissions enrich the shared catalog; bogus ones fail fast), each re-registration re-imposes **email verification** friction, and the **upstream source's 429 cascade** (`handleRateLimit` → `not_attempted`) is a hard backstop no client-side reset can bypass. The per-Member throttle is a politeness control, not the last line. A tombstone is a purely additive future option if real abuse materializes; choosing clean deletion now does not foreclose it.
4. **Stale `provisioning` Theaters are not coupled to Member deletion.** A failed submission may leave a `provisioning` Theater that no one else selected. It is harmless (hidden from Members) and is **not** garbage-collected by the delete path. Cleaning up such orphans is a Staff operational concern, separate from user lifecycle.
5. **Password re-entry gates self-deletion.** Because the Session's CSRF token cannot defend against a hijacked Session or a shared device, self-deletion requires the Member to re-enter their current password (verified server-side) before the irreversible delete. Admin-deletion does **not** require the target's password (the Admin is the authority) and keeps its existing `users:delete` permission + last-admin guard.
6. **Minimal JSON export.** A read-only Member-scoped route returns a single JSON document of the Member's personal data: account (`email`, `created_at`, status — never the password hash), the **Selection**, the **Appearance**, and the full **TheaterSubmission** history (url, status, timestamps, resolved `theater_id`). Export needs no gate beyond the normal Session — it is non-destructive. The submission history is included because submissions are the Member's own acts and are erased on deletion, making export the only moment they remain visible.
7. **Suspended Members are Admin-mediated only.** A suspended Member cannot log in (only `suspended` blocks login), so cannot reach either self-serve route. Deletion and export for a suspended Member go through Staff via the existing admin-delete path. This prevents an abuse-suspended Member from destroying their TheaterSubmission history (the evidence of the abuse) and costs nothing new to build. Article 17(3)(e)/(b) covers the holding period; the right is routed through Staff, not refused.
8. **Unverified Members** log in normally and self-delete/export via the same path as any Member; no special case.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Deletion Admin-only (today's behavior) | Contradicts the "Member-first" framing; makes Staff the RGPD bottleneck; the delete primitive already exists so self-service is cheap. |
| Soft-delete with a grace window (`deleted_at`, 14–30d, cron purge, reactivation) | Adds a new FSM state, a scheduler, a reactivation path, and reintroduces the "data lingers after erasure" smell RGPD opposes — for an accidental-delete risk that password re-entry covers cheaper. |
| Cascade-delete Theaters a Member introduced (esp. failed-submission provisioning rows) | Couples shared-catalog integrity to user lifecycle; re-introduces a Theater-ownership concept the model deliberately rejects; risks nuking cinemas others may want. |
| Anonymize (null `member_id`) submission rows instead of cascading | Dead-weight shadow rows that complicate the hard-delete story; submission status is Member-facing ("Mes soumissions") and unreadable once the Member is gone. |
| Email-hash tombstone (expiring or permanent) to block throttle reset | Disproportionate engineering for a low-severity hole; smuggles back lingering data; the real defenses (re-verification friction + upstream 429) hold. Kept as an additive future option. |
| Out-of-band email link to confirm deletion | A fourth mailer use case (vs verification + reset) and a wider unauthenticated destructive surface; in-band password proof is sufficient for deletion. |
| "Type your email" confirmation | Defends only against misclicks, not a hijacked Session that can read the email via `/me`. Password re-entry is strictly stronger for equal cost. |
| Defer data export (erasure-only) | Article 20 is technically in play for Member-provided data, the data set is tiny, and export is one read-only route over tables already being built — the marginal cost doesn't justify holding out. |

## Consequences

**Easier:**
- Deletion semantics stay uniform with the rest of the codebase (hard-delete + CASCADE; no soft-delete special case).
- The shared-catalog invariant is untouched by user lifecycle — no Member, past or present, can change what Theaters exist.
- RGPD erasure and portability are both satisfied with two Member-scoped routes, reusing the existing delete primitive and the new Member tables.
- No new mailer use cases and no scheduled cleanup jobs.

**Harder:**
- The submission throttle has a known, accepted bypass (delete + re-register). Documented here so a future maintainer who wants to close it reaches for the additive tombstone rather than re-deriving the trade-off.
- Stale `provisioning` Theaters from failed submissions can accumulate until Staff clean them up operationally — a separate concern the delete path deliberately does not address.
- A regretted self-deletion is unrecoverable (acceptable for a cinema SaaS with no financial/irreplaceable data; the Member simply re-registers).
- Suspended Members cannot self-serve; Staff are the path for their erasure/export requests, and must judge when the abuse-investigation need has passed.

## Cross-references

- CONTEXT.md — *Member data*: **Member erasure**, **Member data export**; *People & roles → Member* lifecycle (`deleted` state).
- ADR 0001 — hard-delete + CASCADE as the codebase-wide deletion philosophy.
- ADR 0003 — the submission throttle whose reset-bypass this ADR accepts.

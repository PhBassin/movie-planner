# 0007. No owner entity — "admin général" is the `admin` role

- **Status:** Accepted
- **Date:** 2026-07-23

## Context

movie-planner is staffed by an `admin` **system role** (`is_system = true`, `name = 'admin'`), identified by two predicates together in `isAdminUser` (`server/src/middleware/auth.ts:46`): `role_name === 'admin' && is_system_role === true`. Holders of this role get a **hardcoded permission bypass** (`server/src/middleware/permission.ts:26` — `if (isAdminUser(req.user))` skips every `requirePermission` check). System roles (`admin`, `operator`) are themselves protected from edit or deletion.

Two facts about today's model matter:

1. **Multiple peer admins are already supported and encouraged.** Docs recommend a "backup admin account" and "at least 2 admin users." The **last-admin invariant** (`services/user-service.ts:assertNotLastAdmin` → `db/user-queries.getAdminCount`) protects the *count* (≥ 1), firing on both delete and demote, centralized so new entry points cannot bypass it (`docs/architecture-server.md:110`). It protects against lockout — it does **not** single out an individual.
2. **There is no `is_owner`, `is_primary`, or user-id-1 special-casing anywhere.** The first-boot bootstrap creates a user *named* `admin` (`migrations/007_seed_default_admin.sql` + `db/migrations.ts`), but that user is never subsequently distinguished from any other admin — `isAdminUser` looks at role + system flag, never at id or username.

CONTEXT.md nonetheless described the role with the French phrase **"admin général"** ("The 'admin général' of movie-planner is an Admin"), which carries a singular connotation ("the general manager") that the model does not actually have. Issue #2 flagged the ambiguity for grilling: *is the singular platform operator a distinct concept from the `admin` role, or is "the Admin" just whichever user holds the role?*

## Decision

**"Admin général" is vocabulary for the `admin` role — not a distinct entity, sub-role, or flagged user. There is no singular owner/primary admin in the model.** The decision was reached by grilling (issue #2, *Admin général concept*); the three sub-decisions below are the resolution.

1. **Vocabulary, not entity.** "Admin général" is a *role description* for any holder of the `admin` system role. The model has one role with N peer holders and a uniform hardcoded bypass; it has no `is_owner` flag, no "user 1 is the founder" rule, and no sub-role. CONTEXT.md is sharpened to state this explicitly and to stop implying singularity. The term is **retained** (francophone docs and users naturally say "admin général" to mean "the person who runs this") — only the false singularity is removed; the word is not banned.

2. **Full peer admins, no reserved powers.** Every admin has identical powers; no operation is reserved to a singular admin. This is the only consistent reading of sub-decision 1: the hardcoded bypass at `permission.ts:26` grants *every* admin *all* powers uniformly, and reserving a power would require distinguishing admins — which needs the entity this ADR rejects. Concretely, Branding edits (the `app_settings` singleton), Member suspension/reinstatement, RGPD mediation for suspended Members (ADR 0004), and admin-vs-admin mutation are all **peer Staff actions**. The only constraint on admin-vs-admin mutation is the existing last-admin count guard.

3. **The Member/SaaS transformation introduces no new singular-admin need; the sole trigger to revisit is billing/ownership.** Walking the SaaS-era admin touchpoints: Branding is a singleton resource (peer-compatible), Member suspension is a peer Staff duty, RGPD erasure for suspended Members is "Admin-mediated" by *any* admin (ADR 0004), and submissions require no approval step at all (ADR 0003 — auto-scrape). The arrival of Members changes *what* admins do, not *how many* must do it. The one realistic future driver of a real owner concept — **billing/instance ownership** — is explicitly out of scope (issue #2). Until and unless billing enters scope, an owner concept has no behavioral consequence and would be a flag with no logic behind it.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| **(A)** A distinct owner entity — `is_owner` flag, sub-role, or "user id 1 is the owner," with irrevocable powers (can't be demoted/deleted by peer admins) | Adds a flag + a new invariant ("can't demote/delete the owner") + a UI distinction + a transfer-ownership path, for **zero behavioral payoff today** — nothing an owner would do is something a peer admin can't already do. Once added, an `is_owner` flag is hard to remove. Premature for a SaaS with no billing. |
| **(C)** Retire the term "admin général" entirely; speak only of "Admin" and "Staff" | Too aggressive — loses a useful francophone product word. The problem is the *false singularity*, not the word itself; keeping it as a role description preserves vocabulary while killing the misleading connotation. |
| Reserve a power to a singular admin (e.g. "only the founder edits Branding") | Inconsistent with sub-decision 1 — the hardcoded bypass grants all admins all powers uniformly; enforcing a reservation requires distinguishing admins, which needs the rejected entity. You cannot have "no owner flag" *and* "only the owner edits Branding." |
| A transfer-ownership feature (succession of the singular operator) | Presupposes an owner entity to transfer. With peer admins, succession is the existing path: grant the `admin` role to a successor (or they already hold it as a backup); the last-admin invariant prevents stranding the instance. No new route or UI. |
| Treat the bootstrap user (`username = 'admin'`) as the owner | That user is just the first admin; nothing in code distinguishes it (the `migrations.ts` role-fix is a safety nicety, not a status grant). Elevating it to owner would invent a rule the codebase has never had. |

## Consequences

**Easier:**
- No schema change, no code change, no UI change — the model already works this way; this ADR only makes the intent explicit and the vocabulary honest.
- The last-admin invariant stays exactly as-is (count-based, peer); no new owner-protection invariant to maintain or centralize.
- Future maintainers inherit a documented answer to "should there be an owner?" instead of re-deriving it — and a concrete revisit trigger (billing).
- The peer-admin/backup-admin operational guidance remains valid; nothing in the SaaS work invalidates it.

**Harder:**
- A future billing/ownership requirement will force a real revisit (introducing an owner entity then). This is documented as the trigger, not a defect — speculative introduction now would be premature.
- The French term "admin général" continues to carry a singular connotation in casual use; the glossary sharpening must be the canonical correction, and docs/UI labelling should avoid implying "the one admin."
- With no owner entity, admin-vs-admin accountability is by audit log (`changed_by` user), not by a designated principal — acceptable for the current scale, but worth noting if admin rosters grow.

## Cross-references

- CONTEXT.md — *People & roles → Staff → Admin* (sharpened: "admin général" is a role description, not an entity; multiple peer admins).
- ADR 0003 — submissions auto-scrape with no admin approval step (one fewer candidate for a singular-admin duty).
- ADR 0004 — RGPD erasure for suspended Members is Admin-mediated by *any* admin (peer, not singular).
- issue #2 — *Admin général concept*, the open grilling topic this ADR resolves; billing explicitly out of scope.

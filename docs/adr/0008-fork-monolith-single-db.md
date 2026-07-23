# 0008. Fork-the-monolith — permanent diverge from allo-scrapper, single DB

- **Status:** Accepted
- **Date:** 2026-07-23

## Context

movie-planner began as a copy of **allo-scrapper** — the Staff-operated theater showtimes aggregator. The relationship is *not* a GitHub fork: `PhBassin/movie-planner` is an independent repo (`fork: false`, `parent: null`, no fork lineage), created as a detached copy with only an `origin` remote (no `upstream`). Meanwhile **`PhBassin/allo-scrapper` remains a separate, actively-maintained repo** (created 2026-02-14, pushed 2026-07-22, default branch `develop`, public, MIT). There are two live repos, both evolving.

The copied codebase still wears allo-scrapper's identity throughout — `package.json` name `allo-scrapper` (v4.8.1, `private: true`), Docker images `ghcr.io/phbassin/allo-scrapper`, deploy paths `/opt/allo-scrapper`, the `allo-scrapper_postgres-data` volume, and most `docs/*` titled "allo-scrapper." This is legacy drift from the copy, not a statement of relationship (see Consequences).

Issue #2 records the original choice as *"fork monolithique, single DB"* and flags it as ADR-worthy because it is hard to reverse and has a real trade-off vs. the alternatives (a separate app sharing allo-scrapper's DB, or a separate app consuming allo-scrapper via API). Two things make the decision non-trivial and load it onto the existing ADRs:

1. The Member SaaS layer adds operations that are **transactionally coupled** to the catalog — the **Selection cap** (`SELECT … FOR UPDATE` on the Member's `users` row, covering both the explicit add and the submission auto-add) and the **terminal-resolution sequence** in ADR 0005 (write submission status → auto-add/cap-block → publish, in one transaction). The `theater_submissions.report_id` join to `ScrapeReport` is a same-DB relationship the resolver and reconciliation both depend on.
2. movie-planner **reuses the entire inherited stack verbatim** — catalog (Theater/Showtime/WeeklyProgram/Source), scraping pipeline, RBAC, Session mechanism (issue #2). It depends on the whole of allo-scrapper, not a narrow slice of it.

The open question was: *what is movie-planner's intended ongoing relationship to the allo-scrapper upstream, and was fork-the-monolith actually the right architectural call vs. integrating from outside?*

## Decision

**movie-planner is a permanent, irreversibly-diverged fork of the allo-scrapper monolith, owning its single DB and its future entirely. There is no upstream tracking and no re-convergence; allo-scrapper is not a dependency.** The decision was reached by grilling (issue #2, *Fork decision as an ADR*); the three sub-decisions below are the resolution.

1. **Permanent diverge — two independent products.** movie-planner does not track allo-scrapper as upstream (no `upstream` remote now, none to be added), does not pull from it, and will never re-converge. The two repos share an *origin*, not a *destination* — allo-scrapper is a Staff-operated showtimes aggregator; movie-planner is a Member-facing cinema SaaS. Each follows its own direction. A genuine bug fixed in allo-scrapper reaches movie-planner only by **deliberate, on-demand port** (see Consequences), not by any sync ritual. This matches what the repo already says in practice: independent repo, no upstream remote, schema and routes already diverging under the Member SaaS work.

2. **Fork-the-monolith was the right call — for two reasons.** (a) **Transactional integration.** The Member layer's load-bearing operations — the Selection cap under `SELECT … FOR UPDATE`, ADR 0005's sequenced terminal resolution, the `report_id` join between submissions and ScrapeReports — require single-DB, single-process atomicity. An API-consumed split cannot provide it (the scrape resolution lives inside allo-scrapper; the auto-add + cap would run in a different DB with no enforceable cross-DB FK and no shared transaction), and a shared-DB-separate-app keeps atomicity but couples two deployables to one schema against the codebase's "centralize invariants in services" pattern — on top of the scraper microservice that already shares the DB cross-process. (b) **Wholesale reuse.** movie-planner reuses the catalog, scraper, RBAC, and Sessions wholesale; copying the monolith *is* the reuse mechanism. An integration approach would pay the coupling cost (API contract maintenance / cross-app schema coordination) while gaining no independence, because movie-planner depends on the entirety of allo-scrapper anyway. Owning the whole monolith is the cheapest way to get both atomicity and reuse.

3. **`allo-scrapper` naming is legacy, not relational.** The `allo-scrapper` strings throughout the repo (`package.json` name, Docker image, deploy paths, volume, docs titles) are cosmetic drift from the copy. They are **not** a statement that movie-planner depends on, tracks, or is derived-from allo-scrapper in any ongoing sense. The full mechanical rename is **deferred to a separate, scoped operational cleanup** — it touches the image registry, CI, the deployed VPS (existing `allo-scrapper_*` volumes, `pull_policy`, cron, backup scripts), and that cross-cutting infra risk is orthogonal to the SaaS decision and must not ride along on Member-feature work. The package is `private: true`, so the npm `name` is harmless to leave. This ADR is what makes the debt legible instead of confusing; the rename is what eventually retires it.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| **Track upstream** (allo-scrapper canonical; movie-planner periodically merges scraper/catalog fixes via an `upstream` remote) | High-cost, low-value, and worsening daily. The Member layer touches the same tables/routes a scraper-fix upstream would touch; each merge collides with diverging local code, and the collision surface grows with every Member-era commit. Syncing pays off when directions align — here they don't (operator tool vs. consumer SaaS). Also contradicts what the repo already is (no upstream remote). |
| **Consolidate / declare allo-scrapper deprecated** (movie-planner is the rename+successor; allo-scrapper winds down) | Contradicted by the evidence: allo-scrapper was pushed 2026-07-22 and is actively maintained, not winding down. Declaring it the predecessor would be a deprecation the upstream hasn't signaled. If consolidation is ever the goal, that's a future decision; recording it now would be a false claim. |
| **API-consumed** (movie-planner is a separate app reading/writing allo-scrapper via its HTTP API) | Breaks the transactional integration the Member layer is built on. The scrape resolution lives inside allo-scrapper; the Selection auto-add + cap would run in movie-planner's DB against a Theater id in allo-scrapper's DB — no shared transaction, no enforceable cross-DB FK, eventual consistency with strictly more failure modes. ADR 0005's sequenced single-transaction resolution becomes impossible. |
| **Shared-DB-separate-app** (movie-planner is a separate app sharing allo-scrapper's Postgres) | Keeps atomicity but couples two deployables to one schema — coordinated migrations, schema changes in one app breaking the other. The scraper microservice *already* shares the DB cross-process; adding a second app doubles that coupling against the codebase's "centralize invariants in services" pattern. All cost, no independence — movie-planner depends on the whole catalog anyway. |
| **Keep `allo-scrapper` naming as-is, silently** (no ADR mention) | Leaves the drift actively misleading — a future maintainer reads `package.json: allo-scrapper` and reasonably infers a dependency or upstream relationship that does not exist. Recording it as legacy in this ADR is what neutralizes the confusion; the mechanical rename is deferred for risk, not for silence. |
| **Rename now, as part of the SaaS work** | Mixes a high-blast-radius infra change (registry, CI, VPS volumes, cron, backups) into Member-feature work for zero Member-feature value. The rename is orthogonal and gets its own scoped task. |

## Consequences

**Easier:**
- movie-planner owns its entire stack (catalog, scraper, Member layer) in one app/DB, preserving the transactional coherence that ADRs 0003 and 0005 depend on — no cross-process or cross-DB coordination for the load-bearing Member operations.
- No upstream-sync overhead: no merge-conflict tax, no `upstream` remote to maintain, no release-review cadence. The team evolves movie-planner without consulting allo-scrapper's direction.
- The naming debt is documented and demystified — future maintainers read `allo-scrapper` as "legacy string from the fork," not as a relationship.

**Harder:**
- **Upstream fixes are ported on-demand, not automatically.** A scraper-parser bug fixed in allo-scrapper does not flow to movie-planner; it must be deliberately ported if and when it bites. This is the accepted price of intentional divergence — and the reason to watch allo-scrapper's changelog opportunistically, not on a schedule (a cadence would be half-tracking-upstream, contradicting this ADR).
- **The full `allo-scrapper` → `movie-planner` rename is deferred but still owed.** It remains a real, if cosmetic, debt across `package.json`, the Docker image/registry, CI, deploy paths, the `allo-scrapper_postgres-data` volume, cron, and backup scripts. A dedicated task must eventually retire it; until then, the strings are legacy-naming-only per sub-decision 3.
- **The fork is irreversible.** Member-era schema (`member_selections`, `member_preferences`, `theater_submissions`), changed routes, and ADRs 0003–0007 have diverged the codebase past the point where un-forking back to an API-consumer model is economic. This is stated so no one later treats the fork as reversible or proposes "rejoining" allo-scrapper.
- **`docs/agents/issue-tracker.md`** previously pointed issues at `PhBassin/allo-scrapper`, which was already factually wrong (issues are filed on `PhBassin/movie-planner`). Corrected to movie-planner alongside this ADR — a one-line correctness fix with zero infra risk, not part of the deferred rename.

## Cross-references

- CONTEXT.md — opening "fork of allo-scrapper" statement (now cross-references this ADR).
- ADR 0003 — the submission/throttle model whose immediate-scrape + auto-add flow depends on single-DB transactional integration.
- ADR 0005 — the notification/resolution model whose sequenced single-transaction resolution (status → auto-add/cap-block → publish) this fork preserves.
- issue #2 — *Fork decision as an ADR*, the open grilling topic this ADR resolves; "fork monolithique, single DB" framing.

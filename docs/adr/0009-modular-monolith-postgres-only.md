# 0009. Modular-monolith topology — single image (web + worker), Postgres-only

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

The SaaS transformation raised the runtime-topology question: *does the platform need as many containers as it has today?* movie-planner runs **four app containers** — `server` (Express API), `client` (Vite dev server), `scraper` (consumer), `scraper-cron` (scheduler) — plus **two stateful components**, Postgres and Redis. The scraper is a separate codebase/image (`Dockerfile.scraper`) that shares a wire-protocol package (`packages/scraper-protocol`) with the server. Redis carries four cross-process channels: the `scrape:jobs` queue (server → scraper) and three ephemeral pub/sub fan-outs (`scrape:progress`, `scraper:schedule:changed`, `member:notices`).

The platform is **single-instance by design** (CONTEXT.md: "single shared catalog, not per-org data; there is no 'tenant' entity") — a hosted product members sign up for, not a multi-tenant resale. The guiding values for the target topology were stated up front: **simple now, a clean seam to extend later, no over-engineering.** The topology was decided by grilling; the five sub-decisions below are the resolution. The migration itself (rewiring the bus, merging codebases, the multi-stage Dockerfile) is **execution work separate from this decision** — this ADR locks the target shape and the principle, not the implementation steps.

## Decision

**Consolidate to one codebase/image with two process roles (`web`, `worker`), backed by Postgres alone.** Drop the separate scraper image, drop Redis, drop the prod `client` container. The web/worker module boundary is the deliberate extensibility seam.

1. **Modular monolith — one image, two process roles (A.3).** The API and the scraper become one codebase and one Docker image, run as two roles by entrypoint: `web` (HTTP API + SSE fan-out + serves the SPA) and `worker` (consumes scrape jobs + runs them). The failure-domain isolation the separate scraper buys today is preserved — the worker is a distinct process, so a scrape crash or OOM does not take down request-serving. The `packages/scraper-protocol` wire types become internal modules; the double-declaration sync burden disappears. Rejected: a pure in-process monolith (scraping shares the request process — the coupling the split exists to avoid) and the status-quo separate-service split (over-engineering for a single-instance platform).

2. **Postgres-only — drop Redis (B.2).** The job queue moves to a Postgres `scrape_jobs` table consumed with `FOR UPDATE SKIP LOCKED`; the three ephemeral pub/sub fan-outs move to `LISTEN/NOTIFY`. This fits the domain exactly: all three pub/sub channels are **ephemeral by design** (CONTEXT.md — `member:notices` is "dropped if none are connected"; the submission row persists the outcome; `schedule:changed` is a reload nudge against a DB that stays source of truth; `ProgressEvent`s are volatile telemetry), so `LISTEN/NOTIFY`'s no-persistence is a feature, not a loss. The `SKIP LOCKED` queue is transactional — enqueue can share the business-write transaction, a stronger property than a Redis list. One stateful component to back up, monitor, and secure instead of two. Rejected: keep Redis (a second stateful datastore for a single-instance app is the textbook over-engineering) and a Postgres-queue-plus-Redis-pubsub hybrid (operate both — the worst of either).

3. **Scheduler folds into the worker (C.2).** The cron ticker (`scraper-cron` today) becomes a responsibility of the `worker` role, alongside job execution. The whole scraping domain — *when* to scrape (cron) and *how* to scrape (execution) — stays encapsulated in the worker; the `web` process stays a pure front-door. This preserves the existing boundary (scheduling already lives in the scraper image today) and keeps the seam clean: if the worker is ever extracted or scaled, the scheduling travels with it. Rejected: a dedicated third scheduler process (a third process for a tick-and-enqueue job is over-engineering) and moving scheduling into `web` (relocates scraping logic into the API process; web owns the schedules *table* CRUD but that is persistence, not firing).

4. **The `web` process serves the SPA (D.1).** In prod the built SPA is baked into the `web` image (multi-stage build) and served by `express.static` alongside `/api`. One origin (no CORS), one image, and **the `client` container disappears from prod** (it survives only as the Vite dev server in dev). Rejected: a separate nginx/Caddy container and a CDN/object-store front (both legitimate later, but over-engineering for a single-instance app now). A reverse proxy for TLS may sit in front as an orthogonal ops choice without changing this topology.

5. **Hosted on a single VPS via docker compose (E.1).** A `compose.prod.yaml` runs the `web`, `worker`, and `db` services on one box. This matches the existing compose artifacts and the team's compose fluency, and migration to a managed PaaS later remains trivial. Kubernetes is ruled out as over-engineering for a single-instance platform.

**Guiding principle.** Simple now, one clean seam to extend later. Every consolidation above removes a component; the one boundary kept — `web` ↔ `worker` — is the seam that makes future extraction (a standalone scrape service, independent worker scaling) a configuration change rather than a rewrite. Re-splitting a clean modular monolith is cheap; merging prematurely split services is harder. The decision errs toward the reversible direction.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| **Status quo: separate scraper service + Redis** | Maximizes isolation but is over-engineering for single-instance — two images, two deploys, a wire-protocol package to keep in sync, a second stateful datastore. |
| **Pure in-process monolith (scraper runs inside the API process)** | Maximally simple but couples flaky, network-heavy, long-running scraping (429 cascades, parse failures) to the process that serves members — exactly the coupling the current split exists to avoid. |
| **Keep Redis (queue + pub/sub)** | A second stateful datastore to operate for a single-instance app that already has Postgres, which does both jobs natively. |
| **Hybrid: Postgres queue + Redis pub/sub** | Operate both components for no net simplification — the worst of either option. |
| **Dedicated scheduler process (3rd role)** | A third process for a lightweight tick-and-enqueue job is over-engineering. |
| **Scheduler in `web`** | Relocates scheduling logic from the scraping subsystem into the API process; muddies the domain boundary the seam relies on. |
| **Separate nginx/Caddy or CDN for the SPA** | Defensible later (TLS, edge caching) but over-engineering for a single-instance app now; a reverse proxy for TLS can be added in front without changing the topology. |
| **Kubernetes hosting** | Over-engineering for a single-instance platform. |

## Consequences

**Easier:**
- **Four app containers + Redis → two process roles + Postgres.** One codebase, one image, one stateful component. Fewer moving parts to build, deploy, back up, monitor, and secure.
- **No wire-protocol sync.** `packages/scraper-protocol`'s shared types become internal modules; the double-declaration pattern (and the issues that created it) goes away.
- **Transactional enqueue.** A scrape job can be enqueued in the same transaction as the business write that orders it — stronger atomicity than a Redis list.
- **A clean, pre-existing extension seam.** The `web`/`worker` boundary is the natural extraction point if scale ever demands a standalone scrape service or independent worker scaling — a `compose` change, not a rewrite.

**Harder:**
- **Migration is real, owed work** (separate from this decision): rewrite `redis-client` on both sides against `SKIP LOCKED` + `LISTEN/NOTIFY`, introduce the `scrape_jobs` table (a migration), merge the two codebases/Dockerfiles into one multi-stage image with two entrypoints, fold the cron into the worker, and bake the SPA into the `web` image. Each step is a scoped PR.
- **`LISTEN/NOTIFY` 8 KB payload cap.** Current event payloads are small (counts, `member_id` + outcome); the migration must keep them under the cap or switch to a notify-with-row-id-then-fetch pattern. Not a blocker, but a constraint to honor.
- **Doc drift to retire.** AGENTS.md ("Redis is mandatory") and several CONTEXT.md "Canonical home is `packages/scraper-protocol/...`" notes will read stale until the migration updates them. Topology is implementation, so CONTEXT.md's glossary terms are unaffected; only the implementation pointers change.
- **One box, one blast radius (E.1).** A single VPS is a single failure domain; Postgres backups and OS maintenance become the operator's responsibility. The trade-off accepted for simplicity.

## Cross-references

- ADR 0008 — fork-the-monolith, single DB; this ADR extends that "single DB" principle to **single datastore (Postgres only) + single image**.
- CONTEXT.md — Scraping section (the four Redis channels this consolidates) and the `packages/scraper-protocol` canonical-home notes the migration revisits.

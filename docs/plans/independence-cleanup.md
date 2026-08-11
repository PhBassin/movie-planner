# Movie Planner Independence Cleanup Plan

## Status

Approved for planning. Implementation has not started.

This plan records the decisions made for removing the inherited allo-scrapper identity and establishing Movie Planner as an independent project. It complements [ADR 0008](../adr/0008-fork-monolith-single-db.md), which established the permanent architectural divergence.

## Goal

Establish a clean, internally consistent baseline for **Movie Planner**, a member-facing cinema planner for discovering showtimes and following a personal selection of theaters.

The cleanup must remove inherited active identity, obsolete infrastructure, and contradictory documentation without erasing legally or technically relevant provenance.

## Canonical Identity

| Context | Value |
| --- | --- |
| Human-facing product name | `Movie Planner` |
| Repository and machine slug | `movie-planner` |
| PostgreSQL database | `movie_planner` |
| npm scope | `@movie-planner` |
| Compose project/resources | `movie-planner` |
| Pre-release package version | `0.0.0-development` |
| First planned release | `0.1.0` (not created by this cleanup) |

`Movie Planner` is never translated. The UI may remain French, while technical documentation is written in English.

## Provenance Policy

Movie Planner is a new, permanently diverged project derived from the initial allo-scrapper codebase. It does not track allo-scrapper as an upstream dependency.

Historical references are allowed only where they preserve provenance:

- The inherited copyright line in `LICENSE`, alongside a new Movie Planner copyright line.
- A short provenance note in the root README.
- ADR 0008, with a dated resolution note after this cleanup is completed.
- `docs/history/allo-scrapper-changelog.md`, containing the inherited changelog.
- Explicit links from historical records to the original GitHub repository, issues, and pull requests.

No inherited VPS hostname or other operational endpoint is allowed, including in historical documents. Historical GitHub links are the only permitted external allo-scrapper links.

## Scope

### Included

- Rename active product, package, calendar, log, healthcheck, email, Docker, database, and documentation identifiers.
- Rename all private workspaces to:
  - `@movie-planner/client`
  - `@movie-planner/server`
  - `@movie-planner/scraper`
  - `@movie-planner/scraper-protocol`
- Align all workspace versions to `0.0.0-development` until the first release workflow runs.
- Preserve white-label functionality with `Movie Planner` as the exact default and reset value.
- Replace the inherited migration history with one consolidated `docker/init.sql` baseline.
- Keep the migration runner for future migrations, beginning with `001_*` after the baseline.
- Preserve secure random initial-admin bootstrap behavior in application code.
- Support both fully containerized and host-application local development.
- Keep local PostgreSQL, local image builds, local backup/restore, and Prometheus metrics.
- Remove OpenTelemetry and its dependencies.
- Audit active documentation for verifiable factual accuracy, not just names.
- Simplify GitHub to a protected `main` branch with CI, security checks, and automated releases.
- Add CI guards against reintroducing inherited active identity or infrastructure endpoints.

### Excluded

- Migrating any allo-scrapper production or local database.
- Preserving aliases for old package, image, service, volume, network, path, or database names.
- Publishing Docker images or supporting GHCR.
- VPS deployment, Traefik, Watchtower, rollback, SSH backup, or production diagnostics.
- Grafana, Loki, Tempo, and the bundled monitoring stack.
- Rewriting Git commit history.
- Translating the Movie Planner brand.
- Removing or neutralizing Allocine as a data source.
- Publishing `v0.1.0` as part of the cleanup.

## Database Baseline

`docker/init.sql` becomes the single reusable source of truth for initializing an empty Movie Planner database, both inside and outside Docker.

It must consolidate the final state of the inherited initialization and migration files:

- PostgreSQL extensions.
- Tables and sequences.
- Primary, foreign, unique, and check constraints.
- Indexes.
- Stable reference data, including permissions, roles, Movie Planner settings, and rate-limit defaults.

The application bootstrap remains responsible only for creating the initial administrator with a securely generated random password. No static administrator secret may be placed in SQL.

The existing migration runner, checksums, diagnostics, `AUTO_MIGRATE`, and migration-related API remain available for migrations created after the baseline. The `migrations/` directory starts empty and future changes begin at `001_*`.

No automatic or optional import from an inherited database or Docker volume is provided. Old local volumes remain untouched until manually removed by their owner.

## Local Development Target

The project supports two explicit paths:

1. `compose.yaml` provides the default, fully Dockerized `npm run dev` path.
2. `compose.infra.yaml` runs PostgreSQL while Node 24 runs the client, web, and worker roles on the host.

Compose services use short names (`db`, `web`, `client`, and `worker`) without fixed `container_name` values. Compose supplies the `movie-planner` resource prefix.

The consumer and cron services start in the full Docker path. External scheduled scraping remains disabled unless `ENABLE_SCRAPE_CRON=true` is explicitly configured.

Dockerfiles remain for local builds only. Compose uses `build:` and local image tags; no `ghcr.io` reference remains.

Local `backup-db.sh`, `restore-db.sh`, and related listing utilities remain and produce `movie_planner_*` files. SSH and production variants are removed.

## Documentation Target

Retain and verify a smaller active documentation set covering:

- Root README and local quick start.
- Domain context and ADRs.
- Current architecture and package boundaries.
- API reference.
- Administration and white-label behavior.
- Local development, testing, and troubleshooting.
- Local database initialization, migrations, backup, and restore.

Delete production/VPS, monitoring, scaling, generated analysis, and redundant legacy documents rather than renaming unsupported instructions.

The audit must correct repository-verifiable inaccuracies such as runtime versions, commands, package names, architecture diagrams, links, and release state. It is not an unrestricted editorial rewrite.

## Git and GitHub Target

- Preserve all commits.
- Create and push an annotated `allo-scrapper-import` tag at the final pre-cleanup commit.
- Delete inherited version tags locally after the archive tag is secured. No inherited version tags currently exist on the Movie Planner remote.
- Change the default branch from `develop` to `main`.
- Protect `main` with required pull requests and CI checks; disallow force-push and branch deletion.
- Remove the `main`/`develop` synchronization workflow.
- Retain CI and security automation.
- Remove Docker publish, GHCR cleanup, deployment, and Docker release automation.
- Update the repository description, topics, issue templates, and community links. Leave the homepage unset until a deployment exists.

Recommended repository description:

> A member-facing cinema planner for discovering showtimes and following a personal selection of theaters.

Recommended topics include `movie-planner`, `showtimes`, `react`, `express`, and `postgresql`.

## Release Workflow

The first Movie Planner release is planned as `0.1.0`, but it is deliberately deferred until after this cleanup.

Release behavior:

1. A maintainer manually dispatches the release workflow with a version.
2. CI validates the version and generates aligned workspace versions, the lockfile, and a changelog section from strict Conventional Commits.
3. For the first release, changelog generation starts at `allo-scrapper-import`. Later releases start at the latest Movie Planner version tag.
4. CI opens a protected-branch-compatible PR named `release/X.Y.Z`.
5. The maintainer reviews and merges the generated PR.
6. A workflow triggered by that merge creates `vX.Y.Z` and the GitHub Release from the validated changelog.

The workflow must fail on malformed versions, an existing target version, duplicate changelog sections, or non-conforming commits. It must not move or rewrite a published tag.

## CI Identity Guard

Add a durable guard that fails when inherited active identity is reintroduced.

The guard must detect at least:

- Case variants of `allo-scrapper` used outside the historical allowlist.
- The standalone inherited identifier `ics` in active configuration, code, or prose without matching legitimate calendar file-extension usage.
- Inherited operational hostnames such as `ics.opalkad.com` anywhere, including historical files.
- Active links to the allo-scrapper repository, issues, discussions, releases, or container registry outside the historical allowlist.

The allowlist must be explicit and limited to `LICENSE`, the README provenance note, ADR 0008, and the archived changelog. `Allocine` source identifiers and calendar `.ics` terminology are not legacy identity and must not produce false positives.

## Delivery Sequence

Each implementation PR links the epic issue and depends on the preceding completed work where noted.

### Preparation: Archive Boundary

This is an operational prerequisite, not a code PR.

- Confirm the working tree and remote state.
- Create annotated tag `allo-scrapper-import` at the last pre-cleanup commit.
- Push and verify the archive tag.
- Remove inherited local version tags only after verification.

### PR 1: Canonical Identity and Packages

Dependencies: archive boundary complete.

- Rename root and workspace package metadata.
- Align package versions to `0.0.0-development`.
- Update internal dependencies, imports, scripts, lockfile, tests, app defaults, calendar identifiers, logs, email defaults, and white-label reset behavior.
- Add the dual copyright attribution and README provenance note.
- Do not yet remove infrastructure that later PRs own.

Acceptance:

- All workspace dependency resolution succeeds under the new names.
- Type-checks and targeted tests pass.
- No active runtime default displays Allo-Scrapper.

### PR 2: Clean Database Baseline

Dependencies: PR 1.

- Consolidate the final schema and reference data into `docker/init.sql`.
- Remove inherited migration SQL files.
- Retain and adapt the migration runner for an initially empty migration set and future `001_*` files.
- Provide a reusable `db:init` path for non-Docker initialization.
- Preserve random administrator bootstrap behavior.
- Rename the database and database-facing scripts to `movie_planner`.
- Update database documentation and tests.

Acceptance:

- A real PostgreSQL integration test initializes an empty database from `init.sql`.
- The migration runner succeeds with no pending migration files.
- Bootstrap creates required reference state and a secure initial administrator.
- Key tables, constraints, indexes, defaults, permissions, roles, and settings are verified.

### PR 3: Local Development and Data Utilities

Dependencies: PR 2.

- Introduce `compose.yaml` and `compose.infra.yaml`.
- Use Node 24 everywhere.
- Use short Compose service names without `container_name`.
- Build application images locally.
- Support both Docker-default and host-application development scripts.
- Start scraper consumer and cron, with external cron work gated by `ENABLE_SCRAPE_CRON=true`.
- Retain and rename local backup, restore, list, and integration utilities.
- Remove obsolete Compose/build files superseded by the two local files.

Acceptance:

- Both development paths start successfully from an empty database.
- Healthchecks pass for PostgreSQL, web, client, and worker as applicable.
- Local backup and restore round-trip succeeds.
- No old resource name is required or reused.

### PR 4: Remove Unsupported Operations and Observability

Dependencies: PR 3.

- Delete VPS deployment overlays and documentation.
- Delete Traefik, Watchtower, GHCR, rollback, SSH backup/restore, and production diagnostics.
- Delete Grafana, Loki, Tempo, dashboards, and monitoring Compose configuration.
- Remove OpenTelemetry code, tests, configuration, and dependencies.
- Keep Prometheus metrics and their authenticated endpoints.
- Remove dead scripts and dependencies exposed by the deletion.

Acceptance:

- No production deployment or container-registry instruction remains active.
- No OpenTelemetry dependency or configuration remains.
- Existing Prometheus metric tests pass.
- Dead-code and dependency checks pass.

### PR 5: Documentation, CI, and Release Automation

Dependencies: PR 4.

- Move the inherited changelog to `docs/history/allo-scrapper-changelog.md`.
- Create a clean Movie Planner `CHANGELOG.md` for the deferred release line.
- Add a dated resolution note to ADR 0008 without rewriting its historical decision.
- Prune and audit the active English documentation set.
- Add the strict identity/hostname guard.
- Remove GHCR/deployment/sync workflows while retaining CI and security checks.
- Implement the release-PR and post-merge tag/release workflows.
- Update contribution rules for `main`, Conventional Commits, and the new release process.
- Update issue templates and repository links in tracked files.

Acceptance:

- Documentation navigation has no links to deleted pages.
- Commands, runtime versions, architecture, and links match the repository.
- Release workflow tests or dry-run validation cover version, changelog, and duplicate-release failures.
- The identity guard passes only with the approved historical allowlist.

### PR 6: Final Verification and GitHub Cutover

Dependencies: PRs 1-5.

- Run the complete Node 24 verification suite.
- Build local web and scraper images.
- Start the full Compose stack from a clean volume and verify healthchecks.
- Run the real PostgreSQL baseline/bootstrap test and backup/restore round-trip.
- Run the identity and inherited-host guard.
- Update GitHub description, topics, default branch, protection rules, and community links.
- Verify all retained workflows against `main`.
- Record final evidence on the epic issue.

Acceptance:

- Server, scraper, client, and protocol type-checks pass.
- All workspace tests pass; server coverage meets its enforced thresholds.
- Local images build and the clean Compose stack is healthy.
- Database initialization and local backup/restore pass on real PostgreSQL.
- Identity guard and security checks pass.
- `main` is the protected default branch.
- No `v0.1.0` tag or release is created.

## Completion Criteria

The initiative is complete only when:

- Active code, configuration, docs, automation, and runtime output consistently use Movie Planner naming.
- Only approved historical files mention allo-scrapper, and CI enforces that boundary.
- No inherited operational hostname remains.
- A fresh local environment requires no old database, volume, image, path, network, or service.
- The consolidated database baseline and bootstrap pass against real PostgreSQL.
- Both supported local development paths work under Node 24.
- Unsupported production and observability surfaces are gone.
- Documentation describes only supported, verified behavior.
- GitHub uses a protected `main` branch and contains coherent metadata.
- The automated release process is ready, while `0.1.0` remains unpublished.

## Rollback Principle

Each PR must remain independently revertible until dependent PRs merge. No compatibility layer is required. If the database-baseline or Compose cutover fails during development, discard the new local `movie-planner` volume and recreate it from `docker/init.sql`; never mutate or delete an inherited volume automatically.

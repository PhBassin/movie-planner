# AGENTS.md

Theater showtimes aggregator. npm-workspaces monorepo: **Express API (`server`) + React SPA (`client`) + worker (`scraper`)**, PostgreSQL-only, fully Dockerized.

## Critical conventions

- **Node 24 only** (`engines: >=24 <25`, see `.nvmrc`). CI/hooks run on Node 24.
- **ESM everywhere** (`"type": "module"`). Relative TS imports MUST use `.js` extensions, e.g. `import { logger } from './utils/logger.js'`. Omitting the extension breaks runtime.
- Each workspace has its OWN `utils/logger.js`. `packages/logger` is not a real workspace — ignore it.
- Local dependency installs use `npm install --legacy-peer-deps` (peer-dep conflicts exist; plain `npm install` may fail). Docker image builds use the committed lockfile with `npm ci --legacy-peer-deps` for reproducible layers. CI deletes `package-lock.json` before installing.
- **Never add a dependency without explicit user consent.** Prefer existing libraries already in the relevant workspace.
- **`CONTEXT.md` at the repo root is the project's domain glossary.** Before introducing or naming a domain concept (entity, FSM, wire-format type), read it first and extend it in the same change. New code MUST use the canonical terms it defines; new or overloaded concepts MUST be added there with cross-references to the source files.

## Commands (run inside the workspace dir or via `--workspace`)

- Type-check (no root command — per workspace):
  - server: `cd server && npx tsc --noEmit`
  - scraper: `cd scraper && npx tsc --noEmit`
  - client: `cd client && npx tsc -b`
- Tests (vitest): `npm run test:run --workspace=@movie-planner/server` (or `@movie-planner/scraper`, or `@movie-planner/client`). Root `npm test` runs all.
  - Single test: `cd server && npx vitest run src/path/file.test.ts -t "name"`
- Server coverage gate (enforced): `cd server && npm run test:coverage` — pre-push and CI fail if thresholds unmet.
- E2E (Playwright, from root): `npm run e2e` / `npm run e2e:ui`.
- DB migrate (usually automatic, see below): `npm run server:db:migrate`.

## Local verification order (mirrors pre-push hook + CI)

1. `tsc --noEmit` for server AND scraper, `tsc -b` for client
2. server tests (`test:run`) + server coverage
3. scraper tests (`test:run`)

The `.husky/pre-push` hook runs exactly this and **blocks push on failure**. Emergency bypass: `git push --no-verify`.

## Dev environment

- Full stack with hot reload: `npm run dev` (Docker compose: db + web + worker + client). `npm run dev:down` / `dev:logs`.
- Server alone (no Docker): `npm run server:dev` (tsx watch). Needs a reachable Postgres + the env vars below.
- **Required env** (server refuses to start without): `JWT_SECRET` (min 32 chars, `openssl rand -base64 64`) and `POSTGRES_PASSWORD`. DB name is `movie_planner`, user `postgres`. See `.env.example`.

## Architecture (non-obvious)

- **The web role does NOT scrape.** Web publishes jobs to the Postgres `scrape_jobs` queue; the worker role consumes them, fetches the source site, and writes results **directly to PostgreSQL**. Progress flows back web-side through PostgreSQL `LISTEN/NOTIFY` → SSE → client. PostgreSQL is the only stateful component.
- Migrations: sequential numbered SQL in `migrations/`, idempotent, tracked in `schema_migrations` with SHA-256 checksums. Applied automatically at server startup when `AUTO_MIGRATE=true` (default). On fresh DB a random admin password is logged once. When adding one, use the next number and keep it idempotent (note: some numbers like 017/018 were duplicated historically — verify the real next free number).

## Security/code patterns to honor (from `.jules/sentinel.md`)

- Never embed `error.message` in HTTP 500 JSON. Use `next(error)` for unexpected errors; log context with `logger.error` and return a static sanitized message.
- Validate new passwords via `validatePasswordStrength` (`server/src/utils/security.ts`) on ALL password entry points.
- Parse IDs/pagination with `parseStrictInt` (`server/src/utils/number.ts`), never native `parseInt`. Always clamp pagination limits.

## Git / PR workflow

- Branch from `main` only (the old `develop` branch is retired). Naming: `<type>/<issue#>-<desc>` (e.g. `feat/259-add-theater-modal`). Every PR links an issue and targets `main`.
- Conventional Commits. Releases are manual: dispatch the **Prepare Release** workflow with a version to open a `release/<version>` PR against `main`; merging it creates the `vX.Y.Z` tag and GitHub Release (**Tag & Release** workflow). See `docs/guides/development/cicd.md`.

## Tooling notes

- `fallow` (dead-code/health) is wired via MCP and `.fallowrc.json` — prefer it for unused-export/dependency checks.
- `codegraph` is wired via MCP. Use it for code base exploration.

## Agent skills

Engineering skills (e.g. `triage`, `to-issues`, `diagnosing-bugs`, `improve-codebase-architecture`) read the configuration in `docs/agents/`:

### Issue tracker

GitHub Issues (uses the `gh` CLI). External PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

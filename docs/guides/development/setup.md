# Development Setup

Complete guide for setting up a local development environment for Movie Planner.

**Related documentation:**
- [Installation](../../getting-started/installation.md) — host-app and Docker setup
- [Quick Start](../../getting-started/quick-start.md) — five-minute path
- [Testing Guide](./testing.md) — running and writing tests
- [Contributing Guide](./contributing.md) — workflow and Conventional Commits

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Clone Repository](#clone-repository)
- [Environment Configuration](#environment-configuration)
- [Two Local Development Paths](#two-local-development-paths)
- [First Admin Password](#first-admin-password)
- [Running Tests](#running-tests)
- [Git Hooks](#git-hooks)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Software | Version | Notes |
|----------|---------|-------|
| **Node.js** | 24.x | Required for the host-application path. `engines: >=24 <25`. |
| **npm** | 10.x | Included with Node.js. |
| **Git** | 2.x | |
| **Docker** | 24.x | For the fully Dockerized path or for Postgres + Redis only. |
| **Docker Compose** | v2.x | Included with Docker Desktop. |

System: Linux, macOS, or Windows/WSL2. 4 GB RAM minimum.

---

## Clone Repository

```bash
git clone https://github.com/PhBassin/movie-planner.git
cd movie-planner

# main is the default, protected branch
git checkout main
git pull origin main
```

---

## Environment Configuration

Copy `.env.example` to `.env` and fill in the two mandatory secrets. The server
refuses to start without them:

```bash
cp .env.example .env
```

| Variable | Required | Notes |
|----------|----------|-------|
| `JWT_SECRET` | yes | ≥ 32 chars. Generate with `openssl rand -base64 64`. |
| `POSTGRES_PASSWORD` | yes | Any non-empty value. |
| `POSTGRES_DB` | no | Defaults to `movie_planner` (the canonical name). |
| `ALLOWED_ORIGINS` | no | CORS allow-list. Defaults to `http://localhost:3000`. |
| `ENABLE_SCRAPE_CRON` | no | `true` lets the worker fire scheduled scrapes. The worker always loads schedules from the database; this only gates execution. |

---

## Two Local Development Paths

Movie Planner supports two explicit local development paths under Node 24.

### Path A — Fully Dockerized (default): `compose.yaml`

```bash
npm run dev          # docker compose up --build
npm run dev:logs     # tail logs
npm run dev:down     # stop
```

Services: `db`, `redis`, `web`, `client`, `worker`.
The server auto-applies the consolidated baseline (`docker/init.sql`) on first
startup of a fresh database, then runs any pending migrations under
`migrations/`. No external image or volume is required.

### Path B — Host application: `compose.infra.yaml`

Runs only PostgreSQL and Redis in Docker; the client, web, and worker run
on the host under Node 24.

```bash
npm install --legacy-peer-deps
npm run dev:infra     # docker compose -f compose.infra.yaml up -d (Postgres + Redis)

# Initialize the database from the consolidated baseline (first run only):
npm run server:db:init

# In separate terminals:
npm run server:dev       # web API on http://localhost:3000
npm run client:dev       # UI on http://localhost:5173
npm run scraper:consumer # worker consumer
```

Type-check each workspace before running the full suite:

```bash
(cd server && npx tsc --noEmit)
(cd scraper && npx tsc --noEmit)
(cd client && npx tsc -b)
```

> The legacy `--legacy-peer-deps` flag is required because of known peer-dep
> conflicts. CI deletes `package-lock.json` before installing.

---

## First Admin Password

On a fresh database, the application bootstrap creates the `admin` user with a
securely generated **random** password and logs it **exactly once** to stdout.
There is no static default password. Copy the logged password on first start,
then change it immediately via the admin panel (`/admin`).

See [Database initialization](../../reference/database/README.md) and
[CONTEXT.md](../../../CONTEXT.md) for the model.

---

## Running Tests

```bash
# Server (vitest)
npm run test:run --workspace=@movie-planner/server
npm run test:coverage --workspace=@movie-planner/server

# Scraper
npm run test:run --workspace=@movie-planner/scraper

# scraper-protocol
npm run test:coverage --workspace=@movie-planner/scraper-protocol

# All workspaces
npm test

# E2E (Playwright, from the repo root)
npm run e2e
npm run e2e:ui
```

See the [Testing Guide](./testing.md) for the full suite.

---

## Git Hooks

The Husky `pre-push` hook (`.husky/pre-push`) runs the local verification
suite and blocks the push on failure:

1. `tsc --noEmit` (server + scraper), `tsc -b` (client)
2. Server tests + server coverage
3. Scraper tests

Emergency bypass: `git push --no-verify`.

---

## Troubleshooting

### Database connection errors

```bash
docker compose ps                 # Path A
docker compose -f compose.infra.yaml ps   # Path B
docker compose logs db
```

### `Cannot find package 'sharp'`

Install from the correct directory:

```bash
cd server
rm -rf node_modules
npm install --legacy-peer-deps
```

### Port already in use

```bash
lsof -i :3000        # macOS/Linux
netstat -ano | findstr :3000  # Windows
```

### Hot reload not working (Vite)

```bash
cd client
rm -rf node_modules/.vite
npm run dev
```

---

## Next Steps

- [Contributing](./contributing.md)
- [CI/CD and releases](./cicd.md)
- [Testing Guide](./testing.md)
- [Architecture](../../reference/architecture/)

---

[← Back to Development Guides](./README.md)

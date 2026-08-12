# Movie Planner

[![Node.js](https://img.shields.io/badge/Node.js-24+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Express.js](https://img.shields.io/badge/Express.js-4.x-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![React](https://img.shields.io/badge/React-18+-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

Member-facing cinema planner for discovering showtimes and following a personal
selection of theaters. Built with Express.js, React, and PostgreSQL, fully
containerized with Docker.

> **Provenance:** Movie Planner is a permanently diverged project derived from
> the allo-scrapper codebase. The inherited history is preserved up to the
> `allo-scrapper-import` boundary tag; see
> [ADR 0008](docs/adr/0008-fork-monolith-single-db.md) for the fork and
> permanent-divergence decision.

> **Version:** `0.0.0-development` (pre-release). The first planned release is
> `0.1.0` and is deferred until the independence cleanup (issue #3) is complete.

---

## Features

- **Automated scraping** of theater showtimes from the source website, via the
  isolated worker role consuming a PostgreSQL job queue.
- **Scraper resilience** with automatic HTTP 429 detection and graceful shutdown.
- **RESTful API** built with Express.js and TypeScript.
- **React SPA** (Vite) with a member-facing homepage driven by a personal
  selection of theaters.
- **Real-time progress** via Server-Sent Events (SSE) for live scraping updates.
- **Weekly reports** for tracking theater programs and identifying new releases.
- **White-label branding** — site name, logo, colors, fonts, footer — via the
  admin panel, with `Movie Planner` as the canonical default and reset value.
- **Role-based access control** with granular, permission-based role management.
- **JWT authentication** with rotating refresh tokens and CSRF protection.
- **Member accounts** — self-registration by email, verification, member
  selection, member submission of new theaters (see [CONTEXT.md](CONTEXT.md)).
- **Rate limiting** per endpoint type, dynamically configurable via the admin
  panel.
- **Prometheus metrics** at the authenticated `/metrics` endpoint.

---

## Architecture

```
┌────────────────────────────────────────────┐
│ Express web role                           │
│ API + SSE + production SPA (one origin)    │
└──────────────────────┬─────────────────────┘
                       │ PostgreSQL bus
                       ▼
┌────────────────────────────────────────────┐
│ Worker role                                │
│ queue consumer + scheduler + scraper       │
└──────────────────────┬─────────────────────┘
                       │ SQL
                       ▼
             ┌─────────────────────────┐
             │   PostgreSQL  Port 5432 │
             │ theaters / movies /     │
             │ showtimes / reports     │
             └─────────────────────────┘

```

In production, the web role serves the compiled React SPA and API from one
origin. Local development keeps Vite on port 5173 and proxies `/api` to web.
The API publishes scrape jobs to PostgreSQL; the worker claims them with
`FOR UPDATE SKIP LOCKED`, fetches the source site, and writes results directly
to PostgreSQL. Progress flows back to the client via PostgreSQL `LISTEN/NOTIFY`
→ SSE. PostgreSQL is the only stateful component.

See [CONTEXT.md](CONTEXT.md) for the domain glossary and the
[architecture reference](docs/reference/architecture/) for system design.

---

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 24 (only for the host-application path)
- Ports 3000, 5432, and 5173 available
- `openssl` (for `JWT_SECRET` generation)

### Required environment

Copy `.env.example` to `.env` and fill in the two mandatory secrets. The server
refuses to start without them:

- `JWT_SECRET` — minimum 32 characters. Generate with `openssl rand -base64 64`.
- `POSTGRES_PASSWORD` — any non-empty value.

### Option A — Fully Dockerized (default)

```bash
git clone https://github.com/PhBassin/movie-planner.git
cd movie-planner
cp .env.example .env
# Fill in POSTGRES_PASSWORD and JWT_SECRET in .env

npm run dev          # docker compose up --build
```

### Option B — Host application on Node 24

Runs PostgreSQL in Docker; the client, web, and worker run on the
host under Node 24.

```bash
git clone https://github.com/PhBassin/movie-planner.git
cd movie-planner
cp .env.example .env
# Fill in POSTGRES_PASSWORD and JWT_SECRET in .env

npm install --legacy-peer-deps
npm run dev:infra     # starts Postgres in Docker

# In separate terminals:
npm run server:dev       # web API on http://localhost:3000
npm run client:dev       # UI on http://localhost:5173
npm run scraper:consumer # worker role
```

### First admin password

On a fresh database, the server bootstrap creates the `admin` user with a
securely generated random password and logs it **once** to stdout. There is no
static default admin password — copy the logged password on first start, then
change it immediately via the admin panel.

See the [setup guide](docs/guides/development/setup.md) and
[database initialization reference](docs/reference/database/README.md) for
details.

---

## Documentation

**[Browse full documentation →](docs/README.md)**

- [Quick Start](docs/getting-started/quick-start.md)
- [Installation](docs/getting-started/installation.md)
- [Configuration](docs/getting-started/configuration.md)
- [Development guides](docs/guides/development/) — setup, testing, contributing, CI
- [API reference](docs/reference/api/)
- [Database schema and migrations](docs/reference/database/)
- [Architecture](docs/reference/architecture/)
- [Troubleshooting](docs/troubleshooting/)
- [Domain glossary (CONTEXT.md)](CONTEXT.md)
- [Architecture Decision Records](docs/adr/)

---

## Contributing

Contributions are welcome. See [CONTRIBUTING](docs/guides/development/contributing.md).

Workflow:

1. Open or pick a GitHub issue.
2. Branch from `main` (the default and only long-lived branch): `<type>/<issue#>-<desc>`.
3. Write tests first; keep type-checks and tests green.
4. Use Conventional Commit subjects (`feat:`, `fix:`, etc.).
5. Open a PR against `main` referencing the issue.

Releases are produced by manual dispatch of the `Prepare Release` workflow with
a target version; merging the generated `release/X.Y.Z` PR creates the tag and
the GitHub Release. See [CI/CD guide](docs/guides/development/cicd.md) and
[CONTRIBUTING](docs/guides/development/contributing.md) for details.

For AI coding agents working in this repository, see [AGENTS.md](AGENTS.md).

---

## License

MIT — see [LICENSE](LICENSE).

---

## Support

- **Issues:** [GitHub Issues](https://github.com/PhBassin/movie-planner/issues)
- **Discussions:** [GitHub Discussions](https://github.com/PhBassin/movie-planner/discussions)

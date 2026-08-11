# Quick Start

Get Movie Planner up and running in five minutes with Docker Compose.

## Prerequisites

- Docker and Docker Compose
- Git

## Setup

```bash
git clone https://github.com/PhBassin/movie-planner.git
cd movie-planner

cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD and JWT_SECRET
#   JWT_SECRET=$(openssl rand -base64 64)

npm run dev          # docker compose up --build
```

First startup takes about a minute. The compose file builds one application
image locally and starts:

- `db` — PostgreSQL on port 5432
- `web` — Express API and SPA host on port 3000
- `client` — Vite dev server on port 5173
- `worker` — Postgres queue consumer

## Access

- Web UI: http://localhost:5173
- API: http://localhost:3000/api
- Health check: http://localhost:3000/api/health

## First admin password

On a fresh database, the bootstrap creates the `admin` user with a securely
generated **random** password and logs it once to stdout. There is no static
default password. Copy the logged password, sign in, and change it immediately
via the admin panel.

## Verify

```bash
docker compose ps
curl http://localhost:3000/api/health
```

Trigger the first scrape from the admin panel or via the API; progress streams
back through SSE.

## Common commands

```bash
npm run dev          # build + start
npm run dev:logs     # tail logs
npm run dev:down     # stop
```

## Next steps

- [Installation](./installation.md) — host-application (Node 24) path
- [Configuration](./configuration.md) — environment variable reference
- [API reference](../reference/api/)
- [Development setup](../guides/development/setup.md)

---

[← Back to Getting Started](./README.md) | [Next: Installation →](./installation.md)

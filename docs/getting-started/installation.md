# Installation

Detailed setup for the two supported local development paths.

## System requirements

- **CPU:** 2 cores
- **RAM:** 4 GB minimum
- **Disk:** 10 GB free
- **OS:** Linux, macOS, or Windows/WSL2
- **Node.js:** 24.x (only for the host-application path)
- **Docker:** 24.x with Docker Compose v2

---

## Method 1 — Fully Dockerized (default)

The default path. `compose.yaml` builds the server and scraper images locally
and runs Postgres, Redis, the API, the React dev server, the scraper consumer,
and the scraper cron together.

```bash
git clone https://github.com/PhBassin/movie-planner.git
cd movie-planner

cp .env.example .env
# Set POSTGRES_PASSWORD and JWT_SECRET in .env

npm run dev          # docker compose up --build
```

The database initializes itself from `docker/init.sql` on first start. The
server bootstrap then creates the initial `admin` user with a random password
that is logged **once** to stdout — copy it on first start.

Access:
- Web UI: http://localhost:5173
- API: http://localhost:3000/api
- Health: http://localhost:3000/api/health

Common commands:

```bash
npm run dev          # build + up
npm run dev:logs     # tail logs
npm run dev:down     # stop
```

External scheduled scraping is disabled by default; set
`ENABLE_SCRAPE_CRON=true` in `.env` to enable the scraper-cron service.

---

## Method 2 — Host application on Node 24

Runs only PostgreSQL and Redis in Docker; the client, server, and scraper run
on the host under Node 24 (handy for stepping through code with a debugger).

```bash
git clone https://github.com/PhBassin/movie-planner.git
cd movie-planner

cat .env.example .env.dev.example > .env
# Set POSTGRES_PASSWORD and JWT_SECRET in .env

npm install --legacy-peer-deps
npm run dev:infra              # docker compose -f compose.infra.yaml up -d

# Initialize the database from the consolidated baseline (first run only):
npm run server:db:init

# In separate terminals:
npm run server:dev            # API on http://localhost:3000
npm run client:dev            # UI on http://localhost:5173
npm run scraper:dev           # scraper consumer + cron
```

> Dependency installs require `--legacy-peer-deps` due to known peer-dep
> conflicts. CI deletes `package-lock.json` before installing.

---

## Verification

```bash
# Service health (Docker path)
docker compose ps

# API health
curl http://localhost:3000/api/health
```

The scraper consumer is always running in `compose.yaml`. Trigger a one-shot
scrape through the API or the admin panel; progress streams back via SSE.

---

## Post-installation

1. Copy the random admin password from the first-startup logs.
2. Sign in at `/login` and immediately change the password via the admin panel.
3. Configure branding under `/admin/settings` if desired (see
   [White-Label Configuration](../guides/administration/white-label.md)).

---

## Troubleshooting

See [Troubleshooting](../troubleshooting/) and the [setup guide](../guides/development/setup.md).

---

[← Back to Getting Started](./README.md) | [Configuration](./configuration.md)

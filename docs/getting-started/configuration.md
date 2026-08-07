# Configuration

Environment variable reference for Movie Planner.

## How configuration works

Movie Planner reads its environment through two compose files (`compose.yaml`
for the fully-Dockerized path, `compose.infra.yaml` for the host-app path)
plus a small set of host-side overrides for the host-app path. Secrets and
deployment-specific values go in `.env`; everything else is hardcoded with
sensible defaults inside the compose files.

| File | Purpose | When to use |
|------|---------|-------------|
| `.env.example` | Required base template (secrets + a few knobs). | Always copy to `.env` first. |
| `.env.dev.example` | Host-application overrides (Node 24). | Append to `.env` only when using `compose.infra.yaml`. |

Quick start:

```bash
# Fully Dockerized path
cp .env.example .env
# edit .env to set POSTGRES_PASSWORD and JWT_SECRET

# Host-app path (Node 24)
cat .env.example .env.dev.example > .env
```

---

## Required secrets

These two variables MUST be set in `.env`. The compose files refuse to start
without them.

### `POSTGRES_PASSWORD`

Password for the PostgreSQL container. Any non-empty string. Use a strong
value in any non-ephemeral environment.

### `JWT_SECRET`

HS256 signing key for authentication tokens. Minimum 32 characters; the
server refuses to start without it. Generate one with:

```bash
openssl rand -base64 64
```

Never commit this value.

---

## Optional configuration

### Database

| Variable | Default | Notes |
|----------|---------|-------|
| `POSTGRES_DB` | `movie_planner` | Canonical database name. |
| `POSTGRES_USER` | `postgres` | PostgreSQL user. |
| `POSTGRES_HOST` | `db` (compose) / `localhost` (host-app) | Set by the compose files; overridden by `.env.dev.example` for the host-app path. |
| `POSTGRES_PORT` | `5432` | Host port the compose files publish. |

### Server

| Variable | Default | Notes |
|----------|---------|-------|
| `SERVER_PORT` / `PORT` | `3000` | Express API port. |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://localhost:5173` | CORS allow-list. |
| `JWT_EXPIRES_IN` | `24h` | Access-token lifetime. |
| `LOG_LEVEL` | `info` | Winston log level. |
| `TZ` | `Europe/Paris` | Process timezone. |
| `AUTO_MIGRATE` | `true` (in `compose.yaml`) | Apply pending migrations under `migrations/` at startup. |
| `COOKIE_SECURE` | `false` in dev (`.env.dev.example`) | Set `true` for HTTPS. When `false` over plain HTTP, the browser rejects cookies with the `Secure` flag and every non-login API call returns 403 "CSRF token missing or invalid". |

### Client

| Variable | Default | Notes |
|----------|---------|-------|
| `CLIENT_PORT` | `5173` | Vite dev server port. |
| `VITE_API_BASE_URL` | `http://localhost:${SERVER_PORT:-3000}/api` | Set automatically by `compose.yaml`. |

### Scraper

| Variable | Default | Notes |
|----------|---------|-------|
| `SCRAPE_MODE` | `from_today_limited` (consumer) / `weekly` (host-app) | Scraping strategy. |
| `SCRAPE_DAYS` | `7` | Number of days to scrape per run. |
| `SCRAPE_THEATER_DELAY_MS` | `3000` | Delay between theaters. |
| `SCRAPE_MOVIE_DELAY_MS` | `500` | Delay between movies. |
| `SCRAPER_CONCURRENCY` | `2` | Parallelism within a scrape run. |
| `SCRAPE_DELAY_MS` | `1000` | Generic scrape delay. |
| `ENABLE_SCRAPE_CRON` | `false` | Set `true` to let the worker fire scheduled scrapes. The worker always registers schedules from the database; this gates whether they execute. |

### Redis

| Variable | Default | Notes |
|----------|---------|-------|
| `REDIS_URL` | `redis://redis:6379` (compose) / `redis://localhost:6379` (host-app) | Set by the compose files. |
| `REDIS_PORT` | `6379` | Host port the compose files publish. |

---

## First admin password

On a fresh database, the bootstrap creates the `admin` user with a securely
generated random password and logs it **once** to stdout. There is no static
default password — copy the logged password on first start and change it
immediately via the admin panel. See [Database initialization](../reference/database/README.md).

---

## Configuration troubleshooting

### The server exits with `JWT_SECRET is required`

Set `JWT_SECRET` in `.env` (minimum 32 characters). The compose files pass it
through with `${JWT_SECRET:?JWT_SECRET is required}`.

### Every non-login API call returns 403 "CSRF token missing or invalid"

In development over plain HTTP, set `COOKIE_SECURE=false` (already set in
`.env.dev.example`). The browser silently rejects cookies carrying the
`Secure` flag over HTTP.

### Scraper is idle

External scheduled scraping is gated by `ENABLE_SCRAPE_CRON=true`. The
worker (always running in `compose.yaml`) registers schedules from the
database and fires them when this is set; it also handles on-demand scrapes
from the queue regardless.

---

[← Back to Getting Started](./README.md) | [Setup guide](../guides/development/setup.md)

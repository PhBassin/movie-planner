# Production Deployment

Movie Planner runs the ADR 0009 topology on a single host with Docker Compose:
one application image, three services — `web`, `worker`, and `db`. PostgreSQL
is the only stateful component. There is no production Redis, client, scraper,
or scraper-cron service.

**Related:**
- [Docker Setup](./docker.md) — local development compose files
- [Configuration](../../getting-started/configuration.md) — environment variables
- [Networking](./networking.md) — ports and CORS

---

## Topology

| Service | Image | Runs |
|---------|-------|------|
| `web`   | `movie-planner:prod` (built from `Dockerfile`) | Express API, SSE fan-out, the baked SPA |
| `worker` | `movie-planner:prod` (same image, `ROLE=worker`) | `scrape_jobs` queue consumer + scheduler |
| `db`    | `postgres:15-alpine` | PostgreSQL, `postgres-data` volume |

Both app roles run the **same image** — `compose.prod.yaml` builds it once with
`docker compose up -d --build` and tags it `movie-planner:${IMAGE_TAG:-prod}`.

`web` publishes port `3000` (override with `SERVER_PORT`). `db` is internal
only — it is not exposed to the host.

---

## Prerequisites

- A host running Docker and Docker Compose v2.
- Ports `3000` open (or a reverse proxy in front — see [Networking](./networking.md)).
- `openssl` (to generate `JWT_SECRET`).

## Deploy

```bash
git clone https://github.com/PhBassin/movie-planner.git
cd movie-planner

cp .env.prod.example .env
# Edit .env: set POSTGRES_PASSWORD, JWT_SECRET, ALLOWED_ORIGINS, SMTP_HOST

docker compose -f compose.prod.yaml up -d --build
```

Startup order is explicit via `depends_on: condition: service_healthy`:

1. `db` becomes healthy (`pg_isready`), applying `docker/init.sql` on the fresh
   `postgres-data` volume.
2. `web` waits for `db`, then applies pending migrations under `migrations/`
   (`AUTO_MIGRATE=true`) and bootstraps the initial admin password.
3. `worker` waits for `db` and starts consuming the queue.

The worker starts once `db` is healthy — it does **not** wait for `web`'s
migration step. That is safe because the full schema (including `scrape_jobs`)
comes from the `docker/init.sql` baseline applied to the fresh volume; numbered
migrations under `migrations/` are layered on top by `web`. The worker's queue
loop tolerates the migration window (it logs and retries while the table is
absent).

Check health:

```bash
docker compose -f compose.prod.yaml ps
# db      healthy
# web     healthy
# worker  healthy

curl http://localhost:3000/api/health
# {"status":"healthy","database":"connected",...}
```

## Smoke test

`scripts/smoke-test-prod.sh` verifies the four production acceptance signals
end to end:

1. **API** — `GET /api/health` returns healthy with the database connected.
2. **SPA** — `GET /` serves the baked client bundle (the `#root` mount node).
3. **Queue consumption** — inserts a job directly into `scrape_jobs` and waits
   for the worker to claim it (the row disappears at claim time).
4. **Progress delivery** — subscribes to the web SSE stream
   (`GET /api/scraper/progress`) and confirms the worker's `started` event
   arrives.

```bash
./scripts/smoke-test-prod.sh            # against a running compose.prod.yaml
./scripts/smoke-test-prod.sh --build    # up -d --build first, then test
```

The smoke test enqueues a single-theater `from_today_limited` job for the
seeded theater `C0153`. It asserts the *pipeline* (queue → worker → SSE), not
scrape success; a network or AlloCiné failure does not fail the test.

## Operations

```bash
# Logs
docker compose -f compose.prod.yaml logs -f web worker db

# Restart a role
docker compose -f compose.prod.yaml restart web

# Stop (keeps the postgres-data volume)
docker compose -f compose.prod.yaml down

# Wipe the database volume (destructive)
docker compose -f compose.prod.yaml down -v
```

Backups use `docker compose exec` (no host port needed):

```bash
docker compose -f compose.prod.yaml exec -T db pg_dump -U postgres movie_planner | gzip > movie_planner_backup.sql.gz
```

## Configuration

All configuration flows through `.env` (gitignored). Required:

| Variable | Notes |
|----------|-------|
| `POSTGRES_PASSWORD` | Any strong value. |
| `JWT_SECRET` | ≥ 32 chars. `openssl rand -base64 64`. |
| `ALLOWED_ORIGINS` | The exact public origin browsers reach `web` at. Same-origin POST requests still send an `Origin` header and the auth routes reject origins missing from this list. |
| `SMTP_HOST` | Outbound relay for auth email (verification, password reset — ADR 0005). Email verification is load-bearing (ADR 0003): the `web` role refuses to start without it. See `SMTP_*` optional overrides below for port/credentials/sender. |

Optional overrides (see [Configuration](../../getting-started/configuration.md)):

`SERVER_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `ENABLE_SCRAPE_CRON`,
`COOKIE_SECURE` (default `true`, correct behind TLS), `JWT_EXPIRES_IN`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_NAME`,
`SMTP_FROM_ADDRESS`, `PUBLIC_WEB_ORIGIN`, `LOG_LEVEL`, `TZ`, `IMAGE_TAG`.

Set `ENABLE_SCRAPE_CRON=true` to let the worker fire external scheduled
scrapes. The worker always registers schedules from the database; this gates
whether they execute.

---

## Troubleshooting

- **Compose refuses to start with "`ALLOWED_ORIGINS is required`"** — set it in
  `.env` to the exact origin browsers use (scheme + host + optional port).
- **Compose refuses to start with "`SMTP_HOST is required`" (or the server
  exits with "`FATAL: SMTP_HOST is not set`")** — email verification is
  load-bearing; set `SMTP_HOST` (plus `SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` if
  the relay needs credentials) in `.env`.
- **403 "CSRF token missing or invalid" over HTTP** — `COOKIE_SECURE=true`
  (default) makes browsers silently drop the auth cookies over plain HTTP. Use
  a TLS reverse proxy, or set `COOKIE_SECURE=false` only for a throwaway
  HTTP test deployment.
- **`db` stays unhealthy** — `docker compose -f compose.prod.yaml logs db`.
  On a fresh volume the postgres image applies `docker/init.sql` once; the log
  shows the failure if the baseline errors.

See [Troubleshooting](../../troubleshooting/) and
[Docker Setup](./docker.md) for more.

---

[← Back to Deployment Guides](./README.md)

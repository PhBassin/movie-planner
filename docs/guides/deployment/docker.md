# Docker Setup

Movie Planner ships two local development compose files. The default compose
file builds one application image and runs it as separate `web` and `worker`
roles; there is no registry publication.

**Related:**
- [Setup guide](../development/setup.md) — host-app prerequisites
- [Configuration](../../getting-started/configuration.md) — environment variables
- [Networking](./networking.md) — local ports and proxies

---

## The two compose files

| File | Path | What runs in Docker |
|------|------|---------------------|
| `compose.yaml` | Default, fully Dockerized | Postgres, Redis, web, client (Vite), worker |
| `compose.infra.yaml` | Host-application (Node 24) | Postgres and Redis only |

Compose services use short names (`db`, `redis`, `web`, `client`, `worker`)
without fixed `container_name` values. Compose supplies the
`movie-planner` resource prefix.

---

## Build vs. image

The default compose file builds the shared application image from:

- `Dockerfile` — server, worker, and client production bundle (used by `web` and `worker`)

There is no `image:` pull from `ghcr.io` or any external registry. To rebuild
after a Dockerfile or dependency change:

```bash
npm run dev          # docker compose up --build (rebuilds on each up)
# or, force a clean rebuild:
docker compose build --no-cache
```

---

## Volumes and initialization

`compose.yaml` mounts `./docker/init.sql` into the Postgres container's
`/docker-entrypoint-initdb.d/` directory. On a fresh volume (no
`postgres-data` volume yet), Postgres applies the consolidated baseline on
first start. The server bootstrap then creates the initial `admin` user with
a securely generated random password (logged once).

To reset the local database:

```bash
npm run dev:down
docker compose down -v   # removes the postgres-data volume
npm run dev
```

---

## Health checks

Every service has a healthcheck. `docker compose ps` shows the state; the
web, db, redis, and worker services use small Node HTTP
probes against `/api/health` or `/metrics`.

```bash
docker compose ps
docker compose logs web worker
```

---

## Common commands

```bash
npm run dev              # compose.yaml up --build
npm run dev:logs         # tail logs
npm run dev:down         # stop

npm run dev:infra        # compose.infra.yaml up -d (Postgres + Redis only)
npm run dev:infra:down   # stop infra
```

---

## Troubleshooting

### The compose file refuses to start with "POSTGRES_PASSWORD is required"

Set `POSTGRES_PASSWORD` in `.env`. The compose files use
`${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}` and refuse to start
without it.

### The server logs "JWT_SECRET is required"

Set `JWT_SECRET` in `.env` (minimum 32 characters; `openssl rand -base64 64`).

### `Cannot find package 'sharp'` (host-app path)

Install from the correct directory:

```bash
cd server
rm -rf node_modules
npm install --legacy-peer-deps
```

---

[← Back to Deployment Guides](./README.md) | [Back to Documentation](../../README.md)

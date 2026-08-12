# Scripts Reference

Local utility scripts shipped under `scripts/`. All of them target local
development; production/VPS variants have been removed (issue #3, PR 4).

| Script | Purpose |
|--------|---------|
| [`backup-db.sh`](../../../scripts/backup-db.sh) | Dump the local PostgreSQL database to a `movie_planner_*` backup file. |
| [`restore-db.sh`](../../../scripts/restore-db.sh) | Restore the local database from a backup file. |
| [`list-backups.sh`](../../../scripts/list-backups.sh) | List local backup files with size and timestamp. |
| [`integration-test.sh`](../../../scripts/integration-test.sh) | Build the Docker stack, wait for health, run E2E tests, clean up. |
| [`cleanup-merged-branches.sh`](../../../scripts/cleanup-merged-branches.sh) | Delete local branches already merged into the default branch. |
| [`migrate-env.sh`](../../../scripts/migrate-env.sh) | Bring an existing `.env` in line with `.env.example`. |

> The Husky pre-push hook lives at `.husky/pre-push` and is installed
> automatically via `npm install` (Husky's `prepare` hook). There is no
> `install-hooks.sh` to run by hand.

---

## Backup and restore

### `backup-db.sh`

Dumps the local PostgreSQL database to a timestamped `movie_planner_*.sql.gz`
file under `./backups/`.

```bash
./scripts/backup-db.sh
```

The script reads `POSTGRES_*` values from `.env` (or the compose service when
invoked via `docker compose exec`).

Dumps are taken with `pg_dump --clean --if-exists`, so they can be replayed over
an existing schema. A dump without those statements only restores into an empty
database.

### `restore-db.sh`

Restores the local database from a backup file.

```bash
./scripts/restore-db.sh backups/movie_planner_2026-07-25.sql.gz
```

The restore is atomic and fails loudly:

- `web` and `worker` are stopped first so the restore can
  take its locks, and restarted afterwards whatever the outcome.
- A safety backup (`movie_planner_before_restore_*.sql.gz`) is written first.
- The dump is applied in a single transaction with `ON_ERROR_STOP`. If any
  statement fails, the whole restore rolls back, the database is left untouched,
  and the script exits non-zero.

### `list-backups.sh`

Lists local backups with size and timestamp.

```bash
./scripts/list-backups.sh
```

---

## Development

### `integration-test.sh`

Builds the full Docker stack, waits for every healthcheck to flip to healthy,
runs the Playwright E2E suite against it, then tears the stack down.

```bash
./scripts/integration-test.sh
```

### `cleanup-merged-branches.sh`

Removes local branches that have already been merged into the default branch.

```bash
./scripts/cleanup-merged-branches.sh
```

### `migrate-env.sh`

Updates an existing `.env` to match the current `.env.example` template
(keeps your existing values, adds any new variables, drops removed ones).

```bash
./scripts/migrate-env.sh
```

---

## Permissions and error handling

- All scripts use `set -euo pipefail` (or the equivalent) and exit non-zero
  on the first failure.
- Backup/restore scripts refuse to run without a reachable PostgreSQL.
- The restore script is destructive — it overwrites the local database.

---

## Related documentation

- [Docker setup](../../guides/deployment/docker.md) — volumes, healthchecks
- [Database reference](../database/README.md) — schema and migrations
- [Setup guide](../../guides/development/setup.md)

---

[← Back to Reference](../README.md)

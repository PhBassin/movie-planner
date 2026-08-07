# Database Migrations

Movie Planner initializes its database from a single consolidated baseline and
then applies forward-only SQL migrations for subsequent schema changes.

## Baseline (`docker/init.sql`)

[`docker/init.sql`](../../../docker/init.sql) is the single source of truth for
an empty Movie Planner database (canonical name: `movie_planner`). It contains
the full schema — tables, constraints, indexes — and the stable reference data
(roles, permissions, role/permission grants, white-label settings defaults,
rate-limit defaults, permission-category labels, and the default weekly scrape
schedule).

It is applied two ways:

- **Docker:** the postgres image mounts it as an init script on first startup.
- **Host development:** `npm run server:db:init` applies it against a configured
  PostgreSQL instance (`tsx src/db/init.ts`).

The baseline targets an **empty** database. `CREATE TABLE` statements are not
`IF NOT EXISTS`, so re-running it against a partially initialized database fails
loudly. To reinitialize, drop and recreate the database.

## Initial administrator

No administrator credential lives in SQL. After the schema is in place, the
application bootstrap (`server/src/db/admin-bootstrap.ts`, `ensureInitialAdmin`)
creates an `admin` user with a securely generated random password the first time
it finds no administrator, logging the password once. This runs on every startup
and is a no-op once an admin exists.

## Forward migrations

The application migration runner (`server/src/db/migrations.ts`) applies pending
`.sql` files from [`migrations/`](../../../migrations/) at server startup when
`AUTO_MIGRATE=true` (the default). It:

1. Creates `schema_migrations` if missing.
2. Verifies SHA-256 checksums of already-applied files (warns on mismatch).
3. Applies pending `.sql` files in lexical order, recording each with its checksum.

The `migrations/` directory contains only forward changes — the historical
numbered migrations were folded into the baseline. New schema changes begin at
`001_*`.

The first forward migration, `001_scrape_jobs_queue.sql`, adds the
Postgres-backed `scrape_jobs` queue and its `enqueued_at` index. It is safe to
run against the fresh baseline because both the table and index creation are
idempotent.

### Adding a migration

1. Create `migrations/NNN_description.sql` (zero-padded; the runner sorts
   lexically, so determine the next free number first).
2. Wrap destructive changes in `BEGIN; ... COMMIT;` and keep the file idempotent
   where practical.
3. Never edit a file after it has been applied to any environment — add another
   migration instead. The runner checksums files and warns on modification.
4. Reference data changes (permissions, roles, labels) belong in a migration,
   not in application code.

### Manual application

Automatic migration is normally sufficient. To apply a file manually:

```bash
psql "$DATABASE_URL" -f migrations/001_your_migration.sql
```

### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `AUTO_MIGRATE=false` and tables missing | Re-enable auto-migration, or run `npm run server:db:init` for a fresh database. |
| Checksum mismatch warning | A recorded migration file was edited after application. Revert the file or add a new migration. |
| No admin password logged on first start | An admin already exists, or the admin role seed in `init.sql` was not applied. |

## Related

- [Schema reference](./schema.md)
- [Migrations README](../../../migrations/README.md)

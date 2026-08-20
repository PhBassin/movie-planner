# Database Migrations

This directory holds Movie Planner's forward-only SQL migrations, applied by the
application migration runner (`server/src/db/migrations.ts`) at server startup
when `AUTO_MIGRATE=true` (the default).

## Baseline

The consolidated schema and reference data live in [`../docker/init.sql`](../docker/init.sql).
That file is the single source of truth for initializing an empty Movie Planner
database (`movie_planner`) and is applied both by the Docker postgres image on
first startup and by the host-side `npm run server:db:init` path.

The historical numbered migrations were folded into the baseline and removed;
new forward migrations now live here after the baseline. The current sequence
starts at `001` and includes the queue, auth-email-token, verification rate-limit,
password-reset rate-limit, auth-email-token uniqueness, and member selection
changes.

## Creating a migration

Future changes continue from the next free number after the current sequence:

1. Name the file `NNN_short_description.sql` (e.g. `001_add_screen_width.sql`).
2. Make it idempotent where practical and wrap destructive changes in a
   transaction (`BEGIN; ... COMMIT;`).
3. The runner records each file in `schema_migrations` with a SHA-256 checksum.
   Do **not** edit a file after it has been applied to any environment — add a
   new migration instead.
4. The runner applies pending files in lexical order, so zero-pad the prefix.

## How the runner works

1. Creates `schema_migrations` if missing.
2. Verifies checksums of already-applied files (warns on mismatch).
3. Applies pending `.sql` files in order, recording each with its checksum.

## Initial administrator

The initial admin user is **not** seeded by SQL. After migrations complete, the
application bootstrap creates an `admin` user with a securely generated random
password if no admin exists, logging the password once. See
`server/src/db/admin-bootstrap.ts`.

## Manual application (troubleshooting)

Automatic migrations are normally sufficient. To apply a file manually against a
running database:

```bash
psql "$DATABASE_URL" -f migrations/001_your_migration.sql
```

Or, to reinitialize an empty database from the baseline outside Docker:

```bash
npm run server:db:init
```

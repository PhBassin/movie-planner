# 🗄️ Database Troubleshooting

PostgreSQL troubleshooting and debugging guide for Movie Planner.

**Related Documentation:**
- [Database Reference](../reference/database/README.md) - Schema and queries
- [Installation Guide](../getting-started/installation.md) - Initial setup
- [Common Issues](./common-issues.md) - General troubleshooting

---

## Table of Contents

- [Connection Issues](#connection-issues)
- [Migration Issues](#migration-issues)
- [Performance Issues](#performance-issues)
- [Data Integrity](#data-integrity)
- [Backup and Restore](#backup-and-restore)
- [Common Commands](#common-commands)

---

## Connection Issues

### `ECONNREFUSED 127.0.0.1:5432`

**Cause:** PostgreSQL not running or not accessible.

**Solution:**

```bash
# Check if PostgreSQL is running
docker compose ps

# Check environment variables
cat .env | grep POSTGRES

# Restart database
docker compose restart db

# View database logs
docker compose logs db

# Verify connection
docker compose exec db psql -U postgres -d movie_planner -c "SELECT 1;"
```

**Docker-specific:** Use service name `db`, not `localhost` in `POSTGRES_HOST`.

---

### `FATAL: password authentication failed`

**Cause:** Credential mismatch between `.env` and database.

**Solution:**

```bash
# Check .env credentials
cat .env | grep POSTGRES_PASSWORD

# Reset database (destroys data)
docker compose down -v
docker compose up -d

# Or connect with correct password
docker compose exec db psql -U postgres -d movie_planner
```

---

### Connection Pool Exhaustion

**Cause:** Too many concurrent connections.

**Symptoms:**
- Slow API responses
- Timeout errors
- "sorry, too many clients already" error

**Solution:**

```bash
# Check active connections
docker compose exec db psql -U postgres -d movie_planner -c \
  "SELECT count(*) FROM pg_stat_activity WHERE datname='movie_planner';"

# View connection details
docker compose exec db psql -U postgres -d movie_planner -c \
  "SELECT pid, usename, application_name, state, query_start 
   FROM pg_stat_activity WHERE datname='movie_planner';"

# Kill idle connections (if needed)
docker compose exec db psql -U postgres -d movie_planner -c \
  "SELECT pg_terminate_backend(pid) 
   FROM pg_stat_activity 
   WHERE datname='movie_planner' AND state='idle' AND query_start < NOW() - INTERVAL '5 minutes';"
```

**Note:** Application uses default `pg` pool settings (no explicit limits).

---

## Migration Issues

### `relation "movies" does not exist`

**Cause:** Database migrations not applied.

**Solution (automatic mode - recommended):**

Since **v3.1.0**, migrations run automatically at server startup:

```bash
# Ensure AUTO_MIGRATE is enabled (default)
echo "AUTO_MIGRATE=true" >> .env

# Restart server to apply migrations
docker compose restart web

# Check server logs for migration output
docker compose logs web | grep -i migration
```

**Solution (manual mode):**

```bash
# Apply all pending migrations
docker compose exec -T db psql -U postgres -d movie_planner < migrations/001_neutralize_references.sql
docker compose exec -T db psql -U postgres -d movie_planner < migrations/002_add_pg_trgm_extension.sql
# ... repeat for all migrations

# Or apply specific migration
docker compose exec -T db psql -U postgres -d movie_planner < migrations/003_add_users_table.sql
```

---

### Migration Checksum Mismatch

**Warning message:**

```
⚠️  Migration 006_fix_app_settings_schema.sql checksum mismatch (file modified after application)
    Applied checksum: abc123...
    Current checksum: def456...
```

**Cause:** Migration file changed after being applied to database.

**Impact:** Non-fatal - server continues to start, but indicates potential issue.

**Solution:**

```bash
# View migration history
docker compose exec db psql -U postgres -d movie_planner -c \
  "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY applied_at;"

# Check if file was intentionally modified
git log migrations/006_fix_app_settings_schema.sql

# If accidental, restore from git
git checkout HEAD -- migrations/006_fix_app_settings_schema.sql
```

**Note:** Never modify already-applied migrations. Create new migration instead.

---

### Fresh Install - Admin Password

On fresh database, migration `007_seed_default_admin.sql` creates admin user with **random password**.

**Look for this in logs:**

```
═══════════════════════════════════════════════════════════
🔐 DEFAULT ADMIN USER CREATED
═══════════════════════════════════════════════════════════
Username: admin
Password: Xk8#mP2qLz7!nV5w
═══════════════════════════════════════════════════════════
⚠️  SECURITY WARNING:
1. Save this password immediately
2. Change it after first login
3. This password will NOT be shown again
═══════════════════════════════════════════════════════════
```

**If missed:**

```bash
# Reset admin password manually
docker compose exec db psql -U postgres -d movie_planner -c \
  "UPDATE users SET password_hash = '\$2b\$10\$...' WHERE username='admin';"

# Or use API to change password after login
curl -X POST http://localhost:3000/api/auth/change-password \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"old","newPassword":"new"}'
```

---

## Performance Issues

### Slow Queries

**Symptoms:**
- API responses take >1 second
- High CPU usage on `db`

**Diagnosis:**

```bash
# Find slow queries (>100ms)
docker compose exec db psql -U postgres -d movie_planner -c \
  "SELECT pid, now() - pg_stat_activity.query_start AS duration, query 
   FROM pg_stat_activity 
   WHERE state = 'active' AND (now() - pg_stat_activity.query_start) > interval '100 milliseconds';"

# Check table statistics
docker compose exec db psql -U postgres -d movie_planner -c \
  "SELECT schemaname, tablename, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch 
   FROM pg_stat_user_tables 
   ORDER BY seq_tup_read DESC LIMIT 10;"
```

**Solution:**

Check indexes exist:

```bash
docker compose exec db psql -U postgres -d movie_planner -c "\d+ showtimes"
```

Expected indexes:
- Primary keys on all tables
- Foreign keys: `showtimes.theater_id`, `showtimes.movie_id`
- `pg_trgm` extension for fuzzy search (migration 002)

---

### Database Size Growth

**Check database size:**

```bash
docker compose exec db psql -U postgres -d movie_planner -c \
  "SELECT pg_size_pretty(pg_database_size('movie_planner'));"

# Check table sizes
docker compose exec db psql -U postgres -d movie_planner -c \
  "SELECT tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
   FROM pg_tables 
   WHERE schemaname='public' 
   ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;"
```

**Cleanup old data:**

```bash
# Delete old showtimes (older than 30 days)
docker compose exec db psql -U postgres -d movie_planner -c \
  "DELETE FROM showtimes WHERE showtime_datetime < NOW() - INTERVAL '30 days';"

# Vacuum to reclaim space
docker compose exec db psql -U postgres -d movie_planner -c "VACUUM FULL ANALYZE;"
```

---

## Data Integrity

### Constraint Violations

**Error:** `duplicate key value violates unique constraint`

**Cause:** Attempting to insert duplicate data.

**Solution:**

```bash
# Check for duplicates
docker compose exec db psql -U postgres -d movie_planner -c \
  "SELECT theater_id, COUNT(*) FROM theaters GROUP BY theater_id HAVING COUNT(*) > 1;"

# Find constraint details
docker compose exec db psql -U postgres -d movie_planner -c \
  "\d+ theaters"
```

---

### Foreign Key Errors

**Error:** `violates foreign key constraint`

**Cause:** Referenced record doesn't exist (e.g., showtime references non-existent movie).

**Solution:**

```bash
# Find orphaned showtimes
docker compose exec db psql -U postgres -d movie_planner -c \
  "SELECT s.id, s.movie_id 
   FROM showtimes s 
   LEFT JOIN movies f ON s.movie_id = f.id 
   WHERE f.id IS NULL 
   LIMIT 10;"

# Clean up orphaned records
docker compose exec db psql -U postgres -d movie_planner -c \
  "DELETE FROM showtimes 
   WHERE movie_id NOT IN (SELECT id FROM movies);"
```

---

## Backup and Restore

### Manual Backup

```bash
# Backup entire database
docker compose exec -T db pg_dump -U postgres movie_planner > backup-$(date +%Y%m%d).sql

# Backup with compression
docker compose exec -T db pg_dump -U postgres movie_planner | gzip > backup-$(date +%Y%m%d).sql.gz
```

### Manual Restore

```bash
# Restore from backup (stops all connections first)
docker compose exec -T db psql -U postgres -d movie_planner < backup-20260305.sql

# Restore compressed backup
gunzip -c backup-20260305.sql.gz | docker compose exec -T db psql -U postgres -d movie_planner
```


---

## Common Commands

### Connect to Database

```bash
# Interactive psql session
docker compose exec db psql -U postgres -d movie_planner

# Execute single query
docker compose exec db psql -U postgres -d movie_planner -c "SELECT COUNT(*) FROM theaters;"
```

### Useful psql Commands

```sql
-- List all tables
\dt

-- Describe table schema
\d+ theaters

-- List all indexes
\di

-- View migration history
SELECT * FROM schema_migrations ORDER BY applied_at;

-- Check database connections
SELECT * FROM pg_stat_activity WHERE datname='movie_planner';

-- Database size
SELECT pg_size_pretty(pg_database_size('movie_planner'));
```

### Health Check

```bash
# From host
docker compose exec db pg_isready -U postgres

# Check from web container (requires psql inside the container; otherwise use
# pg_isready above or the API health endpoint)
docker compose exec web psql -h db -U postgres -d movie_planner -c "SELECT 1;"
```

### View Logs

```bash
# PostgreSQL logs
docker compose logs db

# Follow logs in real-time
docker compose logs -f db

# Filter for errors
docker compose logs db | grep ERROR
```

---

## Configuration

### Health Check Settings

PostgreSQL health check runs every **10 seconds**:

```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U postgres"]
  interval: 10s
  timeout: 5s
  retries: 5
```

### Connection Pooling

Application uses default `pg.Pool` settings:
- No explicit max connections limit
- No custom timeout configuration
- Relies on PostgreSQL defaults (typically 100 connections)

---

## Related Documentation

- [Database Reference](../reference/database/README.md) - Schema documentation
- [Installation Guide](../getting-started/installation.md) - Initial setup
- [Migration README](../../migrations/README.md) - Migration system details
- [Common Issues](./common-issues.md) - General troubleshooting

---

[← Back to Troubleshooting](./README.md)

#!/bin/bash
# Restore PostgreSQL database from backup for Movie Planner
# Usage: ./scripts/restore-db.sh <backup-file>

set -euo pipefail

# Services holding PostgreSQL connections. They must be stopped for the
# duration of the restore, otherwise the DROP statements block on their locks.
DB_CLIENT_SERVICES=(server scraper scraper-cron)

if [ -z "${1:-}" ]; then
    echo "❌ Error: No backup file specified"
    echo ""
    echo "Usage: $0 <backup-file>"
    echo ""
    echo "Available backups:"
    ls -1 ./backups/*.sql.gz 2>/dev/null || echo "  No backups found"
    exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "❌ Error: Backup file not found: $BACKUP_FILE"
    exit 1
fi

DB_NAME="${POSTGRES_DB:-movie_planner}"
DB_USER="${POSTGRES_USER:-postgres}"

echo "⚠️  WARNING: This will replace the current database ($DB_NAME)!"
echo "   Backup file: $BACKUP_FILE"
echo ""
read -p "Are you sure you want to continue? (yes/no): " -r
echo

if [ "$REPLY" != "yes" ]; then
    echo "❌ Restore cancelled"
    exit 0
fi

# Check if database container is running
if ! docker compose ps --services --filter status=running | grep -qx db; then
    echo "❌ Error: Database container is not running"
    echo "   Start it with: docker compose up -d db"
    exit 1
fi

# Stop the services that hold DB connections so the restore can take its locks
echo "🛑 Stopping services connected to the database..."
docker compose stop "${DB_CLIENT_SERVICES[@]}" 2>/dev/null || true

# Create safety backup before restore
echo "💾 Creating safety backup before restore..."
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SAFETY_BACKUP="./backups/movie_planner_before_restore_${TIMESTAMP}.sql.gz"
mkdir -p ./backups
docker compose exec -T db pg_dump -U "$DB_USER" --clean --if-exists "$DB_NAME" | gzip > "$SAFETY_BACKUP"
echo "   Safety backup saved: $SAFETY_BACKUP"

# Restore database.
# ON_ERROR_STOP + --single-transaction make the restore atomic and loud: either
# the whole dump applies, or nothing changes and this script fails. Without them
# psql reports success after skipping every conflicting statement.
echo "🔄 Restoring database..."
set +e
if [[ "$BACKUP_FILE" == *.gz ]]; then
    gunzip -c "$BACKUP_FILE" \
        | docker compose exec -T db psql -U "$DB_USER" -v ON_ERROR_STOP=1 --single-transaction "$DB_NAME"
    RESTORE_STATUS=${PIPESTATUS[1]}
else
    docker compose exec -T db psql -U "$DB_USER" -v ON_ERROR_STOP=1 --single-transaction "$DB_NAME" < "$BACKUP_FILE"
    RESTORE_STATUS=$?
fi
set -e

# Restart the stopped services regardless of the restore outcome
echo "🚀 Restarting services..."
docker compose start "${DB_CLIENT_SERVICES[@]}" 2>/dev/null || true

if [ "$RESTORE_STATUS" -ne 0 ]; then
    echo ""
    echo "❌ Restore FAILED — the database is unchanged."
    echo "   Backup file: $BACKUP_FILE"
    echo "   Safety backup: $SAFETY_BACKUP"
    echo ""
    echo "   A backup taken before this fix was released has no DROP statements"
    echo "   and cannot be replayed over an existing schema. Recreate the volume"
    echo "   (docker compose down -v && docker compose up -d) and restore into the"
    echo "   fresh database, or take a new backup with ./scripts/backup-db.sh."
    exit 1
fi

echo ""
echo "✅ Database restored successfully!"
echo ""
echo "🔍 Verify with:"
echo "   docker compose exec db psql -U $DB_USER $DB_NAME -c 'SELECT COUNT(*) FROM movies;'"

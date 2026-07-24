#!/bin/bash
# Restore PostgreSQL database from backup for Movie Planner
# Usage: ./scripts/restore-db.sh <backup-file>

set -e

if [ -z "$1" ]; then
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
if ! docker compose ps db | grep -q "Up"; then
    echo "❌ Error: Database container is not running"
    echo "   Start it with: docker compose up -d db"
    exit 1
fi

# Stop server service to prevent active connections during restore
echo "🛑 Stopping server service..."
docker compose stop server 2>/dev/null || true

# Create safety backup before restore
echo "💾 Creating safety backup before restore..."
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SAFETY_BACKUP="./backups/movie_planner_before_restore_${TIMESTAMP}.sql.gz"
docker compose exec -T db pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$SAFETY_BACKUP"
echo "   Safety backup saved: $SAFETY_BACKUP"

# Restore database
echo "🔄 Restoring database..."
if [[ "$BACKUP_FILE" == *.gz ]]; then
    gunzip -c "$BACKUP_FILE" | docker compose exec -T db psql -U "$DB_USER" "$DB_NAME"
else
    docker compose exec -T db psql -U "$DB_USER" "$DB_NAME" < "$BACKUP_FILE"
fi

# Restart server service
echo "🚀 Restarting server service..."
docker compose start server 2>/dev/null || true

echo ""
echo "✅ Database restored successfully!"
echo ""
echo "🔍 Verify with:"
echo "   docker compose exec db psql -U $DB_USER $DB_NAME -c 'SELECT COUNT(*) FROM movies;'"

#!/bin/bash
# Backup PostgreSQL database for Movie Planner
# Usage: ./scripts/backup-db.sh

set -e

BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_NAME="${POSTGRES_DB:-movie_planner}"
DB_USER="${POSTGRES_USER:-postgres}"
BACKUP_FILE="${BACKUP_DIR}/movie_planner_${TIMESTAMP}.sql"

echo "🔄 Creating database backup..."

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Check if database container is running
if ! docker compose ps db | grep -q "Up"; then
    echo "❌ Error: Database container is not running"
    echo "   Start it with: docker compose up -d db"
    exit 1
fi

# Backup database
echo "📦 Dumping database to ${BACKUP_FILE}..."
docker compose exec -T db pg_dump -U "$DB_USER" "$DB_NAME" > "$BACKUP_FILE"

# Compress backup
echo "🗜️  Compressing backup..."
gzip "$BACKUP_FILE"

COMPRESSED_FILE="${BACKUP_FILE}.gz"
BACKUP_SIZE=$(du -h "$COMPRESSED_FILE" | cut -f1)

echo "✅ Backup created successfully!"
echo "   File: ${COMPRESSED_FILE}"
echo "   Size: ${BACKUP_SIZE}"

BACKUP_COUNT=$(find "$BACKUP_DIR" -maxdepth 1 -name "*.sql.gz" | wc -l | tr -d ' ')
echo "   Total backups in directory: ${BACKUP_COUNT}"

echo ""
echo "📋 Recent backups:"
ls -lh "$BACKUP_DIR"/*.sql.gz 2>/dev/null | tail -5 || echo "   No backups found"

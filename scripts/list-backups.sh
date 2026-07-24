#!/bin/bash
# List all database backups
# Usage: ./scripts/list-backups.sh

set -e

BACKUP_DIR="./backups"

echo "📋 Database Backups"
echo ""

display_backups() {
    local dir="$1"
    
    if [ ! -d "$dir" ]; then
        echo "   No backups directory found"
        return
    fi
    
    local files=$(find "$dir" -maxdepth 1 -type f \( -name "*.sql" -o -name "*.sql.gz" \) 2>/dev/null | sort -r)
    
    if [ -z "$files" ]; then
        echo "   No backups found"
        return
    fi
    
    printf "   %-50s %-12s %-20s\n" "FILENAME" "SIZE" "DATE"
    printf "   %-50s %-12s %-20s\n" "$(printf '%.0s-' {1..50})" "$(printf '%.0s-' {1..12})" "$(printf '%.0s-' {1..20})"
    
    echo "$files" | while read -r file; do
        if [ -f "$file" ]; then
            local filename=$(basename "$file")
            local size=$(du -h "$file" | cut -f1)
            local date=$(date -r "$file" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$file" 2>/dev/null || echo "Unknown")
            
            printf "   %-50s %-12s %-20s" "$filename" "$size" "$date"
            
            if [ -f "${file}.sha256" ]; then
                printf " ✓"
            fi
            
            printf "\n"
        fi
    done
}

echo "🏠 Database Backups ($BACKUP_DIR)"
echo ""
display_backups "$BACKUP_DIR"
echo ""

echo "📊 Summary"
echo ""
local_count=$(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name "*.sql" -o -name "*.sql.gz" \) 2>/dev/null | wc -l | tr -d ' ')
local_size=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1 || echo "0B")
echo "   Backups: $local_count files ($local_size total)"

echo ""
echo "💡 Usage:"
echo "   Create backup:  ./scripts/backup-db.sh"
echo "   Restore backup: ./scripts/restore-db.sh <backup-file>"

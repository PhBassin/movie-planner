# Database Backup Scripts

Backup and restore utilities for local development of Movie Planner.

## Quick Start

```bash
# Database Utilities
./scripts/backup-db.sh                    # Create local database backup
./scripts/list-backups.sh                 # List local backups
./scripts/restore-db.sh <backup-file>     # Restore database backup
```

---

## Features

✅ **Local PostgreSQL Dump** - Uses Docker Compose `db` service  
✅ **Safety Backups** - Automatic backup before restore  
✅ **Compression** - gzip compression saves ~90% space  
✅ **No Auto-deletion** - All backups kept indefinitely  
✅ **Error Handling** - Comprehensive checks and error messages  

---

## Scripts Overview

### `backup-db.sh`

Create a compressed backup of the local PostgreSQL database (`movie_planner`).

**Usage:**
```bash
./scripts/backup-db.sh
```

**Output:**
- Backup file: `./backups/movie_planner_YYYYMMDD_HHMMSS.sql.gz`
- Compressed with gzip
- Displays file size and total backups count

---

### `restore-db.sh`

Restore the local database from a backup file.

**Usage:**
```bash
./scripts/restore-db.sh <backup-file>
```

**Features:**
- Creates safety backup (`movie_planner_before_restore_*.sql.gz`) before restore
- Stops server service during restore
- Supports `.sql` and `.sql.gz` files
- Interactive confirmation prompt

---

### `list-backups.sh`

List all local database backups with details.

**Usage:**
```bash
./scripts/list-backups.sh
```

---

## Backup Storage

Backups are organized in the following structure:

```
./backups/
├── movie_planner_20260724_180000.sql.gz          # Local backup
└── movie_planner_before_restore_20260724_180500.sql.gz # Safety backup
```

**Important:**
- All backups are kept indefinitely
- Directory is excluded from git (`.gitignore`)

---

## Manual Commands

If you need to create or restore backups manually via Docker Compose:

```bash
# Dump database
docker compose exec -T db pg_dump -U postgres movie_planner | gzip > ./backups/manual_$(date +%Y%m%d_%H%M%S).sql.gz

# Restore database
gunzip -c ./backups/manual_20260724_180000.sql.gz | docker compose exec -T db psql -U postgres movie_planner
```

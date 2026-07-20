#!/usr/bin/env bash
# Backup the OpenMAIC SaaS Postgres (auth + business schemas) from the
# .saas-stack compose deployment. Keeps the last KEEP generations.
#
#   scripts/backup-saas-db.sh [output-dir]
#
# Restore:  gunzip -c <file>.sql.gz | docker exec -i supabase-db psql -U postgres -d postgres
# Cron:     17 3 * * * /path/to/repo/scripts/backup-saas-db.sh /var/backups/openmaic
set -euo pipefail

CONTAINER="${SAAS_DB_CONTAINER:-supabase-db}"
OUT_DIR="${1:-backups}"
KEEP="${BACKUP_KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT_DIR/openmaic-saas-$STAMP.sql.gz"

mkdir -p "$OUT_DIR"
docker exec "$CONTAINER" pg_dump -U postgres -d postgres --clean --if-exists | gzip >"$FILE"
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"

# Prune older generations.
ls -1t "$OUT_DIR"/openmaic-saas-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

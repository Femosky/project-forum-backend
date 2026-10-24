#!/usr/bin/env bash
# Restores a pg_dump file into an empty database and checks it matches the source: same tables, same row counts in
# the tables that matter. Used by .github/workflows/backup.yml; works locally too:
#   scripts/backup-check.sh backup.dump "$SOURCE_URL" postgresql://localhost/empty_db
set -euo pipefail
dump="$1"; source_url="$2"; restore_url="$3"

# Hosted Postgres adds roles and settings a plain server lacks; those statements may fail without affecting the data,
# so failures are listed rather than fatal, and the comparison below decides.
pg_restore --no-owner --no-privileges --dbname="$restore_url" "$dump" 2> restore-errors.log || true
if [ -s restore-errors.log ]; then echo "pg_restore warnings:"; grep -i "error" restore-errors.log | head -20; fi

tables="SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"
counts='SELECT (SELECT count(*) FROM "User") || \x27 users, \x27 || (SELECT count(*) FROM "Post") || \x27 posts, \x27 || (SELECT count(*) FROM "Comment") || \x27 comments, \x27 || (SELECT count(*) FROM "_prisma_migrations") || \x27 migrations\x27'
counts=$(printf "$counts")

source_tables=$(psql "$source_url" -Atc "$tables")
restored_tables=$(psql "$restore_url" -Atc "$tables")
source_counts=$(psql "$source_url" -Atc "$counts")
restored_counts=$(psql "$restore_url" -Atc "$counts")

echo "Source:   $source_tables tables, $source_counts"
echo "Restored: $restored_tables tables, $restored_counts"
# Rows written between the dump and this check can make the live counts a little higher, never lower
if [ "$source_tables" != "$restored_tables" ] || [ "$restored_counts" = "" ]; then echo "Restore check failed"; exit 1; fi
read -r su _ sp _ sc _ <<< "${source_counts//,/}"
read -r ru _ rp _ rc _ <<< "${restored_counts//,/}"
if [ "$ru" -gt "$su" ] || [ "$rp" -gt "$sp" ] || [ "$rc" -gt "$sc" ] || [ $((su - ru + sp - rp + sc - rc)) -gt 50 ]; then
    echo "Restore check failed: row counts differ"; exit 1
fi
echo "Restore check passed"

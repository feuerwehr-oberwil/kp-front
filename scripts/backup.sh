#!/usr/bin/env bash
# Back up a docker-compose deployment: Postgres dump + storage-volume tarball, with retention.
# The two stores belong together — a DB restored against an older/newer storage volume leaves
# media rows pointing at missing blobs — so this always captures both, back to back.
#
# Usage:  scripts/backup.sh [backup-dir]     # default ./backups
# Env:    BACKUP_KEEP=14                     # how many of each file to keep (default 14)
#
# Run it from cron on the docker host, e.g. daily at 03:30:
#   30 3 * * * cd /opt/kp-front && ./scripts/backup.sh /var/backups/kp-front >> /var/log/kp-front-backup.log 2>&1
#
# Restore (fresh stack): see docs/DEPLOYMENT.md §6 — and do one restore DRILL before you
# depend on these files.
set -euo pipefail

cd "$(dirname "$0")/.."

DIR="${1:-./backups}"
KEEP="${BACKUP_KEEP:-14}"
STAMP="$(date +%F-%H%M%S)"
mkdir -p "$DIR"

echo "→ 1/2  Postgres dump"
docker compose exec -T db pg_dump -U "${POSTGRES_USER:-kpfront}" "${POSTGRES_DB:-kpfront}" \
  | gzip > "$DIR/db-$STAMP.sql.gz"

echo "→ 2/2  storage volume (media, plans, snapshots)"
docker compose exec -T app tar czf - -C /data/storage . > "$DIR/storage-$STAMP.tar.gz"

# Retention: keep the newest $KEEP of each series.
ls -1t "$DIR"/db-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
ls -1t "$DIR"/storage-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --

echo "✓ Backup complete: $DIR/db-$STAMP.sql.gz + $DIR/storage-$STAMP.tar.gz (keeping $KEEP)"

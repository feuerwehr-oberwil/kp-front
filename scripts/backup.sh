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

# ⚠️ Write to .part, verify, THEN rename — the same shape backend/start.sh uses for the
# pre-migration dump, and for the same reason. Writing straight to the final name means a dump
# that dies half-way (the container restarts, the disk fills, the connection drops) leaves a
# truncated file sitting there looking like a backup. `set -euo pipefail` aborts the script, but
# the fragment stays — and the NEXT run's retention counts it as one of the newest $KEEP and
# rotates a good backup out to make room for it. A directory of fragments is worse than a
# directory with one missing night, because it looks fine.
dump() {   # dump <final-path> <command...>
  local out="$1"; shift
  if "$@" > "$out.part" && [ -s "$out.part" ] && gzip -t "$out.part" 2>/dev/null; then
    mv "$out.part" "$out"
  else
    rm -f "$out.part"
    echo "ERROR: $(basename "$out") failed or produced an unreadable file — NOT kept." >&2
    exit 1
  fi
}

echo "→ 1/2  Postgres dump"
dump "$DIR/db-$STAMP.sql.gz" sh -c \
  'docker compose exec -T db pg_dump -U "${POSTGRES_USER:-kpfront}" "${POSTGRES_DB:-kpfront}" | gzip'

echo "→ 2/2  storage volume (media, plans, snapshots)"
dump "$DIR/storage-$STAMP.tar.gz" docker compose exec -T app tar czf - -C /data/storage .

# Retention: keep the newest $KEEP of each series. Only complete files are ever named like this
# (see `dump` above), so this can never rotate a good backup out in favour of a fragment.
ls -1t "$DIR"/db-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
ls -1t "$DIR"/storage-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --

echo "✓ Backup complete: $DIR/db-$STAMP.sql.gz + $DIR/storage-$STAMP.tar.gz (keeping $KEEP)"

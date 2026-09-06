#!/usr/bin/env bash
# Back up a docker-compose deployment: Postgres dump + storage-volume tarball, with retention.
# The two stores belong together — a DB restored against an older/newer storage volume leaves
# media rows pointing at missing blobs – app.backup coordinates their capture while edits continue.
#
# Usage:  scripts/backup.sh [backup-dir]     # default ./backups
# Keep:   BACKUP_KEEP=14                     # how many of each file to keep (default 14).
#         Read from .env first, then the environment — under cron there IS no environment, so
#         a value that only worked when exported from a shell was a setting that did nothing
#         on the one run that matters.
#
# Run it from cron on the docker host, e.g. daily at 03:30. `./scripts/setup.sh --backup-cron`
# installs that line for you and then runs it once under cron's own near-empty environment,
# because `docker: command not found` at 03:30 is the single most common reason a backup job
# silently never ran. By hand it wants the PATH spelled out, for the same reason:
#   30 3 * * * cd /opt/kp-front && PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin ./scripts/backup.sh /var/backups/kp-front >> /var/backups/kp-front/backup.log 2>&1
#
# Restore: `./scripts/restore.sh --dry-run <this directory>/db-<stamp>.sql.gz`, which puts both
# halves back together. Do one restore DRILL before you depend on these files.
set -euo pipefail

# ⚠️ Before anything is created. What this script writes is the station's whole Postgres dump —
# roster, every Einsatz, the peppered PIN hashes, the encrypted credential rows — plus every
# uploaded photo, Sprachnotiz and Objektplan. Under the default umask that landed as 0644 in a
# 0755 directory, readable by every account on the host; `/var/backups/kp-front` (the directory
# the installer offers to schedule into) is not private by default either. `scripts/init-env.sh`
# already chmods .env to 600 before writing the secrets into it — this is that same rule for the
# files that contain everything .env protects.
umask 077

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"      # kp_env_value — the same .env reader restore.sh and doctor.sh use

DIR="${1:-./backups}"

# ⚠️ WHICH DEPLOYMENT THIS BACKS UP. `restore.sh --env-file <other>` calls this script for its
# pre-restore safety copy, and this script used to read `./.env` unconditionally and call bare
# `docker compose` — so the safety copy was taken from a DIFFERENT deployment than the one about
# to be overwritten, silently, and was then reported as taken. `KP_ENV_FILE` is the same handle
# restore.sh and doctor.sh already accept.
ENV_FILE="${KP_ENV_FILE:-.env}"
COMPOSE_ARGS=()
[[ "$ENV_FILE" == ".env" ]] || COMPOSE_ARGS+=(--env-file "$ENV_FILE")

# An explicit BACKUP_KEEP in the environment wins (a one-off `BACKUP_KEEP=3 scripts/backup.sh`
# must mean 3), then .env — which is the one that matters, because cron hands this script no
# environment at all and a retention setting that only worked when exported was a setting that
# did nothing on every scheduled run.
KEEP="${BACKUP_KEEP:-$(kp_env_value BACKUP_KEEP 14 "$ENV_FILE")}"
# A non-number here would abort the retention arithmetic AFTER both dumps are written — the
# backup would be fine and the script would still exit red every night. Fall back instead.
[[ "$KEEP" =~ ^[0-9]+$ ]] && ((10#$KEEP > 0)) || KEEP=14
KEEP=$((10#$KEEP))
kp_operation_lock "$ENV_FILE" backup "${KP_OPERATION_PARENT_TOKEN:-}" || exit 1
trap kp_operation_unlock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
STAMP="$(date +%F-%H%M%S)"
mkdir -p "$DIR"
# …and tighten a directory that already existed, which `umask` above cannot reach. Not fatal:
# a shared/root-owned backup target is a legitimate setup, and refusing to back up because the
# permissions are not ours to change would trade a confidentiality worry for no backup at all.
chmod 700 "$DIR" 2>/dev/null || echo "WARN: could not chmod 700 $DIR — check who can read it." >&2

# Keep Compose interpolation aligned with the selected env file under cron as well.
POSTGRES_USER="$(kp_env_value POSTGRES_USER "${POSTGRES_USER:-kpfront}" "$ENV_FILE")"
POSTGRES_DB="$(kp_env_value POSTGRES_DB "${POSTGRES_DB:-kpfront}" "$ENV_FILE")"
export POSTGRES_USER POSTGRES_DB

# The helper holds a shared deletion guard from before the SQL snapshot through hardlink
# pinning. Replacements use fresh keys; deletes retain old files until they are pinned.
# Compression reads the private snapshot while the live app continues accepting changes.
# Run a one-off container: the same path must work when recovery has stopped the app.
STAGE="$(mktemp -d "$DIR/.backup-XXXXXX")"
STAMP="$STAMP-${STAGE##*-}"
COMPLETE=0
cleanup() {
  rm -rf "$STAGE"
  if [[ "$COMPLETE" -eq 0 ]]; then
    rm -f "$DIR/db-$STAMP.sql.gz" "$DIR/storage-$STAMP.tar.gz"
  fi
  kp_operation_unlock
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "→ Capturing coordinated database and storage backup (incident edits remain available)"
if ! compose run --rm --no-deps -T app uv run python -m app.backup </dev/null \
     | tar xf - -C "$STAGE"; then
  echo "ERROR: coordinated backup failed – no pair published or previous backup rotated." >&2
  exit 1
fi

# Verify both content types before publishing either half. gzip integrity alone also accepts
# an empty stream. Keep the dump prefix in a variable to avoid grep's early-exit SIGPIPE.
DB_PART="$STAGE/db.sql.gz"
STORAGE_PART="$STAGE/storage.tar.gz"
if ! gzip -t "$DB_PART" || ! gzip -t "$STORAGE_PART" || ! kp_storage_archive_list "$STORAGE_PART" >/dev/null; then
  echo "ERROR: backup pair is missing or unreadable – NOT kept." >&2
  exit 1
fi
DUMP_HEAD="$(gunzip -c "$DB_PART" | head -c 65536 || true)"
if ! printf '%s' "$DUMP_HEAD" | grep -q 'PostgreSQL database dump'; then
  echo "ERROR: database half is not a PostgreSQL dump – NOT kept." >&2
  exit 1
fi
unset DUMP_HEAD
mv "$DB_PART" "$DIR/db-$STAMP.sql.gz"
mv "$STORAGE_PART" "$DIR/storage-$STAMP.tar.gz"
COMPLETE=1

# Retain complete pairs as a unit. Filenames are generated above and sort by capture time.
# Ignore historic orphans; they must not count toward retention of restorable pairs.
kept=1 # Always retain the pair just completed, including multiple runs within one second.
while IFS= read -r db; do
  [[ "$db" == "$DIR/db-$STAMP.sql.gz" ]] && continue
  stamp="${db##*/db-}"
  assets="$DIR/storage-${stamp%.sql.gz}.tar.gz"
  [[ -f "$assets" ]] || continue
  kept=$((kept + 1))
  if (( kept > KEEP )); then
    rm -f "$db" "$assets"
  fi
done < <(find "$DIR" -maxdepth 1 -name 'db-*.sql.gz' -type f | sort -r)

echo "✓ Backup complete: $DIR/db-$STAMP.sql.gz + $DIR/storage-$STAMP.tar.gz (keeping $KEEP pairs)"

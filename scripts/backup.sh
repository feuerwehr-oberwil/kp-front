#!/usr/bin/env bash
# Back up a docker-compose deployment: Postgres dump + storage-volume tarball, with retention.
# The two stores belong together — a DB restored against an older/newer storage volume leaves
# media rows pointing at missing blobs — so this always captures both, back to back.
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
compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

# An explicit BACKUP_KEEP in the environment wins (a one-off `BACKUP_KEEP=3 scripts/backup.sh`
# must mean 3), then .env — which is the one that matters, because cron hands this script no
# environment at all and a retention setting that only worked when exported was a setting that
# did nothing on every scheduled run.
KEEP="${BACKUP_KEEP:-$(kp_env_value BACKUP_KEEP 14 "$ENV_FILE")}"
# A non-number here would abort the retention arithmetic AFTER both dumps are written — the
# backup would be fine and the script would still exit red every night. Fall back instead.
[[ "$KEEP" =~ ^[0-9]+$ ]] && ((10#$KEEP > 0)) || KEEP=14
STAMP="$(date +%F-%H%M%S)"
mkdir -p "$DIR"
# …and tighten a directory that already existed, which `umask` above cannot reach. Not fatal:
# a shared/root-owned backup target is a legitimate setup, and refusing to back up because the
# permissions are not ours to change would trade a confidentiality worry for no backup at all.
chmod 700 "$DIR" 2>/dev/null || echo "WARN: could not chmod 700 $DIR — check who can read it." >&2

# The DB identity has to come from .env, not from whoever's shell started this. `docker compose`
# reads .env by itself, but the `-U user db` arguments below are OURS – under cron the
# environment is all but empty, so a station that changed POSTGRES_USER in .env would dump as
# "kpfront" and fail every night at 03:30, into a log nobody reads.
# kp_env_value (scripts/lib.sh) reads the keys out rather than sourcing the file: .env holds
# passwords and URLs, and `. .env` would hand a `$` or a backtick in one of them to the shell.
#
# .env wins; an exported value is the fallback (no .env, e.g. a managed DATABASE_URL setup).
POSTGRES_USER="$(kp_env_value POSTGRES_USER "${POSTGRES_USER:-kpfront}" "$ENV_FILE")"
POSTGRES_DB="$(kp_env_value POSTGRES_DB "${POSTGRES_DB:-kpfront}" "$ENV_FILE")"
export POSTGRES_USER POSTGRES_DB

# ⚠️ Write to .part, verify, THEN rename — the same shape backend/start.sh uses for the
# pre-migration dump, and for the same reason. Writing straight to the final name means a dump
# that dies half-way (the container restarts, the disk fills, the connection drops) leaves a
# truncated file sitting there looking like a backup. `set -euo pipefail` aborts the script, but
# the fragment stays — and the NEXT run's retention counts it as one of the newest $KEEP and
# rotates a good backup out to make room for it. A directory of fragments is worse than a
# directory with one missing night, because it looks fine.
#
# ⚠️⚠️ AND «VERIFY» HAS TO MEAN THE CONTENT, NOT THE CONTAINER. `[ -s ]` + `gzip -t` was not
# enough, and the gap was not theoretical: gzip of an EMPTY input is a valid ~20-byte gzip file
# that passes both. Combined with the `sh -c '… | gzip'` below — POSIX sh, no `pipefail`, so
# the pipeline's status is GZIP's and a failed `pg_dump` exits 0 — a night when the db container
# was restarting produced a 20-byte "backup", printed «✓ Backup complete», and let retention
# count it among the newest $KEEP and rotate a real one out. `restore.sh` calls this for its
# pre-restore safety copy, so the same hole meant the safety net silently was not there on the
# one day anybody needed it. Each stream is therefore checked for what it is supposed to BE.
verify_pgdump() {
  local head_bytes
  # ⚠️ Into a variable, not straight into `grep -q`: grep exits at the first match, gunzip takes
  # SIGPIPE, and `set -o pipefail` then reports the pipeline as failed — i.e. finding the
  # fingerprint would be what made the check say it was missing. Same trap restore.sh documents.
  head_bytes="$(gunzip -c "$1" 2>/dev/null | head -c 65536 || true)"
  printf '%s' "$head_bytes" | grep -q 'PostgreSQL database dump'
}

verify_tar() { tar tzf "$1" >/dev/null 2>&1; }

dump() {   # dump <final-path> <verifier> <command...>
  local out="$1" verify="$2"; shift 2
  if "$@" > "$out.part" && [ -s "$out.part" ] && gzip -t "$out.part" 2>/dev/null && "$verify" "$out.part"; then
    mv "$out.part" "$out"
  else
    rm -f "$out.part"
    echo "ERROR: $(basename "$out") failed or produced an unreadable file — NOT kept." >&2
    exit 1
  fi
}

echo "→ 1/2  Postgres dump ($POSTGRES_USER@$POSTGRES_DB)"
# ⚠️ A BASH FUNCTION, not `sh -c '… | gzip'`. `dump` runs its command in THIS shell, so the
# `set -o pipefail` at the top of the file applies and a failed `pg_dump` fails the pipeline.
# Under `sh -c` it did not: /bin/sh is dash on Debian, dash has no pipefail, and the status
# reported was gzip's — which is how a refused connection became a 20-byte «backup». The
# storage half below was always a function, and was always correct, for exactly this reason.
pgdump_gz() {
  compose exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" </dev/null | gzip
}
dump "$DIR/db-$STAMP.sql.gz" verify_pgdump pgdump_gz

echo "→ 2/2  storage volume (media, plans, snapshots)"
# `exec` needs a RUNNING app container, and the night this matters most is the night it is not
# running — a restart loop, a stopped stack, a restore in progress. Then `exec` fails, the
# script exits, and the directory keeps a database dump with no storage half: a pair that
# scripts/restore.sh will (correctly) refuse to restore. `run --rm --no-deps` mounts the same
# volume from the same image without needing the app to be alive, so it is the fallback.
# ⚠️ Chosen up front, never as `exec || run`: a fallback that starts after exec has already
# written some bytes concatenates two gzip streams into a file that still passes `gzip -t`.
storage_tar() {
  local cid running=""
  cid="$(compose ps -q app 2>/dev/null | head -1 || true)"
  [[ -z "$cid" ]] || running="$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || true)"
  if [[ "$running" == "true" ]]; then
    compose exec -T app tar czf - -C /data/storage . </dev/null
  else
    compose run --rm --no-deps -T app tar czf - -C /data/storage . </dev/null
  fi
}
dump "$DIR/storage-$STAMP.tar.gz" verify_tar storage_tar

# Retention: keep the newest $KEEP of each series. Only complete files are ever named like this
# (see `dump` above), so this can never rotate a good backup out in favour of a fragment.
ls -1t "$DIR"/db-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
ls -1t "$DIR"/storage-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --

echo "✓ Backup complete: $DIR/db-$STAMP.sql.gz + $DIR/storage-$STAMP.tar.gz (keeping $KEEP)"

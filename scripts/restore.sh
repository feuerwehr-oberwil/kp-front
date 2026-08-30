#!/usr/bin/env bash
# KP Front — put a backup back. The worst day, made into one command.
#
#   ./scripts/restore.sh --dry-run backups/db-2026-08-15-033001.sql.gz   # ← always start here
#   ./scripts/restore.sh           backups/db-2026-08-15-033001.sql.gz
#   ./scripts/restore.sh --db-only /data/storage/backups/pre-migrate-….sql.gz
#
# ⚠️ This is a SCRIPT and never a button, on purpose. You need it exactly when the app does
# not serve pages — a failed migration, a lost disk, a database restored onto a new box. A
# restore that lives inside the thing being restored cannot run on the day it is for.
#
# It restores the database AND the storage volume TOGETHER, because they are one backup: a
# database restored against a mismatched volume leaves media rows pointing at blobs that are
# not there, and that failure surfaces one photo at a time, weeks later.
#
# What it will not do:
#   · run against half a pair (no storage tarball for that dump) unless you say --db-only
#   · run against an archive it cannot read — both files are integrity-checked FIRST, before
#     anything is dropped, because "the backup was corrupt" must not be discovered afterwards
#   · run against a dump that is not this application's
#   · destroy anything without printing what, and without a safety copy of it
#
# ⚠️ .env is NOT in any backup, and SECRET_KEY peppers every PIN hash in the database you are
# restoring. Restore a database under a different SECRET_KEY and every account is locked out,
# indistinguishably from "wrong PIN". docs/DEPLOYMENT.md §6.
set -euo pipefail

KP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$KP_SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib.sh
. "$KP_SCRIPT_DIR/lib.sh"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ─── OPERATOR-FACING STRINGS ──────────────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════════════════════

T_USAGE="KP Front — restore a backup into this deployment.

Usage: scripts/restore.sh [options] <db-backup.sql.gz>

The storage tarball is found next to the dump by its timestamp (db-<stamp>.sql.gz pairs with
storage-<stamp>.tar.gz) and restored with it — they are one backup.

  --dry-run          Say exactly what would happen and change no data. Do this first.
                     (It does start the 'db' container if it is not running, in order to read
                     the current row counts, and stops it again if it started it.)
  --db-only          Restore the database alone. For the pre-migration dumps written by
                     backend/start.sh, which have no storage half. ⚠️ Read the warning it
                     prints: uploads made since that dump become rows pointing at nothing.
  --storage <file>   Use this tarball instead of the one found by timestamp.
  --env-file <path>  Read this instead of ./.env.
  -y, --yes          Skip the typed confirmation. For scripted recovery only.
  -h, --help         This text.

Afterwards the stack is started again and this script waits for /ready before reporting."

T_TITLE="KP Front — restore"
T_STEP_FILES="The backup"
T_STEP_TARGET="What it replaces"
T_STEP_CONFIRM="Confirm"
T_STEP_RESTORE="Restoring"
T_STEP_VERIFY="Verifying"

T_ERR_NO_FILE_FMT="No such backup file: %s"
T_ERR_NEED_FILE=\
"Name the database dump to restore, e.g.
    ./scripts/restore.sh --dry-run backups/db-2026-08-15-033001.sql.gz
What is in the backup directory:"
T_ERR_BAD_GZIP_FMT="%s is not a readable gzip file — it is truncated or corrupt. NOTHING has
been touched. Try the backup from the night before; a directory of intact backups is the
reason scripts/backup.sh writes to .part and renames only after it verifies."
T_ERR_NOT_A_DUMP_FMT="%s is a readable gzip file, but what is inside it is not a pg_dump —
there is no 'PostgreSQL database dump' header. Whatever this is, it is not a database backup
of this or any other deployment, and nothing has been touched."
T_ERR_NOT_A_TAR_FMT="%s is a readable gzip file, but there is no tar archive inside it — it
cannot be the storage half of a backup. Refusing BEFORE anything is touched, because restoring
empties the storage volume before it unpacks: had this run, the media would have been deleted
and nothing would have replaced them. Nothing has been touched."
T_ERR_EMPTY_DUMP_FMT="%s is a pg_dump, but it contains no KP Front schema at all — no
'alembic_version', which every KP Front database has. It is either another system's database
or a dump of an empty one (a pre-migration dump taken on a FIRST boot looks exactly like
this), and restoring it would leave you with an empty deployment. Nothing has been touched.
  If you are certain you want it anyway:
    gunzip -c %s | docker compose exec -T db psql -U %s -v ON_ERROR_STOP=1 %s"
T_ERR_NO_PAIR_FMT="Found the database dump but not its storage half:
    %s        ← missing
The two are one backup. A database restored against a mismatched volume leaves media rows
pointing at blobs that are not there, and you find out one photo at a time.
  If the tarball is somewhere else:   --storage <file>
  If you genuinely want the database alone (a pre-migration dump has no storage half):
      --db-only"
T_ERR_NO_ENV_FMT="No %s here, so there is nothing to restore INTO. Run this from the checkout
the deployment was installed from."
T_ERR_NO_DB_SERVICE="This compose project has no 'db' service running and none could be
started, so there is no database to restore into. Look:  docker compose ps"
T_WARN_DB_ONLY="⚠️ --db-only: the storage volume is left exactly as it is. Anything uploaded
  after this dump was taken — photos, voice memos, plan PDFs — will survive as files with no
  row pointing at them, and anything the dump expects that is NOT on the volume is a broken
  link in the app. Correct for a pre-migration dump taken minutes ago; wrong for a backup
  from last week."

T_FILES_FMT="Database dump:  %s  (%s, %s)
  Storage tarball: %s  (%s, %s files)"
T_FILES_DB_ONLY_FMT="Database dump:  %s  (%s, %s)
  Storage tarball: none — --db-only"
T_INTEGRITY_OK="Both files are intact (gzip verified) and the dump is this application's."
T_INTEGRITY_OK_DB="The dump is intact (gzip verified) and is this application's."

T_TARGET_FMT="Deployment:     project '%s', database '%s' as user '%s'
  Right now it holds: %s incident(s), %s account(s), %s media row(s)
  Storage volume:     %s file(s), %s"
T_TARGET_EMPTY="This deployment has no data yet — a fresh stack. Nothing is lost either way."
T_TARGET_UNREADABLE="Could not read the current contents (the database is not answering).
  That is normal on the day you need this script. Whatever is in there will still be replaced."

T_DESTROY="⚠️ EVERYTHING above is REPLACED, not merged:
     · the database is dropped and rebuilt from the dump
     · the storage volume is emptied and refilled from the tarball
  A safety copy of the CURRENT state is taken first, into
     %s
  so that picking the wrong backup file is survivable."
T_DESTROY_DB_ONLY="⚠️ The database above is REPLACED, not merged: dropped and rebuilt from the
  dump. The storage volume is left alone. A safety copy of the current state — database AND
  volume, so the pair stays restorable — is taken first, into
     %s"
T_SECRET_KEY_WARN="⚠️ Check SECRET_KEY in %s before you rely on the result. It is not in any
  backup, and it peppers every PIN hash in the database being restored. If this file's
  SECRET_KEY is not the one that was live when the backup was taken, every account will be
  locked out and it will look exactly like «wrong PIN»."
T_DRY_RUN_DB_STOPPED="The 'db' container was started to read those numbers and has been stopped
  again — the stack is as it was before this check."
T_CONFIRM_PROMPT="Type 'restore' to go ahead (anything else stops)"
T_ABORTED="Stopped. Nothing was changed."
T_DRY_RUN="--dry-run: stopping here. Nothing was restored and no data was touched. Re-run
  without --dry-run to do it."

T_R_STOP="Stopping the app so nothing writes while the data underneath it is replaced…"
T_R_SAFETY_FMT="Safety copy of the current state → %s"
T_R_SAFETY_FAIL="Could not take the safety copy (output above). That usually means the thing
you are restoring is already too broken to dump — which is a reason to continue, not to stop.
Continuing WITHOUT a safety copy."
T_R_DB="Rebuilding the database from the dump…"
T_R_DB_FAIL="The database restore FAILED (output above) and stopped at the first error rather
than half-applying the dump. The stack is still stopped. Nothing else was touched; the safety
copy above is your way back."
T_R_STORAGE="Emptying and refilling the storage volume…"
T_R_STORAGE_FAIL="The storage restore FAILED (output above). The DATABASE has already been
replaced, so this deployment is now a restored database against a half-restored volume — do
not put it into service. Fix the cause and re-run this same command."
T_R_START="Starting the stack again…"

T_V_TABLES_FMT="Database: %s incident(s), %s account(s), %s media row(s), schema at %s."
T_V_STORAGE_FMT="Storage volume: %s file(s) restored."
T_V_READY_FMT="/ready is green after %ds."
T_V_ROSTER_FMT="The login screen offers %s account(s)."
T_V_NOT_READY="The stack came back up but /ready is not green. The restore itself finished;
this is now an ordinary startup problem:  ./scripts/doctor.sh"
T_DONE="Restored. Two things to do before you call it done:
  1. Log in. If PINs are refused, SECRET_KEY does not match the backup (see the warning above).
  2. Open a restored incident and its photos — that is the half no query can verify."

# ══════════════════════════════════════════════════════════════════════════════════════════

DRY_RUN=0
DB_ONLY=0
ASSUME_YES=0
DB_FILE=""
STORAGE_FILE=""
ENV_FILE="${KP_ENV_FILE:-}"
TIMEOUT=180

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  DRY_RUN=1; shift ;;
    --db-only)  DB_ONLY=1; shift ;;
    --storage)  [[ $# -ge 2 && "$2" != -* ]] || die "--storage needs a file after it."
                STORAGE_FILE="$2"; shift 2 ;;
    --env-file) [[ $# -ge 2 && "$2" != -* ]] || die "--env-file needs a path after it."
                ENV_FILE="$2"; shift 2 ;;
    -y|--yes)   ASSUME_YES=1; shift ;;
    -h|--help)  say "$T_USAGE"; exit 0 ;;
    -*)         say "$T_USAGE" >&2; die "unknown option: $1" ;;
    *)          [[ -z "$DB_FILE" ]] || die "Only one database dump at a time (got '$DB_FILE' and '$1')."
                DB_FILE="$1"; shift ;;
  esac
done

cd "$REPO_ROOT"
[[ -n "$ENV_FILE" ]] || ENV_FILE=".env"

printf '\n%s%s%s\n' "$C_B" "$T_TITLE" "$C_0"

preflight >/dev/null || { preflight; exit 1; }
[[ -e "$ENV_FILE" ]] || die "$(sayf "$T_ERR_NO_ENV_FMT" "$ENV_FILE")"
[[ "$ENV_FILE" == ".env" ]] || COMPOSE_ARGS+=(--env-file "$ENV_FILE")

PORT="$(kp_env_value APP_PORT 8000 "$ENV_FILE")"
PGUSER_="$(kp_env_value POSTGRES_USER kpfront "$ENV_FILE")"
PGDB_="$(kp_env_value POSTGRES_DB kpfront "$ENV_FILE")"

# Which compose project is about to be overwritten — asked, never assumed. It comes from
# COMPOSE_PROJECT_NAME, or `name:` in docker-compose.yml, or the directory, and printing a
# guess in the paragraph that says "this is what gets destroyed" would be the wrong place to
# be approximately right. The container's own label is the only answer that cannot be wrong;
# the rest is for a stack that is not running.
compose_project() {
  local cid label=""
  cid="$(compose ps -aq db 2>/dev/null | head -1 || true)"
  if [[ -n "$cid" ]]; then
    label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$cid" 2>/dev/null || true)"
  fi
  [[ -n "$label" ]] || label="${COMPOSE_PROJECT_NAME:-}"
  [[ -n "$label" ]] || label="$(sed -n 's/^name:[[:space:]]*//p' docker-compose.yml 2>/dev/null | head -1)"
  [[ -n "$label" ]] || label="$(basename "$REPO_ROOT")"
  printf '%s' "$label"
}
PROJECT="$(compose_project)"

if [[ -z "$DB_FILE" ]]; then
  say "$T_ERR_NEED_FILE" >&2
  # shellcheck disable=SC2012  # the names are ours: db-<stamp>.sql.gz, ASCII by construction
  ls -1t ./backups/db-*.sql.gz 2>/dev/null | head -5 >&2 || true
  exit 1
fi

# ─── 1. the backup ────────────────────────────────────────────────────────────────────────

step "$T_STEP_FILES"

[[ -f "$DB_FILE" ]] || die "$(sayf "$T_ERR_NO_FILE_FMT" "$DB_FILE")"

# The storage half, by the timestamp in the name: db-<stamp>.sql.gz ↔ storage-<stamp>.tar.gz.
if [[ "$DB_ONLY" -eq 0 && -z "$STORAGE_FILE" ]]; then
  db_base="$(basename "$DB_FILE")"
  stamp="${db_base#db-}"; stamp="${stamp%.sql.gz}"
  STORAGE_FILE="$(dirname "$DB_FILE")/storage-${stamp}.tar.gz"
  [[ -f "$STORAGE_FILE" ]] || die "$(sayf "$T_ERR_NO_PAIR_FMT" "$STORAGE_FILE")"
fi
if [[ "$DB_ONLY" -eq 0 ]]; then
  [[ -f "$STORAGE_FILE" ]] || die "$(sayf "$T_ERR_NO_FILE_FMT" "$STORAGE_FILE")"
fi

# ⚠️ Integrity FIRST, before anything is dropped. "The backup was corrupt" is a survivable
# discovery now and an unsurvivable one after the database has been rebuilt from it.
gzip -t "$DB_FILE" 2>/dev/null || die "$(sayf "$T_ERR_BAD_GZIP_FMT" "$DB_FILE")"
[[ "$DB_ONLY" -eq 1 ]] || gzip -t "$STORAGE_FILE" 2>/dev/null \
  || die "$(sayf "$T_ERR_BAD_GZIP_FMT" "$STORAGE_FILE")"

# …and that it is OUR dump, in two separate questions, because the two wrong files a person
# actually picks are different mistakes: something that is not a dump at all, and a dump of
# the wrong (or of an empty) database. pg_dump names every table it creates, so the
# schema-version table is a cheap, unambiguous fingerprint for the second.
#
# ⚠️ Read into a variable rather than piped straight into `grep -q`: grep exits at the first
# match, head takes SIGPIPE, and `set -o pipefail` then reports the pipeline as FAILED — so
# finding the fingerprint was what made the check say the fingerprint was missing.
dump_head="$(gunzip -c "$DB_FILE" 2>/dev/null | head -n 20000 || true)"
printf '%s' "$dump_head" | grep -q 'PostgreSQL database dump' \
  || die "$(sayf "$T_ERR_NOT_A_DUMP_FMT" "$DB_FILE")"
printf '%s' "$dump_head" | grep -q 'alembic_version' \
  || die "$(sayf "$T_ERR_EMPTY_DUMP_FMT" "$DB_FILE" "$DB_FILE" "$PGUSER_" "$PGDB_")"
unset dump_head

db_size="$(du -h "$DB_FILE" | cut -f1)"
db_when="$(date -r "$DB_FILE" '+%Y-%m-%d %H:%M' 2>/dev/null || echo 'unknown date')"
if [[ "$DB_ONLY" -eq 1 ]]; then
  info "$(sayf "$T_FILES_DB_ONLY_FMT" "$DB_FILE" "$db_size" "$db_when")"
  ok "$T_INTEGRITY_OK_DB"
  warn "$T_WARN_DB_ONLY"
  ARCHIVE_FILES="?"
else
  # ⚠️ THE TARBALL IS VERIFIED HERE, BEFORE ANYTHING IS DESTROYED. The restore step below runs
  # `find /data/storage -mindepth 1 -delete && tar xzf -`: the volume is emptied FIRST, so a
  # tarball that turns out not to be one leaves the station with a replaced database and no
  # media at all — photos, Sprachnotizen, Objektpläne, gone, in the middle of the recovery that
  # was supposed to bring them back. The dump half has had a content fingerprint all along
  # (above); this half had only `gzip -t`, and the file count that follows ends in `|| true`,
  # so a failing `tar tzf` printed «0 Dateien» and the script still said «beide Dateien sind
  # intakt» — the two states an operator most needs told apart, reported identically.
  tar tzf "$STORAGE_FILE" >/dev/null 2>&1 \
    || die "$(sayf "$T_ERR_NOT_A_TAR_FMT" "$STORAGE_FILE")"
  ARCHIVE_FILES="$(tar tzf "$STORAGE_FILE" 2>/dev/null | grep -cv '/$' || true)"
  info "$(sayf "$T_FILES_FMT" "$DB_FILE" "$db_size" "$db_when" \
        "$STORAGE_FILE" "$(du -h "$STORAGE_FILE" | cut -f1)" "$ARCHIVE_FILES")"
  ok "$T_INTEGRITY_OK"
fi

# ─── 2. what it replaces ──────────────────────────────────────────────────────────────────

step "$T_STEP_TARGET"

# The db service has to be up to be restored into; the app must NOT be, but that is §4's job.
#
# ⚠️ Remember whether WE started it, so a --dry-run can put the host back. A read-only check
# that leaves a database container running on a deliberately stopped stack is a surprising
# thing for a recovery tool to do to a machine somebody is in the middle of triaging.
DB_WAS_STARTED_BY_US=0
if [[ -z "$(compose ps -q db 2>/dev/null)" ]]; then
  DB_WAS_STARTED_BY_US=1
  compose up -d db </dev/null >/dev/null 2>&1 || true
  # Give the container its healthcheck's worth of time before deciding it will not come.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -z "$(compose ps -q db 2>/dev/null)" ]] || break
    sleep 2
  done
  [[ -n "$(compose ps -q db 2>/dev/null)" ]] || die "$T_ERR_NO_DB_SERVICE"
fi

# psql_scalar SQL — one value out of the live database, or "" if it cannot be read.
# ⚠️ Every docker call here reads from /dev/null. Without it `compose run`/`exec` attach the
# terminal's stdin and eat whatever is sitting in it — including, on a slow terminal, the word
# the operator is about to type at the confirmation prompt below.
psql_scalar() {
  compose exec -T db psql -U "$PGUSER_" -d "$PGDB_" -At -c "$1" </dev/null 2>/dev/null | head -1 || true
}

CUR_INCIDENTS="$(psql_scalar 'select count(*) from incidents')"
CUR_USERS="$(psql_scalar 'select count(*) from users')"
CUR_MEDIA="$(psql_scalar 'select count(*) from media')"
CUR_FILES="$(compose run --rm --no-deps -T app sh -c 'find /data/storage -type f | wc -l' </dev/null 2>/dev/null | tr -d ' \r' || true)"
CUR_BYTES="$(compose run --rm --no-deps -T app sh -c 'du -sh /data/storage 2>/dev/null | cut -f1' </dev/null 2>/dev/null | tr -d ' \r' || true)"

if [[ -z "$CUR_INCIDENTS" && -z "$CUR_USERS" ]]; then
  warn "$T_TARGET_UNREADABLE"
  info "$(sayf "$T_TARGET_FMT" "$PROJECT" "$PGDB_" "$PGUSER_" "?" "?" "?" "${CUR_FILES:-?}" "${CUR_BYTES:-?}")"
else
  info "$(sayf "$T_TARGET_FMT" "$PROJECT" "$PGDB_" "$PGUSER_" \
        "${CUR_INCIDENTS:-?}" "${CUR_USERS:-?}" "${CUR_MEDIA:-?}" "${CUR_FILES:-?}" "${CUR_BYTES:-?}")"
  if [[ "${CUR_INCIDENTS:-0}" == "0" && "${CUR_USERS:-0}" == "0" && "${CUR_FILES:-0}" == "0" ]]; then
    info "$T_TARGET_EMPTY"
  fi
fi

SAFETY_DIR="$(dirname "$DB_FILE")/pre-restore-$(date +%F-%H%M%S)"

# ─── 3. confirm ───────────────────────────────────────────────────────────────────────────

step "$T_STEP_CONFIRM"
if [[ "$DB_ONLY" -eq 1 ]]; then
  say "$(sayf "$T_DESTROY_DB_ONLY" "$SAFETY_DIR")"
else
  say "$(sayf "$T_DESTROY" "$SAFETY_DIR")"
fi
say ""
warn "$(sayf "$T_SECRET_KEY_WARN" "$ENV_FILE")"

if [[ "$DRY_RUN" -eq 1 ]]; then
  # Put the host back the way it was found. Only the container THIS run started, and only on
  # the dry run — the real restore needs `db` up and leaves the stack running on purpose.
  if [[ "$DB_WAS_STARTED_BY_US" -eq 1 ]]; then
    compose stop db </dev/null >/dev/null 2>&1 || true
    info "$T_DRY_RUN_DB_STOPPED"
  fi
  say ""
  ok "$T_DRY_RUN"
  exit 0
fi

if [[ "$ASSUME_YES" -eq 0 ]]; then
  # A typed word, not [y/N]. This is the one command in the repository that deletes a station's
  # incident record, and the difference between the reflex and the decision is worth one word.
  [[ -t 0 ]] || die "No terminal to confirm on. Re-run with --yes if you are certain."
  printf '\n%s%s%s: ' "$C_B" "$T_CONFIRM_PROMPT" "$C_0"
  IFS= read -r reply || reply=""
  [[ "$reply" == "restore" ]] || die "$T_ABORTED"
fi

# ─── 4. restore ───────────────────────────────────────────────────────────────────────────

step "$T_STEP_RESTORE"

# The safety copy, and it comes BEFORE the app is stopped — the storage half of a backup is
# read out of the app container, so a stack stopped first is a safety copy with no storage in
# it. (backup.sh falls back to a one-off container when the app is genuinely down; this order
# is what makes the ordinary case ordinary.)
#
# Best effort by design: on the day this script is for, the thing being replaced is often too
# broken to dump, and refusing to restore because the wreck cannot be backed up would be the
# wrong answer.
say "$(sayf "$T_R_SAFETY_FMT" "$SAFETY_DIR")"
mkdir -p "$SAFETY_DIR"
chmod 700 "$SAFETY_DIR" 2>/dev/null || true
# ⚠️ KP_ENV_FILE, or the safety copy is taken from the WRONG DEPLOYMENT. backup.sh cd's to the
# repo root and used to read `./.env` and call bare `docker compose` regardless of what this
# restore was pointed at — so with `--env-file`, the copy that is supposed to be the way back
# came from a different stack, and said «✓» while doing it.
# Absolute, because backup.sh cd's to the repo root before it reads anything — a relative
# `--env-file ../other/.env` would resolve against a different directory there. The default
# stays the literal ".env" so the ordinary run is unchanged.
safety_env="$ENV_FILE"
[[ "$safety_env" == ".env" ]] || safety_env="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
if ! safety_out="$(BACKUP_KEEP=99 KP_ENV_FILE="$safety_env" "$KP_SCRIPT_DIR/backup.sh" "$SAFETY_DIR" 2>&1)"; then
  printf '%s\n' "$safety_out" | tail -10 >&2
  warn "$T_R_SAFETY_FAIL"
fi

say "$T_R_STOP"
compose stop app </dev/null >/dev/null 2>&1 || true

say "$T_R_DB"
# DROP SCHEMA rather than DROP DATABASE: it needs no second database to connect through, no
# disconnect dance, and it works the same against a managed Postgres. ON_ERROR_STOP is what
# makes this a restore instead of a mess — psql's default is to print the error, carry on to
# the next statement and exit 0, which is how a "successful" restore ends up half-applied.
if ! restore_out="$(compose exec -T db psql -U "$PGUSER_" -d "$PGDB_" -v ON_ERROR_STOP=1 -q \
      -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION \"$PGUSER_\";" </dev/null 2>&1)"; then
  printf '%s\n' "$restore_out" | tail -20 >&2
  die "$T_R_DB_FAIL"
fi
if ! restore_out="$(gunzip -c "$DB_FILE" | compose exec -T db psql -U "$PGUSER_" -d "$PGDB_" \
      -v ON_ERROR_STOP=1 -q 2>&1)"; then
  printf '%s\n' "$restore_out" | tail -20 >&2
  die "$T_R_DB_FAIL"
fi

if [[ "$DB_ONLY" -eq 0 ]]; then
  say "$T_R_STORAGE"
  # Emptied first: leftovers from the state being replaced are blobs no row points at, and
  # they would quietly count against the disk for the rest of the deployment's life.
  # `run --rm --no-deps` because the app service is stopped — this needs the volume, not a
  # running app.
  if ! storage_out="$(compose run --rm --no-deps -T app \
        sh -c 'find /data/storage -mindepth 1 -delete && tar xzf - -C /data/storage' \
        < "$STORAGE_FILE" 2>&1)"; then
    printf '%s\n' "$storage_out" | tail -20 >&2
    die "$T_R_STORAGE_FAIL"
  fi
fi

say "$T_R_START"
compose up -d </dev/null >/dev/null 2>&1 || true

# ─── 5. verify ────────────────────────────────────────────────────────────────────────────
#
# Nothing here is decoration. A restore that reports success without counting rows and files
# is a restore you find out about later.

step "$T_STEP_VERIFY"

NEW_INCIDENTS="$(psql_scalar 'select count(*) from incidents')"
NEW_USERS="$(psql_scalar 'select count(*) from users')"
NEW_MEDIA="$(psql_scalar 'select count(*) from media')"
NEW_REV="$(psql_scalar 'select version_num from alembic_version')"
ok "$(sayf "$T_V_TABLES_FMT" "${NEW_INCIDENTS:-?}" "${NEW_USERS:-?}" "${NEW_MEDIA:-?}" "${NEW_REV:-?}")"

if [[ "$DB_ONLY" -eq 0 ]]; then
  NEW_FILES="$(compose exec -T app sh -c 'find /data/storage -type f | wc -l' </dev/null 2>/dev/null | tr -d ' \r' || true)"
  ok "$(sayf "$T_V_STORAGE_FMT" "${NEW_FILES:-?}")"
fi

READY_URL="http://127.0.0.1:${PORT}/ready"
SECONDS=0
while ((SECONDS < TIMEOUT)); do
  probe_ready "$READY_URL" && break
  sleep 2
done
if probe_ready "$READY_URL"; then
  ok "$(sayf "$T_V_READY_FMT" "$SECONDS")"
  accounts="$(roster_count "$PORT")"
  ok "$(sayf "$T_V_ROSTER_FMT" "$accounts")"
else
  warn "$T_V_NOT_READY"
fi

say ""
say "$T_DONE"

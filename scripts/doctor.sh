#!/usr/bin/env bash
# KP Front — "something is wrong". One command, read-only, any day of the year.
#
#   ./scripts/doctor.sh                 # look at this deployment and say what is wrong
#   ./scripts/doctor.sh --env-file /path/to/.env
#
# It changes NOTHING. It starts no container, writes no file, touches no crontab — it looks,
# and it prints the command that fixes what it found.
#
# Why it exists: scripts/setup.sh already knew how to recognise a port collision, a restart
# loop, an unwritable volume, a dead database and a login screen with nobody on it — and to
# name the fix for each. That knowledge existed only on install day, because it lived inside
# the installer. The recognition is scripts/lib.sh now; this is the door to it on day 200.
#
# ⚠️ It runs on the host, on purpose, and there is no browser equivalent. The moment you most
# need it is the moment the app serves no page: a restart loop, a failed migration, a full
# disk. A diagnosis that lives inside the thing being diagnosed is not a diagnosis.
set -euo pipefail

KP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$KP_SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib.sh
. "$KP_SCRIPT_DIR/lib.sh"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ─── OPERATOR-FACING STRINGS ──────────────────────────────────────────────────────────────
# The prerequisite and diagnosis strings are in scripts/lib.sh — same block, same convention.
# ══════════════════════════════════════════════════════════════════════════════════════════

T_USAGE="KP Front — check a deployment and say what is wrong.

Usage: scripts/doctor.sh [options]

Read-only: it starts nothing, writes nothing, and is safe to run during an incident.

  --env-file <path> Read this instead of ./.env.
  -h, --help        This text."

T_TITLE="KP Front — checking this deployment"
T_STEP_HOST="The host"
T_STEP_STACK="The stack"
T_STEP_APP="The app"
T_STEP_BACKUPS="Backups"
T_STEP_VERDICT="Verdict"

T_ERR_NO_ENV_FMT="No %s in %s — so there is no KP Front deployment here to check.
  If this is the right machine, you are in the wrong directory: run this from the checkout
  you installed from. If it is the right directory, nothing was ever installed:
      ./scripts/setup.sh"
T_ENV_FMT="Configuration: %s (APP_PORT=%s)"
T_APP_URL_FMT="Checking http://127.0.0.1:%s/ready"
T_OK_READY_FMT="/ready is green: the database is reachable and the storage volume is writable."
T_OK_ROSTER_FMT="The login screen offers %s account(s)."
T_WARN_ROSTER_UNKNOWN="Could not read the roster (no curl or wget on this host), so whether
  anybody can log in is unverified. Check it from a browser."
T_WARN_NO_ACCOUNTS="⚠️ /ready is green and the login screen has NOBODY on it — the failure
  that looks most like success."
T_DISK_FMT="Storage volume: %s"
T_DISK_FULL_FMT="⚠️ The storage volume is %s full. Uploads, PDFs and the pre-migration dumps
  all live there, and a full volume flips /ready to 503 without restarting anything.
  What is using it:  docker compose exec app du -sh /data/storage/*"
T_DISK_UNKNOWN="Could not read the storage volume's disk usage (the app container is not
  running), which is itself part of the answer above."
T_CRON_OK_FMT="A backup schedule is installed:
    %s"
T_CRON_MISSING="⚠️ NO backup schedule is installed for this user. Nothing else backs this
  station up — the automatic pre-migration dumps live on the volume they would have to
  survive. Install the nightly one:
      ./scripts/setup.sh --backup-cron"
T_CRON_NO_CRONTAB="No 'crontab' command on this host, so whether backups are scheduled is not
  something this script can answer. Check whatever this system schedules with."
T_BACKUPS_FMT="Newest backup: %s (%s), %s kept in %s"
T_BACKUPS_NONE_FMT="⚠️ No backup files in %s. A schedule that has never produced a file is not
  a backup. Take one now and watch it work:  ./scripts/backup.sh"
T_BACKUPS_STALE_FMT="⚠️ The newest backup in %s is %s days old. The schedule is installed but
  something is stopping it — look at %s/backup.log."
T_BACKUPS_NO_DIR_FMT="⚠️ The backup directory %s does not exist. Nothing has ever been written
  there, or the disk it lived on is not mounted. Take one now and watch it work:
    ./scripts/backup.sh %s"
T_VERDICT_OK="Nothing wrong found. The stack is up, /ready is green, and somebody can log in.
  (That is health, not readiness — docs/SETUP.md §8 is the list that decides whether you can
  rely on it in the field.)"
T_VERDICT_WARN="The app is answering, but read the warnings above before you rely on it."
T_VERDICT_BAD="Something is wrong. The diagnosis is above; nothing here changed anything."

# ══════════════════════════════════════════════════════════════════════════════════════════

ENV_FILE="${KP_ENV_FILE:-}"
TIMEOUT=5          # kp_diagnose prints this; nothing here waits for a slow boot
UP_LOG=""          # there is no `compose up` log on this path — the guard in kp_diagnose knows

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) [[ $# -ge 2 && "$2" != -* ]] || die "--env-file needs a path after it."
                ENV_FILE="$2"; shift 2 ;;
    -h|--help)  say "$T_USAGE"; exit 0 ;;
    *)          say "$T_USAGE" >&2; die "unknown option: $1" ;;
  esac
done

cd "$REPO_ROOT"
[[ -n "$ENV_FILE" ]] || ENV_FILE=".env"

printf '\n%s%s%s\n' "$C_B" "$T_TITLE" "$C_0"

# ─── the host ─────────────────────────────────────────────────────────────────────────────

step "$T_STEP_HOST"
PREFLIGHT_OK=1
preflight || PREFLIGHT_OK=0

if [[ ! -e "$ENV_FILE" ]]; then
  say ""
  die "$(sayf "$T_ERR_NO_ENV_FMT" "$ENV_FILE" "$REPO_ROOT")"
fi
[[ "$ENV_FILE" == ".env" ]] || COMPOSE_ARGS+=(--env-file "$ENV_FILE")
PORT="$(kp_env_value APP_PORT 8000 "$ENV_FILE")"
info "$(sayf "$T_ENV_FMT" "$ENV_FILE" "$PORT")"

[[ "$PREFLIGHT_OK" -eq 1 ]] || { say ""; say "$T_DIAG_FOOTER"; exit 1; }

# ─── the stack ────────────────────────────────────────────────────────────────────────────

step "$T_STEP_STACK"
compose ps 2>/dev/null || true

# ─── the app ──────────────────────────────────────────────────────────────────────────────

step "$T_STEP_APP"
info "$(sayf "$T_APP_URL_FMT" "$PORT")"

PROBLEMS=0
WARNINGS=0
READY_RC=0
probe_ready "http://127.0.0.1:${PORT}/ready" || READY_RC=$?

if [[ "$READY_RC" -eq 0 ]]; then
  ok "$T_OK_READY_FMT"
  # /ready cannot see the login screen. This is the v0.6.0 failure: green everywhere and an
  # empty roster, the one shape nothing else in the product notices.
  accounts="$(roster_count "$PORT")"
  case "$accounts" in
    0)  warn "$T_WARN_NO_ACCOUNTS"
        say ""
        sayf "$T_DIAG_NO_ACCOUNTS_FMT" "$ENV_FILE"
        PROBLEMS=$((PROBLEMS + 1)) ;;
    # Quoted, because a bare ? in a case pattern is a glob and would swallow every
    # single-digit account count — «3 accounts» read as «could not tell».
    '?'|"") warn "$T_WARN_ROSTER_UNKNOWN"; WARNINGS=$((WARNINGS + 1)) ;;
    *)  ok "$(sayf "$T_OK_ROSTER_FMT" "$accounts")" ;;
  esac
else
  PROBLEMS=$((PROBLEMS + 1))
  if [[ "$READY_RC" -eq 1 ]]; then kp_diagnose "notready"; else kp_diagnose "noanswer"; fi
fi

# Disk, which nothing in the product watches: SystemView draws a bar and the backend has no
# threshold anywhere. A full volume is a 503 that restarts nothing.
disk_line=""
disk_line="$(compose exec -T app df -h /data/storage </dev/null 2>/dev/null | tail -1 || true)"
if [[ -n "$disk_line" ]]; then
  used_pct="$(printf '%s' "$disk_line" | awk '{print $5}' | tr -d '%')"
  info "$(sayf "$T_DISK_FMT" "$(printf '%s' "$disk_line" | awk '{print $3" used of "$2" ("$5")"}')")"
  if [[ "$used_pct" =~ ^[0-9]+$ ]] && ((used_pct >= 85)); then
    warn "$(sayf "$T_DISK_FULL_FMT" "${used_pct}%")"
    WARNINGS=$((WARNINGS + 1))
  fi
else
  info "$T_DISK_UNKNOWN"
fi

# ─── backups ──────────────────────────────────────────────────────────────────────────────
#
# Not health, but the question a station cannot answer from any screen: is anything actually
# being backed up? /admin has no idea, and «Einrichtung» does not check it either.

step "$T_STEP_BACKUPS"
if ! command -v "${KP_CRONTAB:-crontab}" >/dev/null 2>&1; then
  info "$T_CRON_NO_CRONTAB"
else
  # ⚠️ `grep -v '^[[:space:]]*#'` FIRST. Commenting the line out is how everybody disables a
  # cron job, and matching it anyway made this screen report a schedule that cannot run — while
  # `setup.sh --backup-cron` refused to add a real one because it also thought one was there.
  # The one screen that answers «are my backups working» said yes to a switched-off backup.
  cron_line="$(kp_crontab -l 2>/dev/null | grep -v '^[[:space:]]*#' | grep 'scripts/backup\.sh' | tail -1 || true)"
  if [[ -n "$cron_line" ]]; then
    ok "$(sayf "$T_CRON_OK_FMT" "$cron_line")"
    # Where that line writes, so "installed" can be checked against "produced a file".
    backup_dir="$(printf '%s' "$cron_line" | sed -n 's|.*backup\.sh \([^ ]*\).*|\1|p')"
  else
    warn "$T_CRON_MISSING"
    WARNINGS=$((WARNINGS + 1))
    backup_dir=""
  fi
  [[ -n "${backup_dir:-}" ]] || backup_dir="$REPO_ROOT/backups"
  if [[ -d "$backup_dir" ]]; then
    # shellcheck disable=SC2012  # the names are ours: db-<stamp>.sql.gz, ASCII by construction
    newest="$(ls -1t "$backup_dir"/db-*.sql.gz 2>/dev/null | head -1 || true)"
    if [[ -n "$newest" ]]; then
      # shellcheck disable=SC2012
      kept="$(ls -1 "$backup_dir"/db-*.sql.gz 2>/dev/null | wc -l | tr -d ' ')"
      age_days=$(( ( $(date +%s) - $(date -r "$newest" +%s 2>/dev/null || echo 0) ) / 86400 ))
      info "$(sayf "$T_BACKUPS_FMT" "$(basename "$newest")" "$(du -h "$newest" | cut -f1)" "$kept" "$backup_dir")"
      if ((age_days > 2)); then
        warn "$(sayf "$T_BACKUPS_STALE_FMT" "$backup_dir" "$age_days" "$backup_dir")"
        WARNINGS=$((WARNINGS + 1))
      fi
    else
      warn "$(sayf "$T_BACKUPS_NONE_FMT" "$backup_dir")"
      WARNINGS=$((WARNINGS + 1))
    fi
  else
    # ⚠️ The `else` this `if` did not have. A cron line pointing at a directory that no longer
    # exists — renamed, on an unmounted disk, never created — skipped the freshness check
    # entirely and the run ended «Nichts gefunden, was nicht stimmt». A missing backup
    # directory is the loudest possible answer to the question this section asks, not silence.
    warn "$(sayf "$T_BACKUPS_NO_DIR_FMT" "$backup_dir" "$backup_dir")"
    WARNINGS=$((WARNINGS + 1))
  fi
fi

# ─── verdict ──────────────────────────────────────────────────────────────────────────────

step "$T_STEP_VERDICT"
if ((PROBLEMS > 0)); then
  say "$T_VERDICT_BAD"
  exit 1
elif ((WARNINGS > 0)); then
  say "$T_VERDICT_WARN"
  exit 0
fi
ok "$T_VERDICT_OK"

#!/usr/bin/env bash
# Shared shell library for the operator-facing scripts in this directory.
#
#   scripts/setup.sh     the guided install
#   scripts/doctor.sh    "something is wrong" — the same diagnosis, any day, not just install day
#   scripts/restore.sh   the worst day
#   scripts/backup.sh    reads .env the same way everything else does
#
# It is SOURCED, never run. Nothing here has a side effect at source time beyond defining
# functions and the strings block, so a script can source it and then decide what to use.
#
# Why it exists: `setup.sh` grew a diagnose() that recognises a port collision, a restart loop,
# an unwritable volume, a dead database and an empty roster — and names the command that fixes
# each. That quality used to exist only on install day, because it lived inside the installer.
# It is here now so `doctor.sh` is a caller rather than a copy: one implementation, one place to
# fix a wrong hint.
#
# ⚠️ Callers set the globals the diagnosis reads — PORT, ENV_FILE, TIMEOUT, UP_LOG — before
# calling kp_diagnose. They are named as globals rather than passed as arguments because the
# same four are also what every other function here works on.
# shellcheck shell=bash

# ══════════════════════════════════════════════════════════════════════════════════════════
# ─── OPERATOR-FACING STRINGS ──────────────────────────────────────────────────────────────
# Same convention as setup.sh: everything the operator reads lives in one block, so switching
# the scripts to German is a contained edit. `_FMT` names are printf format strings (their
# %s/%d order is part of the string — keep it when translating).
# ══════════════════════════════════════════════════════════════════════════════════════════

# --- prerequisites ---
T_OK_DOCKER_FMT="docker %s"
T_OK_COMPOSE_FMT="docker compose %s"
T_OK_DAEMON="docker daemon is running"
T_ERR_NO_DOCKER="docker is not installed.
  Install it:  curl -fsSL https://get.docker.com | sudo sh
  (or follow https://docs.docker.com/engine/install/ for your distribution)"
T_ERR_NO_COMPOSE="the Compose v2 plugin is missing — 'docker compose' is not a command.
  The old standalone 'docker-compose' does not work here; this stack needs v2.
  Install it:  sudo apt-get install docker-compose-plugin
  (or reinstall Docker with https://get.docker.com, which includes it)"
T_ERR_NO_DAEMON="the docker daemon is not running.
  Start it:  sudo systemctl start docker && sudo systemctl enable docker"
T_ERR_NO_PERM="this user is not allowed to talk to the docker daemon.
  Fix it:  sudo usermod -aG docker \$USER
  Then log out and back in (the group only applies to a new session), and re-run this."

# --- diagnosis ---
T_DIAG_HEADER="That did not work. Here is what it is, not a stack trace:"
T_DIAG_PORT_FMT="Port %s is already allocated — something else on this host owns it.
  Nothing is broken and nothing was lost: %s is written and its secrets are good, so do NOT
  start over. Port %s is free. Point this deployment at it and start again:
      sed -i 's|^APP_PORT=.*|APP_PORT=%s|' %s && docker compose up -d
  Or find out what holds %s first:  ss -tlnp | grep :%s"
T_DIAG_RESTARTLOOP_FMT="The app container is restart-looping (%s restarts). On a first boot
  that is almost always SEED_PIN: the app refuses to seed the bundled seed file's public PIN
  in production, exits, and 'restart: unless-stopped' starts it again forever.
  Check the value in %s — it must be six digits and not an obvious one.
  Read the actual reason:  docker compose logs app | tail -30"
T_DIAG_SEEDPIN="The logs name SEED_PIN. That is the whole problem: set a six-digit SEED_PIN
  (not 000000/123456/…) in %s and run 'docker compose up -d' again."
T_DIAG_STORAGE="/ready says the storage volume is not writable. The container cannot write to
  /data/storage, so uploads and PDFs would fail — it reports itself unhealthy instead.
  Usually volume ownership, sometimes simply a full disk (check the storage line above). Try:
      docker compose down
      docker volume inspect kp-front_storage        # find its Mountpoint
      sudo chown -R 1000:1000 <that mountpoint>
      docker compose up -d
  On Railway this is a different beast: set RAILWAY_RUN_UID=0 on the service."
T_DIAG_DATABASE="/ready says the database is unreachable. The db container is usually still
  starting, or POSTGRES_PASSWORD was changed after the volume was first created (the volume
  keeps the ORIGINAL password).
  Look:  docker compose logs db | tail -30"
# shellcheck disable=SC2034  # printed by setup.sh, which sources this file
T_DIAG_NO_ACCOUNTS_FMT="The stack is up and /ready is green — and the login screen has NOBODY
on it, so nobody can get in. Seeding was refused; this image logs that and carries on instead
of stopping, which is why nothing else complained.
  Almost always SEED_PIN in %s. It must be exactly six digits and not one of the
  well-known ones (000000, 012345, 111111, 123456, 654321, 999999).
  Confirm:  docker compose logs app | grep -i seed
  Then fix the value and re-seed:  docker compose up -d --force-recreate app"
T_DIAG_TIMEOUT_FMT="The app never answered within %ds, and the container is not obviously
  broken. It may simply still be pulling or migrating on a slow link.
  Watch it live:  docker compose logs -f app"
T_DIAG_NO_CONTAINER="There is no app container in this compose project at all — nothing was
  ever started here, or 'docker compose down' removed it. Nothing is lost: the database and
  the uploads live in named volumes that a plain 'down' does not touch.
  Start it:  docker compose up -d"
T_DIAG_STOPPED_FMT="The app container exists but is not running (%s). Nothing crashed and
  nothing is restart-looping — it was stopped, by a person, an update or a reboot this host
  never came back from.
  Start it:  docker compose up -d
  If it stopped by itself, the reason is the last thing in its log:
      docker compose logs app | tail -30"
T_DIAG_LOGS="Last lines from the app container:"
T_DIAG_FOOTER="Full logs:  docker compose logs app
Nothing here is destructive to re-run: fix the cause and run 'docker compose up -d' again."

# ══════════════════════════════════════════════════════════════════════════════════════════
# ─── end of operator-facing strings ───────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════════════════════

if [[ -t 1 ]]; then
  C_B=$'\033[1m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'
  C_ERR=$'\033[1;31m'; C_0=$'\033[0m'
else
  C_B=""; C_OK=""; C_WARN=""; C_ERR=""; C_0=""
fi

say()  { printf '%s\n' "$*"; }
# shellcheck disable=SC2059  # the format string is the point — see the strings block
sayf() { local f="$1"; shift; printf "$f\n" "$@"; }
step() { printf '\n%s── %s %s\n' "$C_B" "$1" "$C_0"; }
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_0" "$1"; }
info() { printf '  %s\n' "$1"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_0" "$1" >&2; }
die()  { printf '%s✗%s %s\n' "$C_ERR" "$C_0" "$1" >&2; exit 1; }

# ─── reading .env ─────────────────────────────────────────────────────────────────────────

# kp_env_value KEY FALLBACK [FILE] — one value out of an env file, without sourcing it.
#
# ⚠️ Never `. .env`: it holds passwords and URLs, and a `$` or a backtick in one of them would
# be handed to the shell. And never trust the calling shell either — under cron the environment
# is all but empty, so a station that changed POSTGRES_USER in .env must still be read
# correctly at 03:30, into a log nobody reads.
kp_env_value() {
  local key="$1" fallback="$2" file="${3:-.env}" value
  value="$(sed -n "s/^[[:space:]]*$key=//p" "$file" 2>/dev/null | tr -d '\r' | tail -n1)" || true
  value="${value%\"}"; value="${value#\"}"        # tolerate KEY="value"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "${value:-$fallback}"
}

# ─── docker / compose ─────────────────────────────────────────────────────────────────────

# COMPOSE_ARGS carries --env-file / --profile. The ${…+…} guard is for `set -u`: an empty
# array is not "unset" to bash 4.4+, but it is to older ones, and this runs on strange hosts.
COMPOSE_ARGS=()
compose() { docker compose ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} "$@"; }
# ⚠️ `ps -aq`, not `ps -q`: without -a compose lists only RUNNING containers, so a stopped app
# looked exactly like a project that had never been started, and the diagnosis below picked the
# wrong sentence for the single most ordinary failure there is.
app_cid() { compose ps -aq app 2>/dev/null | head -1 || true; }
container_health() {
  local cid; cid="$(app_cid)"
  [[ -n "$cid" ]] || { printf '\n'; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || printf '\n'
}
container_state() {
  local cid; cid="$(app_cid)"
  [[ -n "$cid" ]] || { printf '\n'; return; }
  docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$cid" 2>/dev/null || printf '\n'
}

# preflight — docker, compose v2, a reachable daemon. Prints what it found, 1 if unusable.
preflight() {
  local out
  command -v docker >/dev/null 2>&1 || { warn "$T_ERR_NO_DOCKER"; return 1; }
  ok "$(sayf "$T_OK_DOCKER_FMT" "$(docker --version 2>/dev/null | sed 's/^Docker version //')")"

  if ! out="$(docker compose version --short 2>/dev/null)"; then
    warn "$T_ERR_NO_COMPOSE"; return 1
  fi
  ok "$(sayf "$T_OK_COMPOSE_FMT" "$out")"

  if ! out="$(docker info 2>&1 >/dev/null)"; then
    if printf '%s' "$out" | grep -qi 'permission denied'; then
      warn "$T_ERR_NO_PERM"
    else
      warn "$T_ERR_NO_DAEMON"
    fi
    return 1
  fi
  ok "$T_OK_DAEMON"
  return 0
}

# ─── probes ───────────────────────────────────────────────────────────────────────────────

# port_in_use PORT — 0 if something is listening on it. Tries the tools a host might have,
# and falls back to an actual TCP connect, so this never silently answers "free" for lack of ss.
port_in_use() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$"; then return 0; fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
  elif command -v netstat >/dev/null 2>&1; then
    if netstat -an 2>/dev/null | awk '/^tcp/ && /[Ll][Ii][Ss][Tt][Ee][Nn]/ {print $4}' \
        | grep -qE "[:.]${p}\$"; then return 0; fi
  fi
  # Last resort, and a second opinion: can we actually connect to it?
  if (exec 3<>"/dev/tcp/127.0.0.1/${p}") >/dev/null 2>&1; then return 0; fi
  return 1
}

# first_free_port START [EXCLUDE] — a free port to propose: the round numbers people
# recognise first, then anything above START. EXCLUDE is never proposed, which matters when
# the caller is reacting to START having just failed to bind (docker knows things `ss` does not).
first_free_port() {
  local start="$1" exclude="${2-}" p
  for p in "$start" 8000 8100 8200 8300 8400 8500 8080 8090; do
    if [[ "$p" == "$exclude" ]]; then continue; fi
    port_in_use "$p" || { printf '%s\n' "$p"; return 0; }
  done
  for ((p = start + 1; p < start + 200; p++)); do
    if [[ "$p" == "$exclude" ]]; then continue; fi
    port_in_use "$p" || { printf '%s\n' "$p"; return 0; }
  done
  return 1
}

# probe_ready URL — 0 ready, 1 answered but not ready (body in READY_BODY), 2 no answer.
READY_BODY=""
probe_ready() {
  local url="$1" out code
  if command -v curl >/dev/null 2>&1; then
    out="$(curl -sS -m 5 -w '\n%{http_code}' "$url" 2>/dev/null)" || return 2
    code="${out##*$'\n'}"
    READY_BODY="${out%$'\n'*}"
    [[ "$code" == "200" ]] && return 0
    [[ -n "$code" ]] && return 1
    return 2
  fi
  if command -v wget >/dev/null 2>&1; then
    READY_BODY="$(wget -q -T 5 -O - "$url" 2>/dev/null)" && return 0
    READY_BODY=""
    return 2
  fi
  # No HTTP client: fall back to the container's own healthcheck, which probes /ready anyway.
  case "$(container_health)" in
    healthy) return 0 ;;
    "")      return 2 ;;
    *)       return 1 ;;
  esac
}

# roster_count PORT — how many accounts the login screen would show, or "?" if we cannot tell.
#
# ⚠️ This is the one thing /ready cannot answer, and it is the failure the published 0.6.0
# image actually produces: seeding runs inside a try/except there, so a SEED_PIN the backend
# refuses is logged as "Seeding failed (continuing)" and the deployment comes up GREEN with an
# empty roster. Newer images refuse to boot instead — that shape is the restart loop, caught
# below. An installer that does not check this reports success on a station nobody can log in to.
roster_count() {
  local url="http://127.0.0.1:${1}/api/auth/roster" body=""
  if command -v curl >/dev/null 2>&1; then
    body="$(curl -sS -m 5 "$url" 2>/dev/null)" || { printf '?\n'; return; }
  elif command -v wget >/dev/null 2>&1; then
    body="$(wget -q -T 5 -O - "$url" 2>/dev/null)" || { printf '?\n'; return; }
  else
    printf '?\n'; return
  fi
  case "$body" in
    "[]")  printf '0\n' ;;
    '['*)  printf '%s\n' "$(printf '%s' "$body" | grep -o '"id"' | wc -l | tr -d ' ')" ;;
    *)     printf '?\n' ;;
  esac
}

# ─── the diagnosis ────────────────────────────────────────────────────────────────────────

# kp_diagnose REASON — name the failure and the command that fixes it. REASON is one of
# `up` (compose itself failed), `notready` (it answered, but not with 200) or anything else
# (nothing answered at all).
#
# Reads the globals PORT, ENV_FILE, TIMEOUT, UP_LOG (compose's output, may be empty or unset)
# and READY_BODY (set by probe_ready). Prints and RETURNS — the caller decides the exit code,
# because `doctor.sh` has more to say afterwards and `setup.sh` does not.
kp_diagnose() {
  local reason="${1:-unknown}"
  local port="${PORT:-8000}" env_file="${ENV_FILE:-.env}" timeout="${TIMEOUT:-300}"
  printf '\n%s%s%s\n\n' "$C_ERR" "$T_DIAG_HEADER" "$C_0"

  # ⚠️ The -n guard is not decoration: with UP_LOG empty, `grep pattern ""` reads STDIN and the
  # script hangs waiting for a human who is looking at a frozen screen.
  if [[ -n "${UP_LOG:-}" && -s "${UP_LOG:-}" ]] \
     && grep -qiE 'port is already allocated|address already in use|bind for' "$UP_LOG" 2>/dev/null; then
    local alt
    # Exclude PORT itself: docker just told us it cannot bind it, whatever `ss` believes.
    alt="$(first_free_port "$port" "$port")" || alt="8100"
    sayf "$T_DIAG_PORT_FMT" "$port" "$env_file" "$alt" "$alt" "$env_file" "$port" "$port"
    say ""; say "$T_DIAG_FOOTER"
    return 0
  fi

  local state restarts status
  read -r status restarts <<<"$(container_state)"
  state="${status:-unknown}"

  if [[ "$state" == "restarting" || ( "$state" == "exited" && "${restarts:-0}" -gt 0 ) ]]; then
    sayf "$T_DIAG_RESTARTLOOP_FMT" "${restarts:-?}" "$env_file"
    if compose logs app 2>/dev/null | grep -qi 'SEED_PIN'; then
      say ""
      sayf "$T_DIAG_SEEDPIN" "$env_file"
    fi
  # Stopped is not broken, and telling somebody their stack "may still be pulling" when it has
  # been sitting there stopped since the last reboot sends them to watch a log that never moves.
  elif [[ "$state" == "unknown" ]]; then
    say "$T_DIAG_NO_CONTAINER"
  elif [[ "$state" == "exited" || "$state" == "created" || "$state" == "paused" ]]; then
    sayf "$T_DIAG_STOPPED_FMT" "$state"
  elif [[ "$reason" == "notready" ]]; then
    if printf '%s' "${READY_BODY:-}" | grep -q '"storage"[[:space:]]*:[[:space:]]*"error"'; then
      say "$T_DIAG_STORAGE"
    elif printf '%s' "${READY_BODY:-}" | grep -q '"database"[[:space:]]*:[[:space:]]*"error"'; then
      say "$T_DIAG_DATABASE"
    else
      sayf "$T_DIAG_TIMEOUT_FMT" "$timeout"
    fi
  else
    sayf "$T_DIAG_TIMEOUT_FMT" "$timeout"
  fi

  say ""; say "$T_DIAG_LOGS"
  compose logs --tail 20 app 2>/dev/null || true
  say ""; say "$T_DIAG_FOOTER"
  return 0
}

# ─── the backup schedule ──────────────────────────────────────────────────────────────────
#
# The host's crontab is the only thing these scripts touch outside their own directory, so it
# gets its own small surface: build the line, look for it, never install it without being told.

# kp_cron_path — a PATH that actually finds docker under cron.
#
# ⚠️ This is the single most common reason a backup job turns out never to have run: cron
# starts with a near-empty environment, `docker: command not found` goes into a log nobody
# reads, and the first anyone hears of it is the day they need a backup. The standard list
# covers Debian (/usr/bin) and most others; wherever docker actually is on THIS host is
# prepended, because a snap or a Homebrew install is somewhere else entirely.
kp_cron_path() {
  local base="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" docker_dir=""
  docker_dir="$(command -v docker 2>/dev/null || true)"
  docker_dir="${docker_dir%/*}"
  case ":$base:" in
    *":$docker_dir:"*) ;;
    *) [[ -z "$docker_dir" ]] || base="$docker_dir:$base" ;;
  esac
  printf '%s' "$base"
}

# kp_cron_line REPO_ROOT BACKUP_DIR — the crontab line, exactly as it will be installed.
#
# The PATH is set on the job rather than as a standalone `PATH=` crontab assignment on purpose:
# a bare assignment is global to the file and would silently override — or be overridden by —
# whatever the operator already keeps in there. Prefixing the *script* invocation exports it to
# that one command and to nothing else. (It goes after `cd`, not before: `VAR=x cd y && z` sets
# the variable for the `cd` alone, which is not what anybody reading it assumes.)
#
# COMPOSE_PROJECT_NAME is carried over when the caller is running under one, because that is the
# only thing deciding WHICH stack gets dumped. Cron does not inherit it, so a line without it
# would quietly back up the default project — a different deployment on the same host, or none.
#
# ⚠️ THE PATHS ARE QUOTED WITH %q. They were bare `%s`, while the verification run that follows
# an install quotes the same two values — so a checkout at `/opt/kp front` (or a backup dir with
# a space, an apostrophe, a `$`) passed the check with a ✓ and then failed silently at 03:30
# every night thereafter, into a log file whose own path had just been split in two. The one
# job whose failure is invisible by construction is the one that must not be shell-fragile.
kp_cron_line() {
  local project=""
  [[ -z "${COMPOSE_PROJECT_NAME:-}" ]] || project="COMPOSE_PROJECT_NAME=$(printf '%q' "$COMPOSE_PROJECT_NAME") "
  printf '30 3 * * * cd %q && %sPATH=%s ./scripts/backup.sh %q >> %q/backup.log 2>&1' \
    "$1" "$project" "$(kp_cron_path)" "$2" "$2"
}

# shellcheck disable=SC2034  # read by setup.sh, which sources this file
KP_CRON_MARKER="# KP Front — nightly backup (scripts/setup.sh)"

# kp_crontab ARGS… — the crontab command, overridable for tests. Never let a test write to a
# real human's crontab: KP_CRONTAB=/path/to/stub is how the test suite points this elsewhere.
kp_crontab() { ${KP_CRONTAB:-crontab} "$@"; }

# kp_cron_installed [REPO_ROOT] — 0 if this user's crontab already runs THIS checkout's backup.
#
# ⚠️ Two narrowings, both of which produced a false «already installed»:
#   * commented-out lines are skipped. `#`-ing the line out is how a job gets disabled, and
#     matching it anyway meant `--backup-cron` refused to install a working one because a dead
#     one was there.
#   * the line has to mention THIS repo root when one is given. A host that once ran another
#     checkout of kp-front — a second station, an old clone — reported a green backup schedule
#     for a deployment that has none.
kp_cron_installed() {
  local root="${1:-}" lines
  lines="$(kp_crontab -l 2>/dev/null | grep -v '^[[:space:]]*#' | grep 'scripts/backup\.sh' || true)"
  [[ -n "$lines" ]] || return 1
  [[ -n "$root" ]] || return 0
  printf '%s' "$lines" | grep -qF "$root"
}

#!/usr/bin/env bash
# KP Front — guided first-run installer for a station server.
#
#   ./scripts/setup.sh                       # ask the questions, write .env, start the stack
#   ./scripts/setup.sh --build               # …building from this checkout, not the image
#   ./scripts/setup.sh --yes --lan           # non-interactive (CI / scripted)
#   ./scripts/setup.sh --yes --domain front.example.ch
#   ./scripts/setup.sh --help
#
# Plain bash + docker. It runs on a fresh Debian VPS: `just`, `uv`, `pnpm` and the repo's
# toolchain do NOT exist there and are never required.
#
# It exists because the setup steps a station gets wrong are exactly the ones that need a
# human to reason — SEED_PIN (empty ⇒ restart loop), APP_PORT (collides, error only at
# `up`), COOKIE_SECURE (unset on plain HTTP ⇒ the login cookie is silently dropped),
# tls-profile-or-not, and KP_FRONT_TAG (the tag you checked out is not the image you run).
# Every one of those is decided here from questions the operator can actually answer — plus
# one that is not derived at all, because it changes the host and not this directory: whether
# to install the nightly backup line.
#
# It also mints the Web Push key pair a station should never have to generate by hand INTO THE
# ENCRYPTED CREDENTIAL STORE rather than into .env, so it works out of the box and stays
# changeable from /admin → Zugangsdaten. Webhook secrets are deliberately chosen while the
# external alarm system is connected: they are write-only and pre-generating an unseen value
# would make the intake look configured while nobody could call it.
#
# Nothing here is implemented twice. Two sourced libraries own the shared parts:
#   scripts/init-env.sh   secret generation and .env writing
#   scripts/lib.sh        console output, the docker/compose probes, and the failure
#                         diagnosis — which scripts/doctor.sh calls on any other day
set -euo pipefail

KP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$KP_SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib.sh
. "$KP_SCRIPT_DIR/lib.sh"
# shellcheck source=scripts/init-env.sh
. "$KP_SCRIPT_DIR/init-env.sh"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ─── OPERATOR-FACING STRINGS ──────────────────────────────────────────────────────────────
# Everything the operator reads lives in this one block, so switching the script to German
# is a single contained edit and nothing below has to be touched. `_FMT` names are printf
# format strings (their %s/%d order is part of the string — keep it when translating).
#
# …with one deliberate exception: the prerequisite and diagnosis strings live in the same
# block in scripts/lib.sh, because doctor.sh prints them too and a hint that is right in one
# script and stale in the other is worse than either.
# ══════════════════════════════════════════════════════════════════════════════════════════

T_USAGE="KP Front — guided first-run installer.

Usage: scripts/setup.sh [options]

Interactive by default: it asks for the domain, the port and whether to schedule nightly
backups, decides everything else, writes .env, starts the stack and waits until the app
answers. With no terminal on stdin (piped, cron, CI) it never asks — pass --domain or --lan
instead; piped-in answers are not read, and no backup schedule is installed.

  --domain <name>   Serve on this domain over HTTPS (implies the tls profile).
  --lan             LAN only: plain HTTP, no certificate. Sets COOKIE_SECURE=false.
  --port <n>        Host port for the app (default: 8000, or the next free one).
  --tag <version>   Image version to pin (default: this checkout's release tag, else latest).
  --build           Build the image from this checkout instead of pulling the published one.
  --no-start        Write .env and stop. Nothing is pulled, built or started.
  --timeout <sec>   How long to wait for the app to answer (default: 300).
  --env-file <path> Write somewhere other than ./.env (testing).
  --backup-cron     Install the nightly backup line without asking. Works on its own against
                    an already-installed deployment: ./scripts/setup.sh --backup-cron
  --no-backup-cron  Do not ask about it at all.
  --credentials     Only mint the missing Web Push key pair into an already-installed
                    deployment's credential store, and stop. Anything the station has set
                    itself is left alone.
  --backup-dir <d>  Where the nightly backup writes (default: ./backups).
  -y, --yes         Non-interactive: never prompt. Needs --domain or --lan.
  -h, --help        This text.

Environment: KP_ENV_FILE is the same as --env-file."

T_TITLE="KP Front — first-run setup"
T_STEP_CHECK="Checking prerequisites"
T_STEP_ASK="Three questions"
T_STEP_WRITE="Writing the configuration"
T_STEP_START="Starting the stack"
T_STEP_CREDS="Web Push"
T_STEP_BACKUP="Backups"
T_STEP_DONE="Done"

T_WARN_PREREQ_SKIPPED="…continuing anyway because --no-start was given (nothing will be started)."

# --- question 1: domain ---
T_Q_DOMAIN="Domain for this station, e.g. front.feuerwehr-example.ch
  Its A/AAAA record must already point at this server — a certificate is fetched for it.
  Leave EMPTY for LAN only: plain HTTP, reachable at this machine's address, no certificate.
Domain (empty = LAN only)"
T_ERR_BAD_DOMAIN_FMT="'%s' is not a hostname. Letters, digits, dots and hyphens only."
T_ERR_YES_NEEDS_MODE="--yes needs either --domain <name> or --lan, so that HTTPS-or-not is
your decision and not this script's guess."
# The same dead end, reached without typing --yes: stdin is a pipe or a file, so the questions
# below cannot be asked. Naming --yes here would be a lie about what the operator did.
T_ERR_NO_TTY_NEEDS_MODE="no terminal to ask on. This script's input is a pipe or a redirect,
so the questions below cannot be asked — and answers piped in are NOT read. Whether this
station serves HTTPS or plain HTTP is not something it may guess for you.
  Say which one you want:
      ./scripts/setup.sh --lan                          plain HTTP on the LAN
      ./scripts/setup.sh --domain front.example.ch      HTTPS on that domain
  Or run it straight in a terminal — then it asks."
T_ERR_OPTION_NEEDS_VALUE_FMT="%s needs a value after it, e.g. %s"
# %s the flag, %s what followed it, %s the example. Naming BOTH is the point: the argument the
# script would otherwise complain about is two places further along and perfectly fine.
T_ERR_OPTION_ATE_FLAG_FMT="%s needs a value after it, and '%s' is not one — anything starting
with a hyphen is read as the next option.
Write it as: %s"
T_ERR_DOMAIN_EMPTY="--domain was given without a name. Either name the host
(--domain front.example.ch) or use --lan for a plain-HTTP LAN install."
T_CHOSE_TLS_FMT="HTTPS for %s, certificate handled automatically (Caddy, tls profile)."
T_CHOSE_LAN="LAN only, plain HTTP — and therefore COOKIE_SECURE=false, without which the
  browser silently throws the login cookie away and the login just… doesn't happen."
T_PROXY_DETECTED="Ports 80 and 443 are already taken on this host — normally by another
  stack's reverse proxy (a KP Rück install is the usual one). Only one thing can own 443, so
  this install will NOT run its own Caddy."
T_Q_PROXY_OK_FMT="Configure it to sit behind your existing proxy instead (point that proxy at
  http://127.0.0.1:%s)?"
T_ABORT_PROXY="Stopped. Free ports 80/443, or re-run and answer with an empty domain for a
plain-HTTP LAN install."
T_CHOSE_BEHIND_PROXY_FMT="HTTPS for %s, terminated by your existing proxy. This install
  listens on 127.0.0.1:%s only — point the proxy there."

# --- question 2: port ---
T_Q_PORT="Host port for the app"
T_PORT_TAKEN_FMT="Port %s is already in use on this host — proposing %s instead."
T_PORT_STILL_TAKEN_FMT="Port %s is in use. Pick another."
T_ERR_PORT_EXPLICIT_TAKEN_FMT="Port %s is already in use on this host, and you asked for that
one specifically — so nothing was silently moved to a different one (your reverse proxy,
firewall rule or bookmark would then point at nothing). Port %s is free:  --port %s
Find out what holds %s:  ss -tlnp | grep :%s"
T_ERR_BAD_PORT_FMT="'%s' is not a port number (1–65535)."
T_ERR_NO_FREE_PORT="Found no free port to propose. Free one up, or pass --port explicitly."

# --- version ---
T_TAG_PINNED_FMT="Version: %s — this checkout sits on tag %s, so that exact image is what runs."
T_TAG_LATEST="Version: latest — this checkout is not on a release tag, so the stack runs the
  newest published release, whatever that is today, and 'docker compose pull' moves it
  forward. To pin instead: 'git checkout v0.6.0' and re-run, or set KP_FRONT_TAG in .env."
T_TAG_BUILD="Version: built from this working tree (--build). KP_FRONT_TAG decides nothing
  in this mode — 'git log -1' is the version, and that commit is stamped into the image, so
  'curl /health' says which build is running. Rebuild after every 'git pull'."
T_TAG_EXPLICIT_FMT="Version: %s (--tag)."
T_ERR_BAD_TAG_FMT="«%s» is not a usable image tag. Letters, digits, dot, dash and underscore
  only — e.g. --tag v0.6.0, --tag 0.6, --tag latest."

# --- writing ---
T_WROTE_FMT="Wrote %s (mode 600) — four secrets generated, your answers filled in."
T_ENV_EXISTS_FMT="%s already exists, so nothing was written and no secrets were regenerated.
That is deliberate: a new SECRET_KEY over a live deployment invalidates every PIN in the
database. Here is what this host is doing right now instead —"
T_STATUS_HEADER="Current state"
T_STATUS_REACHABLE_FMT="The app answers on %s — it is up."
T_STATUS_UNREACHABLE_FMT="Nothing answers on %s."
T_STATUS_NEXT_FMT="To change something, edit %s and run: docker compose up -d
Integrations (Divera, Traccar, Web Push, STT, webhooks) are NOT in that file — they are set
in the browser at /admin → «Zugangsdaten». To mint the Web Push pair this installer generates,
if that step was ever missed:  ./scripts/setup.sh --credentials
To start over from scratch (WIPES the database and all uploads):
  docker compose down -v && rm %s && ./scripts/setup.sh"
T_OVERRIDE_WROTE="Copied docker-compose.override.yml.example → docker-compose.override.yml
  (that is what makes compose build from source; it is gitignored, so no tracked file is
  edited and no future 'git pull' conflicts)."
T_OVERRIDE_EXISTS="docker-compose.override.yml already exists — leaving it as it is."
T_ERR_NO_OVERRIDE_EXAMPLE="docker-compose.override.yml.example is missing from this checkout,
so --build has nothing to copy."

# --- starting ---
T_STARTING="Pulling images and starting containers…"
T_BUILDING="Building the image from this checkout and starting containers (several minutes
  on a first run)…"
# %s spinner, %s elapsed, %s the step docker is on right now. Deliberately NOT the raw build
# log: a volunteer reading 4000 lines of npm output learns nothing, but «still alive, 4m in,
# on 'RUN pnpm build'» is the difference between waiting and opening a second terminal.
T_UP_PROGRESS_FMT="  %s  %s  ·  %s"
T_UP_STAGE_START="starting docker"
T_WAIT_FMT="  waiting for the app to answer on %s — first boot runs database migrations"
T_WAIT_PROGRESS_FMT="  %s  %ds elapsed (timeout %ds)"
T_READY_FMT="The app is ready (%ds)."
# …and what was verified, because the check that follows /ready is the interesting one and it
# used to pass in silence. A tester who is told only «ready» re-runs the two curls himself —
# which is exactly the work roster_count() exists to save. %d seconds, %s accounts.
T_READY_ROSTER_FMT="The app is ready (%ds): /ready is green (database reachable, storage
  writable) and the login screen offers %s account(s) — so somebody can actually get in."

# --- question 3: the backup schedule ---
# ⚠️ Asked, never assumed — this one line is the only thing the installer writes outside its
# own directory, and a crontab is the operator's, not ours. It is also the one thing on this
# page that nothing else in the product does: there is no in-container scheduler that could
# take its place, because a backup living inside the volume it protects dies with it.
T_Q_BACKUP="Back this station up every night at 03:30?
  Nothing backs it up otherwise — not this stack, not the app. The database and the uploads
  are one machine away from gone.
  This adds ONE line to %s's crontab (the only thing this installer writes outside its own
  directory). It runs scripts/backup.sh into
      %s
  keeping the newest %s database dumps and storage tarballs. Roughly the size of your uploads,
  once, per night kept.
Install it"
T_BACKUP_INSTALLED_FMT="Nightly backup installed in %s's crontab:
    %s"
T_BACKUP_VERIFY="  Running it once now, with cron's near-empty environment — an installed line
  that cannot find docker at 03:30 is the classic version of this going wrong…"
T_BACKUP_VERIFY_OK_FMT="Verified: it ran under a cron-like environment and wrote %s.
  ⚠️ Same box, same disk. Copy those files somewhere else — that is still yours to arrange."
T_BACKUP_VERIFY_FAIL="The line is installed but the test run FAILED, so tonight's backup will
  fail too. Output above. Until it is fixed, this station has no backups.
  Run it by hand to see it again:  ./scripts/backup.sh %s"
T_BACKUP_EXISTS="This user's crontab already runs scripts/backup.sh — leaving it alone.
  See it:  crontab -l"
T_BACKUP_NO_CRON="No 'crontab' command on this host, so no schedule was installed. Whatever
  this system uses instead (a systemd timer, the platform's scheduler) has to run:
    %s"
T_BACKUP_ENVFILE="A schedule was not offered: scripts/backup.sh reads ./.env, and this install
  writes %s instead. Point a scheduler at it yourself if this is a real deployment."
# The decline text is deliberately as plain as the offer. «You declined backups» is not
# information; «a lost disk is a lost station» is.
T_BACKUP_DECLINED_FMT="No backup schedule was installed, so this station has NO backups. A
  failed disk, a bad update or a deleted incident would be unrecoverable, and the automatic
  pre-migration dumps do not help: they live on the same volume they would have to survive.
  Add it later, any time:   ./scripts/setup.sh --backup-cron
  Or by hand — crontab -e, and paste:
    %s
  Or take one now, once:    ./scripts/backup.sh %s"
T_BACKUP_NO_START_FMT="The backup schedule was NOT installed: --no-start means there is no
  running stack to back up, and a schedule is only worth having once it has been proved to
  work. Install it after 'docker compose up -d':
      ./scripts/setup.sh --backup-cron"
T_BACKUP_SKIPPED_NONINTERACTIVE_FMT="No backup schedule was installed: nothing was asked,
  because there is no terminal to ask on, and a crontab is not something to change on a guess.
  Install it with:  ./scripts/setup.sh --backup-cron
  Or paste this into 'crontab -e':
    %s"

# --- Web Push credential ---
# ⚠️ They are stored in the DATABASE, never in .env, and the difference is the whole point —
# see the block above seed_credentials() for why the two are mutually exclusive.
T_CREDS_INTRO_FMT="Generating this station's Web Push key pair and storing it encrypted in
  the database — deliberately NOT in %s. A value in that file outranks the stored one and turns
  its field in «/admin → Zugangsdaten» read-only, so a station whose keys live there can never
  change them from a browser. Minted here, they can be rotated at 03:00 without SSH."
T_VAPID_MAKING="  Generating the Web-Push key pair (VAPID) in the app container…"
T_CREDS_SET_FMT="%s: generated and stored."
T_CREDS_KEPT_FMT="%s: already set on this deployment — left exactly as it was."
T_CREDS_REPLACED_FMT="%s: the stored value could not be decrypted (SECRET_KEY changed since it
  was written, so it was dead either way) — replaced with a fresh one."
T_CREDS_ENV_FMT="%s: supplied by the server environment (%s in %s). Nothing was stored, and it
  cannot be changed in the browser until that line is emptied and the stack restarted."
T_CREDS_PUSH_ENV_FMT="Web Push: the VAPID keys come from the server environment (%s), so
  nothing was generated. That also means «/admin → Zugangsdaten» cannot rotate them."
T_CREDS_PUSH_KEPT="Web Push: this deployment already has a VAPID pair — left exactly as it was.
  Replacing one would invalidate every subscription a tablet has already made."
T_CREDS_PUSH_OK="Web Push is on: the key pair is stored and rotatable in «/admin →
  Zugangsdaten». That is what makes an Atemschutz alarm reach a tablet whose screen is off —
  the one integration the go-live checklist calls safety-critical, and the one nobody notices
  is missing until it is."
# The half-a-key-pair case. Never «fixed» automatically: a fresh public key next to a stored
# private one leaves push looking configured and signing with a mismatched pair, which fails
# silently at exactly the wrong moment.
T_CREDS_PUSH_MIXED_FMT="Web Push: this deployment holds only half a VAPID pair (public: %s,
  private: %s), and half a key pair is worse than none — nothing was generated, because
  replacing one half would leave push «configured» and silently unable to deliver.
  Set BOTH halves in «/admin → Zugangsdaten» → «Web Push»; that card names the command that
  makes a pair."
T_CREDS_WHY_NO_CURL="there is no curl on this host, and this step talks to the app over HTTP"
T_CREDS_WHY_LOGIN="the admin API did not accept ADMIN_SECRET"
T_CREDS_WHY_LIST="the admin API did not answer with the credential list"
# Its own message, because the generic one would send somebody to /admin — and /admin is
# exactly what an empty ADMIN_SECRET switches off. «Open the page and set it there» is not
# advice you can follow when the page is the thing that is missing.
T_CREDS_NO_ADMIN_FMT="No Web Push key was stored, and none can be from here: ADMIN_SECRET
  is empty in %s, so this deployment's whole admin surface is off (fail-closed) — /admin
  included. Everything else about this install is fine.
  Put a secret in that file (openssl rand -hex 24), then:
      docker compose up -d && ./scripts/setup.sh --credentials"
# ⚠️ Never fatal, and the first line says so. A station with no Web Push is a working station;
# an installer that aborts on the last optional step is not. What it owes the operator instead
# is the exact browser path — this is the ONE step that can be finished without a terminal.
T_CREDS_FAIL_FMT="No Web Push key was stored: %s.
  The install itself is FINISHED and this station works. What is missing is Web Push (so
  Atemschutz and Wiedervorlage alarms only fire while the app is in the foreground).
  Finish it in a browser — no terminal needed:
    1. open %sadmin and unlock it with the ADMIN_SECRET from %s
    2. «Zugangsdaten» → «Web Push»: that card names the one command that makes a key pair
       (docker compose exec app uv run python -m app.gen_vapid) and takes both halves
  Or let this script try again against the running stack:
      ./scripts/setup.sh --credentials"
T_CREDS_PARTIAL_FMT="The Web Push pair was not fully stored. The rest of this install is
  unaffected. Set both halves in a browser at %sadmin → «Zugangsdaten», or run
  ./scripts/setup.sh --credentials once the app is healthy."
T_CREDS_PUT_FAILED_FMT="%s: the server refused to store it."
T_CREDS_NO_START="No Web Push key was minted either: the pair lives in the database now, and
  --no-start means there is no running app to write them through. Once the stack is up:
      ./scripts/setup.sh --credentials"
T_ERR_CREDS_NO_ENV_FMT="--credentials works on an already-installed deployment, and %s does not
exist — so there is nothing here to add a secret to. Run ./scripts/setup.sh to install first."

# --- final summary ---
T_DONE_URL_FMT="Open it:            %s"
# «Führungsunterstützung» is German on purpose: it is the label on the tile the operator taps,
# quoted verbatim. The account's username ('fu') is in the database and on no screen — naming
# it here sends people to an API that wants the account's UUID.
T_DONE_LOGIN_FMT="First login:        tap «Führungsunterstützung», PIN %s   ← CHANGE THIS NOW"
T_DONE_ADMIN_FMT="ADMIN_SECRET:       %s
                    Unlocks /admin. Write it down — nothing shows it to you again."
T_DONE_BACKUP_FMT="Back up %s somewhere that is NOT this server — a password manager, a
  printout in the Kommandoraum. It holds SECRET_KEY, which peppers every PIN in the database:
  lose it and every account's PIN becomes worthless, restore-from-backup included."
T_DONE_DNS_FMT="The certificate for %s arrives within a minute or so of the DNS record
  resolving to this host. Until then the browser will complain — that is expected, not a
  failure."
T_DONE_LATEST="Reminder: this runs 'latest'. A 'docker compose pull && docker compose up -d'
  will move the station onto a newer release — do that deliberately, not on an alarm day."
T_DONE_COMMANDS="Everyday commands:
  ./scripts/doctor.sh                     something is wrong — start here
  docker compose ps                       what is running
  docker compose logs -f app              follow the app log
  docker compose pull && docker compose up -d    update
  ./scripts/backup.sh                     back up now, on top of the nightly one
  ./scripts/restore.sh <file>             put a backup back (read its --help first)"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ─── end of operator-facing strings ───────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════════════════════

# The console helpers (say/sayf/step/ok/info/warn/die and the colours) come from lib.sh.

# ─── argument parsing ─────────────────────────────────────────────────────────────────────

DOMAIN=""
MODE=""             # tls | proxy | lan  (empty = ask)
PORT=""
TAG=""
BUILD=0
NO_START=0
TIMEOUT=300
ENV_FILE="${KP_ENV_FILE:-}"
BACKUP_CRON=""          # "" = ask · yes · no
BACKUP_DIR=""
CREDENTIALS_ONLY=0      # --credentials: seed the credential store on an existing install
INTERACTIVE=1
# Two different reasons not to prompt, and they must not be confused once one of them turns
# into an error: YES means the operator asked for it, no YES means the shell handed us no
# terminal. Blaming a flag nobody typed sends people looking for a flag they did not pass.
YES=0

# need_value FLAG EXAMPLE "$@" — refuse a value-taking option with nothing after it.
# `shift 2` past the end of "$@" returns non-zero, and under `set -e` that exits 1 having
# printed NOTHING at all — the least helpful error there is.
# The count is 2 fixed arguments + the flag itself + its value, so anything under 4 is a flag
# sitting at the end of the command line.
#
# ⚠️ Counting is not enough in the MIDDLE of a command line. `--lan --port --env-file /tmp/t.env`
# has plenty of arguments left, so `--port` happily ate `--env-file` and the loop then blamed the
# innocent path it found next: «unknown option: /tmp/t.env» — pointing at the one argument that
# was correct, for a mistake made two flags earlier. None of these options takes a value that
# starts with a hyphen, so a value that looks like a flag IS the missing value.
need_value() {
  [[ $# -ge 4 ]] || die "$(sayf "$T_ERR_OPTION_NEEDS_VALUE_FMT" "$1" "$2")"
  [[ "$4" != -* ]] || die "$(sayf "$T_ERR_OPTION_ATE_FLAG_FMT" "$1" "$4" "$2")"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)   need_value --domain "--domain front.example.ch" "$@"; DOMAIN="$2"; MODE="tls"; shift 2 ;;
    --lan)      MODE="lan"; shift ;;
    --port)     need_value --port "--port 8000" "$@"; PORT="$2"; shift 2 ;;
    # ⚠️ Validated HERE, at parse time, not at use. Every other `kp_env_set` value is generated
    # or picked from a fixed set; this is the one an operator types, and it goes into a `sed`
    # replacement. A `|` (sed's delimiter) or a newline aborted the run AFTER `.env` had already
    # been written, and the re-run then stopped at «.env exists already» — an install wedged
    # half-done by a typo, with no way forward that the script itself offers.
    --tag)      need_value --tag "--tag v0.6.0" "$@"
                [[ "$2" =~ ^v?[0-9A-Za-z._-]+$ ]] \
                  || die "$(sayf "$T_ERR_BAD_TAG_FMT" "$2")"
                TAG="$2"; shift 2 ;;
    --build)    BUILD=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --timeout)  need_value --timeout "--timeout 300" "$@"; TIMEOUT="$2"; shift 2 ;;
    --env-file) need_value --env-file "--env-file ./.env" "$@"; ENV_FILE="$2"; shift 2 ;;
    --backup-cron)    BACKUP_CRON="yes"; shift ;;
    --no-backup-cron) BACKUP_CRON="no"; shift ;;
    --backup-dir)     need_value --backup-dir "--backup-dir /var/backups/kp-front" "$@"; BACKUP_DIR="$2"; shift 2 ;;
    --credentials)    CREDENTIALS_ONLY=1; shift ;;
    -y|--yes)   YES=1; INTERACTIVE=0; shift ;;
    -h|--help)  say "$T_USAGE"; exit 0 ;;
    *)          say "$T_USAGE" >&2; die "unknown option: $1" ;;
  esac
done

[[ -t 0 ]] || INTERACTIVE=0    # no terminal (CI, piped) ⇒ never block on a prompt

cd "$REPO_ROOT"
[[ -n "$ENV_FILE" ]] || ENV_FILE=".env"
[[ -n "$BACKUP_DIR" ]] || BACKUP_DIR="$REPO_ROOT/backups"

# --credentials is a re-run against something already installed, like --backup-cron. Falling
# through to a full install because the file happens to be missing would be a surprise of the
# worst kind: it would generate a new SECRET_KEY over an existing database.
if [[ "$CREDENTIALS_ONLY" -eq 1 && ! -e "$ENV_FILE" ]]; then
  die "$(sayf "$T_ERR_CREDS_NO_ENV_FMT" "$ENV_FILE")"
fi

# ─── small helpers ────────────────────────────────────────────────────────────────────────

# ask VARNAME PROMPT [DEFAULT] — prompt on the tty; take DEFAULT non-interactively or on Enter.
ask() {
  local __var="$1" prompt="$2" default="${3-}" reply=""
  if [[ "$INTERACTIVE" -eq 0 ]]; then
    printf -v "$__var" '%s' "$default"
    return 0
  fi
  if [[ -n "$default" ]]; then
    printf '\n%s%s%s [%s]: ' "$C_B" "$prompt" "$C_0" "$default"
  else
    printf '\n%s%s%s: ' "$C_B" "$prompt" "$C_0"
  fi
  IFS= read -r reply || reply=""
  printf -v "$__var" '%s' "${reply:-$default}"
}

# confirm PROMPT — yes/no, defaults to yes (and to yes non-interactively).
confirm() {
  local reply=""
  [[ "$INTERACTIVE" -eq 0 ]] && return 0
  printf '\n%s%s%s [Y/n]: ' "$C_B" "$1" "$C_0"
  IFS= read -r reply || reply=""
  case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}

# port_in_use / first_free_port / probe_ready / roster_count and the compose wrappers all
# live in lib.sh, because doctor.sh asks the host exactly the same questions.

valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }
valid_domain() { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$1" == *.* ]]; }

# This host's LAN address, for the URL we hand back at the end.
lan_ip() {
  local ip=""
  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || ip=""
  fi
  if [[ -z "$ip" ]] && command -v ipconfig >/dev/null 2>&1; then
    ip="$(ipconfig getifaddr en0 2>/dev/null)" || ip=""
  fi
  printf '%s\n' "${ip:-localhost}"
}

# app_url — where a HUMAN reaches this deployment, trailing slash included. Used for the final
# summary and for the «finish this in a browser» hints, which must name the address the
# operator can actually open — not the loopback one the script itself talks to.
app_url() {
  if [[ -n "$DOMAIN" ]]; then
    printf 'https://%s/\n' "$DOMAIN"
  else
    printf 'http://%s:%s/\n' "$(lan_ip)" "$PORT"
  fi
}

SPIN=$'|/-\\'

# fmt_elapsed SECONDS — «41s» / «6m 03s». Minutes, because the thing this measures takes them.
fmt_elapsed() {
  local s="$1"
  if ((s < 60)); then printf '%ds' "$s"; else printf '%dm %02ds' $((s / 60)) $((s % 60)); fi
}

# current_stage FILE — one short line naming what docker is doing right now, from its log.
#
# NOT `tail -1`: the newest line is usually a «#12 DONE 4.2s» or a bare layer sha, which says
# nothing about what is happening now. Buildkit with a non-tty writes «#12 [app 5/9] RUN …»
# per step, and compose's pull writes «app Pulling» / «a1b2c3 Extracting», so take the newest
# line of THOSE and fall back to the last non-empty line only if neither shape appears.
current_stage() {
  local f="$1" line=""
  [[ -s "$f" ]] || { printf '%s\n' "$T_UP_STAGE_START"; return; }
  line="$(grep -aE '^#[0-9]+ +\[' "$f" 2>/dev/null | tail -1)"
  [[ -n "$line" ]] || line="$(grep -aE 'Pulling|Downloading|Extracting|Waiting|Creating|Starting' "$f" 2>/dev/null | tail -1)"
  [[ -n "$line" ]] || line="$(grep -av '^[[:space:]]*$' "$f" 2>/dev/null | tail -1)"
  line="$(printf '%s' "$line" | sed -E 's/^#[0-9]+ +//; s/^[[:space:]]+//')"
  # One line, and short enough that \r overwrites it cleanly on an 80-column console.
  printf '%.58s\n' "${line:-$T_UP_STAGE_START}"
}

# run_with_progress ARGS… — run `compose ARGS` into $UP_LOG while saying it is still alive.
# Returns compose's exit status. Silence is the bug this exists for: the build step takes
# minutes and used to print nothing at all, so the only way to tell a running build from a
# hung one was `docker ps` in a second terminal.
run_with_progress() {
  local pid rc=0 t=0 i=0 last_note=-1 start=$SECONDS
  compose "$@" >"$UP_LOG" 2>&1 &
  pid=$!
  # Ctrl-C during a long build must take docker with it, not leave it running detached.
  trap 'kill "$pid" 2>/dev/null || true; rm -f "$UP_LOG"; exit 130' INT TERM
  while kill -0 "$pid" 2>/dev/null; do
    t=$((SECONDS - start))
    i=$(((i + 1) % 4))
    if [[ -t 1 ]]; then
      printf '\r%-78s' "$(sayf "$T_UP_PROGRESS_FMT" "${SPIN:$i:1}" "$(fmt_elapsed "$t")" "$(current_stage "$UP_LOG")")"
    elif ((t / 30 != last_note)); then
      # Piped into a log: \r would smear the whole build onto one unreadable line.
      last_note=$((t / 30))
      sayf "$T_UP_PROGRESS_FMT" "·" "$(fmt_elapsed "$t")" "$(current_stage "$UP_LOG")"
    fi
    sleep 2
  done
  wait "$pid" || rc=$?
  trap - INT TERM
  [[ -t 1 ]] && printf '\r%*s\r' 78 '' || true
  return "$rc"
}

# ─── Web Push credential ──────────────────────────────────────────────────────────────────
#
# WHERE THEY GO, AND WHY IT IS NOT .env
# -------------------------------------
# This script used to write VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, DIVERA_WEBHOOK_SECRET and
# ALARM_WEBHOOK_SECRET into .env. None belongs there, and the reason is not tidiness:
# backend/app/credentials.py gives the ENVIRONMENT precedence over the encrypted store, and a
# field the environment supplies reports itself as server-set in «/admin → Zugangsdaten» and
# refuses to save (409). Minting into .env therefore handed every fresh station dead fields on
# the one page built to keep it off SSH — credentials it could never rotate from a
# phone at 03:00, on the day the alerting system changed its key.
#
# Only the VAPID pair is minted into the store here, over this deployment's own API, with the
# ADMIN_SECRET this script generated minutes ago. Webhook secrets are created later, during the
# external-system handoff, because a write-only value nobody received would be unusable. The
# station gets working Web Push out of the box and keeps the pair rotatable from a browser.
#
# ⚠️ Nothing here is fatal. A station with no Web Push is a working station; an install that
# aborts on its last optional step is not.

CREDS_JSON=""
ADMIN_COOKIE=""
VAPID_PUB=""
VAPID_PRIV=""

# api_url PATH — this deployment's own API over the loopback port compose just published.
# 127.0.0.1 whatever APP_BIND says: the published port answers there either way, and it is the
# one address that works before DNS resolves or a certificate exists.
api_url() { printf 'http://127.0.0.1:%s%s' "$PORT" "$1"; }

# admin_login SECRET — trade ADMIN_SECRET for an admin session, printing the cookie's value.
#
# ⚠️ The cookie is lifted out of the response header and sent back by hand rather than kept in
# a curl jar. On a domain install the app marks it `Secure` (COOKIE_SECURE follows
# ENVIRONMENT=production), and curl then refuses to send a Secure cookie back over the
# plain-HTTP loopback address this script has to use — every PUT below would 401 on a
# deployment that is perfectly healthy.
# ⚠️ NOTHING SECRET GOES ON A COMMAND LINE. `/proc/<pid>/cmdline` is world-readable and `ps
# auxww` shows every argument to every process on the host, so `--data-binary '{"secret":"…"}'`
# and `-H "Cookie: admin_session=…"` published ADMIN_SECRET, the admin session and every minted
# credential to any account on the box for as long as each curl ran. Bodies now arrive on STDIN
# (`--data-binary @-`) and headers through a `--config` file on fd 3 — `curl -K` reads options
# from a file, and a process substitution keeps that file off the disk entirely.
#
# The `admin_session` cookie is lifted out of the response header and sent back by hand rather
# than kept in a curl jar. On a domain install the app marks it `Secure` (COOKIE_SECURE follows
# ENVIRONMENT=production), and curl then refuses to send a Secure cookie back over the
# plain-HTTP loopback address this script has to use — every PUT below would 401 on a
# deployment that is perfectly healthy.
admin_login() {
  local headers
  headers="$(printf '{"secret":"%s"}' "$1" | curl -sS -m 15 -o /dev/null -D - -X POST \
      -H 'Content-Type: application/json' \
      --data-binary @- \
      "$(api_url /api/admin/login)" 2>/dev/null)" || return 1
  printf '%s' "$headers" | tr -d '\r' \
    | sed -n 's/^[Ss]et-[Cc]ookie: *admin_session=\([^;]*\).*/\1/p' | tail -1
}

# cookie_config — the admin-session header as curl `--config` input, never as an argument.
cookie_config() { printf 'header = "Cookie: admin_session=%s"\n' "$ADMIN_COOKIE"; }

# creds_fetch — the whole credential snapshot into CREDS_JSON. 1 if it cannot be read.
creds_fetch() {
  CREDS_JSON="$(curl -sS -m 15 --config <(cookie_config) \
      "$(api_url /api/integrations/credentials)" 2>/dev/null)" || return 1
  [[ "$CREDS_JSON" == \[* ]]
}

# cred_field NAME KEY — one string field of one credential, out of the cached snapshot.
#
# There is no jq on a fresh Debian host and this response needs none: CredentialState is FLAT,
# so `{` separates the records cleanly and each record carries exactly one of each key.
cred_field() {
  printf '%s' "$CREDS_JSON" | tr '{' '\n' | grep -F "\"name\":\"$1\"" \
    | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" | head -1
}

# cred_label NAME — the German label the browser shows for this row, so the console names the
# field an operator is about to go looking for. Falls back to the raw name.
cred_label() {
  local l; l="$(cred_field "$1" label)"
  printf '%s' "${l:-$1}"
}

# cred_put NAME VALUE — store one credential. 0 on a 200, 1 on anything else.
#
# ⚠️ The values are hex or URL-safe base64 BY CONSTRUCTION, which is the only reason this can
# build JSON with a printf. Never hand it something a human typed.
cred_put() {
  local code
  # Body on stdin, cookie via --config: the VALUE here is a freshly minted credential and must
  # not be visible in `ps` — see the note above admin_login.
  code="$(printf '{"value":"%s"}' "$2" | curl -sS -m 20 -o /dev/null -w '%{http_code}' -X PUT \
      -H 'Content-Type: application/json' --config <(cookie_config) \
      --data-binary @- \
      "$(api_url "/api/integrations/credentials/$1")" 2>/dev/null)" || return 1
  [[ "$code" == "200" ]]
}

# seed_one NAME VALUE — store one credential unless this station already owns one.
#
# ⚠️ The look before the write is the point of this function. A re-run must never replace a
# secret the station rotated since — that would break the very webhook somebody went to the
# trouble of connecting, silently, during a run that then reports success. `unreadable` is the
# one state that IS overwritten: it means SECRET_KEY changed and the stored bytes are already
# dead, so «set it again» is exactly what the app itself asks for.
seed_one() {
  local name="$1" value="$2" label src
  label="$(cred_label "$name")"
  src="$(cred_field "$name" source)"
  case "$src" in
    unset|unreadable)
      if ! cred_put "$name" "$value"; then
        warn "$(sayf "$T_CREDS_PUT_FAILED_FMT" "$label")"
        return 1
      fi
      if [[ "$src" == "unreadable" ]]; then
        ok "$(sayf "$T_CREDS_REPLACED_FMT" "$label")"
      else
        ok "$(sayf "$T_CREDS_SET_FMT" "$label")"
      fi
      ;;
    stored)
      info "$(sayf "$T_CREDS_KEPT_FMT" "$label")"
      ;;
    env)
      info "$(sayf "$T_CREDS_ENV_FMT" "$label" "$(cred_field "$name" env)" "$ENV_FILE")"
      ;;
    *)
      warn "$(sayf "$T_CREDS_PUT_FAILED_FMT" "$label")"
      return 1
      ;;
  esac
  return 0
}

# mint_vapid — a fresh key pair out of the app image, into VAPID_PUB / VAPID_PRIV.
#
# The runtime image is ghcr.io/astral-sh/uv:python3.12 with the backend synced into it, so
# backend/app/gen_vapid.py — 35 lines of `cryptography`, no database, no network — runs right
# here. That is what keeps this a Docker-only host: the documented alternatives were `uv`
# (which SETUP.md promises you do not need) and `npx` (one absent toolchain swapped for
# another).
#
# ⚠️ `run --rm --no-deps`, not `exec`: generating a key pair needs no HEALTHY app container, so
# this still works while the app is migrating or restart-looping for an unrelated reason.
mint_vapid() {
  local out
  say "$T_VAPID_MAKING"
  out="$(compose run --rm --no-deps -T app uv run python -m app.gen_vapid 2>/dev/null)" || return 1
  VAPID_PUB="$(printf '%s' "$out" | tr -d '\r' | sed -n 's/^VAPID_PUBLIC_KEY=//p' | tail -1)"
  VAPID_PRIV="$(printf '%s' "$out" | tr -d '\r' | sed -n 's/^VAPID_PRIVATE_KEY=//p' | tail -1)"
  [[ -n "$VAPID_PUB" && -n "$VAPID_PRIV" ]]
}

# seed_push — the VAPID pair, and only ever as a PAIR.
#
# ⚠️ Never half of one. The two halves are one key: a fresh public key stored next to a private
# key that was already there leaves push looking «configured» and signing every notification
# with a mismatched pair — which fails silently, and the failure is an Atemschutz alarm that
# does not arrive. So anything other than «both there» or «both missing» is reported and left
# alone; only a pair that cannot be decrypted at all is replaced wholesale.
seed_push() {
  local pub priv
  pub="$(cred_field vapid_public_key source)"
  priv="$(cred_field vapid_private_key source)"
  case "$pub/$priv" in
    env/*|*/env)
      info "$(sayf "$T_CREDS_PUSH_ENV_FMT" "$ENV_FILE")"
      return 0
      ;;
    stored/stored)
      info "$T_CREDS_PUSH_KEPT"
      return 0
      ;;
    unset/unset|unreadable/unreadable)
      if ! mint_vapid; then
        warn "$(sayf "$T_CREDS_PUT_FAILED_FMT" "$(cred_label vapid_public_key)")"
        return 1
      fi
      seed_one vapid_public_key "$VAPID_PUB" || return 1
      seed_one vapid_private_key "$VAPID_PRIV" || return 1
      ok "$T_CREDS_PUSH_OK"
      return 0
      ;;
    *)
      warn "$(sayf "$T_CREDS_PUSH_MIXED_FMT" "${pub:-?}" "${priv:-?}")"
      return 1
      ;;
  esac
}

# seed_credentials — mint the Web Push pair if it is missing, touch nothing else, never abort
# the install. Webhook secrets are write-only and must be chosen while the external system is
# connected, so the same value can be handed to both sides instead of disappearing into this
# store before anybody has seen it.
seed_credentials() {
  local rc=0 why=""
  sayf "$T_CREDS_INTRO_FMT" "$ENV_FILE"
  if [[ -z "${KP_ADMIN_SECRET:-}" ]]; then
    warn "$(sayf "$T_CREDS_NO_ADMIN_FMT" "$ENV_FILE")"
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then why="$T_CREDS_WHY_NO_CURL"
  else
    ADMIN_COOKIE="$(admin_login "$KP_ADMIN_SECRET")" || ADMIN_COOKIE=""
    if [[ -z "$ADMIN_COOKIE" ]]; then why="$T_CREDS_WHY_LOGIN"
    elif ! creds_fetch; then why="$T_CREDS_WHY_LIST"
    fi
  fi
  if [[ -n "$why" ]]; then
    warn "$(sayf "$T_CREDS_FAIL_FMT" "$why" "$(app_url)" "$ENV_FILE")"
    return 1
  fi

  # ⚠️ PRINT_AGENT_SECRET is still NOT minted, and the reason has changed: its sweep is
  # registered unconditionally now and returns on the first line when no secret is set
  # (app/scheduler.py), so an unused value no longer costs a background job. What it costs is
  # on screen — this secret IS the switch that makes the relay «configured», so minting it
  # would render «An Stationsdrucker» on the Rapport and the capture poster for every station
  # that owns no printer, plus a permanently offline connector on the System card. And it still
  # saves nobody anything: the agent lives on a second machine provisioned at a terminal.
  seed_push || rc=1

  [[ "$rc" -eq 0 ]] || warn "$(sayf "$T_CREDS_PARTIAL_FMT" "$(app_url)")"
  return "$rc"
}

# ─── the backup schedule ──────────────────────────────────────────────────────────────────

# install_backup_cron — add the nightly line to THIS user's crontab, then prove it runs.
#
# Called only after the operator said yes (or passed --backup-cron). Everything it touches is
# outside this repository, which is why it is the one action here that is never taken on a
# default.
install_backup_cron() {
  local line tmp
  line="$(kp_cron_line "$REPO_ROOT" "$BACKUP_DIR")"

  if ! command -v "${KP_CRONTAB:-crontab}" >/dev/null 2>&1; then
    warn "$(sayf "$T_BACKUP_NO_CRON" "$line")"
    return 1
  fi
  if kp_cron_installed "$REPO_ROOT"; then
    info "$T_BACKUP_EXISTS"
    # ⚠️ …but STILL verify it. Not touching a crontab somebody else wrote is right; skipping
    # the test run is not, and the two got bundled together. docs/DEPLOYMENT.md §6 tells
    # stations to paste that line in by hand — so the hand-pasted line, the one nobody ever
    # watched execute, was precisely the line this function refused to test. And cron's
    # near-empty PATH is precisely what the test exists to catch. Running it is read-only
    # with respect to the crontab and produces a real backup, which is the point.
    verify_backup_run "$(kp_cron_command)" "$(kp_cron_backup_dir)"
    return 0
  fi

  mkdir -p "$BACKUP_DIR"
  # Full DB dumps and every uploaded file land here — same rule as scripts/backup.sh.
  chmod 700 "$BACKUP_DIR" 2>/dev/null || true
  # Written through a temp FILE, never piped: `{ crontab -l; echo …; } | crontab -` looks
  # tidier and loses the whole crontab on a host where this user has none yet — the group's
  # first command fails, `set -e` aborts the group, and the pipe installs what it got so far.
  tmp="$(mktemp)"
  kp_crontab -l >"$tmp" 2>/dev/null || : >"$tmp"
  printf '%s\n%s\n' "$KP_CRON_MARKER" "$line" >>"$tmp"
  if ! kp_crontab "$tmp"; then
    rm -f "$tmp"
    warn "$(sayf "$T_BACKUP_NO_CRON" "$line")"
    return 1
  fi
  rm -f "$tmp"
  ok "$(sayf "$T_BACKUP_INSTALLED_FMT" "$(id -un 2>/dev/null || echo "$USER")" "$line")"

  # …and now actually run it, in cron's environment rather than this shell's.
  verify_backup_run "cd $(printf '%q' "$REPO_ROOT") && ./scripts/backup.sh $(printf '%q' "$BACKUP_DIR")" "$BACKUP_DIR"
  return 0
}

# kp_cron_command — the COMMAND half of this checkout's installed cron line: the five schedule
# fields dropped from the front, and the `>> …/backup.log 2>&1` redirection from the end so the
# output can be shown here instead of disappearing into the log.
kp_cron_command() {
  kp_crontab -l 2>/dev/null | grep -v '^[[:space:]]*#' | grep -F "$REPO_ROOT" | grep 'scripts/backup\.sh' \
    | tail -1 | sed -E 's/^([^ ]+ +){5}//; s/[[:space:]]*>>[^>]*2>&1[[:space:]]*$//'
}

# kp_cron_backup_dir — where that line writes, so the check can look for the file it produced.
#
# ⚠️ Bash's own regex, not `sed`. The obvious `sed -n 's|…\+…|\1|p'` uses `\+` and `\{0,1\}`,
# which are GNU extensions: on a BSD sed (every macOS dev machine) it matches nothing and
# returns an EMPTY string rather than failing, so the caller would have looked for the backup
# in "". Only ever used to name the file in a message — hence the fallback rather than a die.
kp_cron_backup_dir() {
  local cmd; cmd="$(kp_cron_command)"
  if [[ "$cmd" =~ backup\.sh[[:space:]]+([^[:space:]]+) ]] && [[ -d "${BASH_REMATCH[1]}" ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    printf '%s' "$BACKUP_DIR"
  fi
}

# verify_backup_run COMMAND BACKUP_DIR — run a backup the way cron will, and say what happened.
#
# ⚠️ THE WHOLE REASON THE CRON LINE CARRIES A PATH. An installed job that cannot find `docker`
# fails at 03:30 into a log nobody reads, and the station finds out on the day it needs the
# backup. `env -i` reproduces that near-empty environment here, where somebody is watching.
# HOME comes along because the docker CLI reads its context from ~/.docker.
verify_backup_run() {
  local command="$1" backup_dir="$2" out rc=0 newest=""
  [[ -n "$command" ]] || return 0
  say "$T_BACKUP_VERIFY"
  out="$(env -i PATH="$(kp_cron_path)" HOME="${HOME:-/root}" \
           ${COMPOSE_PROJECT_NAME:+COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME"} \
           /bin/sh -c "$command" 2>&1)" || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    # shellcheck disable=SC2012  # the names are ours: db-<stamp>.sql.gz, ASCII by construction
    newest="$(ls -1t "$backup_dir"/db-*.sql.gz 2>/dev/null | head -1 || true)"
    ok "$(sayf "$T_BACKUP_VERIFY_OK_FMT" "$(basename "${newest:-a dump}") ($(du -h "${newest:-$backup_dir}" 2>/dev/null | cut -f1))")"
  else
    printf '%s\n' "$out" | tail -15 >&2
    warn "$(sayf "$T_BACKUP_VERIFY_FAIL" "$backup_dir")"
  fi
  return 0
}

# ask_backup_cron — question three. Decides BACKUP_CRON only; nothing is installed yet.
#
# It is asked here, with the other two, so every decision is made before the minutes-long wait
# and the operator can walk away from a build. A flag has already answered it when BACKUP_CRON
# is set. Non-interactive with no flag is a NO: a crontab is not something to change because
# nobody was there to say otherwise, and apply_backup_cron then says plainly what is missing.
ask_backup_cron() {
  [[ -z "$BACKUP_CRON" ]] || return 0
  if [[ "$ENV_FILE" != ".env" ]]; then
    # backup.sh reads ./.env for the database identity, so a schedule pointing at a different
    # env file would dump the wrong deployment's name — or nothing. Do not offer what we
    # cannot get right.
    BACKUP_CRON="skip"
    return 0
  fi
  if [[ "$INTERACTIVE" -eq 0 ]]; then
    BACKUP_CRON="unasked"
    return 0
  fi
  # Deliberately NOT confirm(): that one turns a bare Enter — and an EOF — into yes, which is
  # right for «is this port ok?» and wrong for the one question whose yes writes to the host's
  # crontab. Enter still means yes, because a nightly backup is the answer a station wants;
  # but stdin closing under us is nobody answering, and nobody answering is not consent.
  local reply=""
  printf '\n%s%s%s [Y/n]: ' "$C_B" \
    "$(sayf "$T_Q_BACKUP" "$(id -un 2>/dev/null || echo "${USER:-this user}")" "$BACKUP_DIR" "${BACKUP_KEEP:-14}")" "$C_0"
  if ! IFS= read -r reply; then
    say ""
    BACKUP_CRON="unasked"
    return 0
  fi
  case "$reply" in
    [nN]*) BACKUP_CRON="no" ;;
    *)     BACKUP_CRON="yes" ;;
  esac
}

# apply_backup_cron — act on question three, once there is a stack for it to back up.
apply_backup_cron() {
  local line
  line="$(kp_cron_line "$REPO_ROOT" "$BACKUP_DIR")"
  case "$BACKUP_CRON" in
    yes)      install_backup_cron || true ;;
    no)       say "$(sayf "$T_BACKUP_DECLINED_FMT" "$line" "$BACKUP_DIR")" ;;
    unasked)  say "$(sayf "$T_BACKUP_SKIPPED_NONINTERACTIVE_FMT" "$line")" ;;
    skip)     warn "$(sayf "$T_BACKUP_ENVFILE" "$ENV_FILE")" ;;
  esac
}

# ─── 1. prerequisites ─────────────────────────────────────────────────────────────────────

printf '\n%s%s%s\n' "$C_B" "$T_TITLE" "$C_0"

step "$T_STEP_CHECK"
if ! preflight; then
  if [[ "$NO_START" -eq 1 ]]; then
    info "$T_WARN_PREREQ_SKIPPED"
  else
    exit 1
  fi
fi

# ─── 2. re-run against an existing .env: report, never regenerate ─────────────────────────

if [[ -e "$ENV_FILE" ]]; then
  # …with one exception: `./scripts/setup.sh --backup-cron` on a deployment that is already
  # installed. That is how a station that said no in §1 — or installed before this script could
  # offer — gets the schedule later, without reading a doc for a crontab line.
  if [[ "$BACKUP_CRON" == "yes" ]]; then
    step "$T_STEP_BACKUP"
    [[ "$ENV_FILE" == ".env" ]] || { COMPOSE_ARGS+=(--env-file "$ENV_FILE"); BACKUP_CRON="skip"; }
    apply_backup_cron
    exit 0
  fi
  # …and the same shape for Web Push: `./scripts/setup.sh --credentials` is how
  # a deployment finishes a step that failed on install day (or was installed before this
  # script could mint anything) without anybody reading a doc. Everything it needs is in the
  # env file already — the port to talk to, the domain to name in a hint, and the admin secret.
  if [[ "$CREDENTIALS_ONLY" -eq 1 ]]; then
    step "$T_STEP_CREDS"
    [[ "$ENV_FILE" == ".env" ]] || COMPOSE_ARGS+=(--env-file "$ENV_FILE")
    PORT="$(kp_env_value APP_PORT 8000 "$ENV_FILE")"
    DOMAIN="$(kp_env_value DOMAIN "" "$ENV_FILE")"
    KP_ADMIN_SECRET="$(kp_env_value ADMIN_SECRET "" "$ENV_FILE")"
    seed_credentials || true
    exit 0
  fi
  step "$T_STATUS_HEADER"
  sayf "$T_ENV_EXISTS_FMT" "$ENV_FILE"
  [[ "$ENV_FILE" == ".env" ]] || COMPOSE_ARGS+=(--env-file "$ENV_FILE")
  existing_port="$(grep -E '^APP_PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  [[ -n "${existing_port:-}" ]] || existing_port="8000"
  echo
  # `ps` starts nothing, so --no-start is irrelevant here; only a missing docker is.
  if command -v docker >/dev/null 2>&1; then
    compose ps 2>/dev/null || true
  fi
  echo
  if probe_ready "http://127.0.0.1:${existing_port}/ready"; then
    ok "$(sayf "$T_STATUS_REACHABLE_FMT" "http://127.0.0.1:${existing_port}/")"
  else
    warn "$(sayf "$T_STATUS_UNREACHABLE_FMT" "http://127.0.0.1:${existing_port}/ready")"
  fi
  echo
  sayf "$T_STATUS_NEXT_FMT" "$ENV_FILE" "$ENV_FILE"
  exit 0
fi

# ─── 3. the questions ─────────────────────────────────────────────────────────────────────

step "$T_STEP_ASK"

if [[ -z "$MODE" ]]; then
  if [[ "$INTERACTIVE" -eq 0 ]]; then
    # Same dead end, two causes — say which one actually happened.
    [[ "$YES" -eq 1 ]] && die "$T_ERR_YES_NEEDS_MODE"
    die "$T_ERR_NO_TTY_NEEDS_MODE"
  fi
  ask DOMAIN "$T_Q_DOMAIN" ""
  MODE=$([[ -n "$DOMAIN" ]] && echo tls || echo lan)
fi

if [[ "$MODE" == "tls" ]]; then
  # MODE=tls can only come from --domain, so an empty DOMAIN here means «--domain» with
  # nothing after it — not a missing mode.
  [[ -n "$DOMAIN" ]] || die "$T_ERR_DOMAIN_EMPTY"
  valid_domain "$DOMAIN" || die "$(sayf "$T_ERR_BAD_DOMAIN_FMT" "$DOMAIN")"
fi

# One answer, three settings. The operator never has to learn that COOKIE_SECURE exists.
#   tls   → own Caddy on 80/443, HTTPS, Secure cookies (COOKIE_SECURE left blank = follow
#           ENVIRONMENT=production), app bound to loopback so nothing is served past Caddy.
#   proxy → same, minus the Caddy: 80/443 already belong to someone else on this host.
#   lan   → plain HTTP on the LAN, and COOKIE_SECURE=false or the login silently fails.
COOKIE_SECURE=""
APP_BIND="0.0.0.0"
PUBLIC_URL=""
USE_TLS_PROFILE=0

case "$MODE" in
  tls)
    if port_in_use 443 || port_in_use 80; then
      say ""
      warn "$T_PROXY_DETECTED"
      MODE="proxy"
    else
      USE_TLS_PROFILE=1
      APP_BIND="127.0.0.1"
      PUBLIC_URL="https://${DOMAIN}"
      ok "$(sayf "$T_CHOSE_TLS_FMT" "$DOMAIN")"
    fi
    ;;
esac

# ── question 2: the port ──
default_port="${PORT:-8000}"
valid_port "$default_port" || die "$(sayf "$T_ERR_BAD_PORT_FMT" "$default_port")"

if [[ -n "$PORT" ]]; then
  # An explicitly requested port is not negotiable. Quietly moving it would leave the
  # operator's reverse proxy — or their firewall rule, or their bookmark — pointing at nothing.
  if port_in_use "$PORT"; then
    alt="$(first_free_port "$PORT")" || die "$T_ERR_NO_FREE_PORT"
    die "$(sayf "$T_ERR_PORT_EXPLICIT_TAKEN_FMT" "$PORT" "$alt" "$alt" "$PORT" "$PORT")"
  fi
else
  if port_in_use "$default_port"; then
    proposed="$(first_free_port "$default_port")" || die "$T_ERR_NO_FREE_PORT"
    warn "$(sayf "$T_PORT_TAKEN_FMT" "$default_port" "$proposed")"
    default_port="$proposed"
  fi
  while :; do
    ask PORT "$T_Q_PORT" "$default_port"
    if ! valid_port "$PORT"; then
      warn "$(sayf "$T_ERR_BAD_PORT_FMT" "$PORT")"
      [[ "$INTERACTIVE" -eq 1 ]] || die "$(sayf "$T_ERR_BAD_PORT_FMT" "$PORT")"
      continue
    fi
    if port_in_use "$PORT"; then
      warn "$(sayf "$T_PORT_STILL_TAKEN_FMT" "$PORT")"
      [[ "$INTERACTIVE" -eq 1 ]] || die "$(sayf "$T_PORT_STILL_TAKEN_FMT" "$PORT")"
      continue
    fi
    break
  done
fi

# Now that the port is known, the "someone else owns 443" branch can name where to point.
if [[ "$MODE" == "proxy" ]]; then
  if ! confirm "$(sayf "$T_Q_PROXY_OK_FMT" "$PORT")"; then
    die "$T_ABORT_PROXY"
  fi
  APP_BIND="127.0.0.1"
  PUBLIC_URL="https://${DOMAIN}"
  ok "$(sayf "$T_CHOSE_BEHIND_PROXY_FMT" "$DOMAIN" "$PORT")"
elif [[ "$MODE" == "lan" ]]; then
  DOMAIN=""
  COOKIE_SECURE="false"
  APP_BIND="0.0.0.0"
  ok "$T_CHOSE_LAN"
fi

# ── the version, decided rather than defaulted ──
if [[ "$BUILD" -eq 1 ]]; then
  KP_FRONT_TAG="latest"        # unused in this mode; the override renames the image
  info "$T_TAG_BUILD"
elif [[ -n "$TAG" ]]; then
  KP_FRONT_TAG="${TAG#v}"
  info "$(sayf "$T_TAG_EXPLICIT_FMT" "$KP_FRONT_TAG")"
else
  git_tag="$(git -C "$REPO_ROOT" describe --tags --exact-match 2>/dev/null || true)"
  case "$git_tag" in
    v[0-9]*)
      KP_FRONT_TAG="${git_tag#v}"
      info "$(sayf "$T_TAG_PINNED_FMT" "$KP_FRONT_TAG" "$git_tag")"
      ;;
    *)
      KP_FRONT_TAG="latest"
      info "$T_TAG_LATEST"
      ;;
  esac
fi

# ── question 3: the backup schedule ──
# Asked here with the others and acted on in §6, once there is a stack worth backing up. Every
# decision before the wait; nothing to answer after it.
ask_backup_cron

# ─── 4. write the configuration ───────────────────────────────────────────────────────────

step "$T_STEP_WRITE"

kp_generate_env ".env.example" "$ENV_FILE"        # the four secrets — scripts/init-env.sh
kp_env_set KP_FRONT_TAG "$KP_FRONT_TAG" "$ENV_FILE"
kp_env_set APP_PORT "$PORT" "$ENV_FILE"
kp_env_set APP_BIND "$APP_BIND" "$ENV_FILE"
kp_env_set COOKIE_SECURE "$COOKIE_SECURE" "$ENV_FILE"
kp_env_set DOMAIN "$DOMAIN" "$ENV_FILE"
kp_env_set PUBLIC_URL "$PUBLIC_URL" "$ENV_FILE"

# Integration credentials are NOT written here. The Web Push pair is minted in §6 into the
# encrypted credential store once the app answers; the rest are set deliberately in /admin.
ok "$(sayf "$T_WROTE_FMT" "$ENV_FILE")"

if [[ "$BUILD" -eq 1 ]]; then
  if [[ -e docker-compose.override.yml ]]; then
    info "$T_OVERRIDE_EXISTS"
  elif [[ -f docker-compose.override.yml.example ]]; then
    cp docker-compose.override.yml.example docker-compose.override.yml
    info "$T_OVERRIDE_WROTE"
  else
    die "$T_ERR_NO_OVERRIDE_EXAMPLE"
  fi
fi

[[ "$ENV_FILE" == ".env" ]] || COMPOSE_ARGS+=(--env-file "$ENV_FILE")
[[ "$USE_TLS_PROFILE" -eq 0 ]] || COMPOSE_ARGS+=(--profile tls)

if [[ "$NO_START" -eq 1 ]]; then
  step "$T_STEP_DONE"
  info "docker compose ${COMPOSE_ARGS[*]-} up -d"
  # An answered question whose answer is silently dropped is worse than one never asked.
  [[ "$BACKUP_CRON" != "yes" ]] || say "$(sayf "$T_BACKUP_NO_START_FMT")"
  say "$T_CREDS_NO_START"
  exit 0
fi

# ─── 5. start, and wait for /ready with something to look at ──────────────────────────────

step "$T_STEP_START"
if [[ "$BUILD" -eq 1 ]]; then say "$T_BUILDING"; else say "$T_STARTING"; fi

UP_LOG="$(mktemp)"
trap 'rm -f "$UP_LOG"' EXIT

up_args=(up -d)
[[ "$BUILD" -eq 0 ]] || up_args+=(--build)

# Which build this is, for a build that has no release number to give. `/health` reports the
# version baked into the code, so a source build of an unreleased tree answers «0.6.0» — the same
# string a published image of that tag gives — and «is this even my code?» becomes unanswerable.
# The commit is what separates them, and `.git` is dockerignored, so the image cannot look it up:
# it arrives as a build arg (docker-compose.override.yml.example · build.args reads both of these
# out of the environment). Without git metadata — a tarball, a shallow export — they stay empty
# and the image reports «dev», exactly as it did before.
if [[ "$BUILD" -eq 1 ]]; then
  GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  export GIT_SHA BUILD_TIME
fi

# The failure diagnosis lives in scripts/lib.sh (kp_diagnose), which reads PORT, ENV_FILE,
# TIMEOUT and UP_LOG — all set above. scripts/doctor.sh calls the same function on a host that
# was installed months ago, so a hint fixed here is fixed there.
diagnose() { kp_diagnose "$1"; exit 1; }

if ! run_with_progress "${up_args[@]}"; then
  tail -20 "$UP_LOG" >&2
  diagnose "up"
fi

READY_URL="http://127.0.0.1:${PORT}/ready"
sayf "$T_WAIT_FMT" "$READY_URL"

SECONDS=0
i=0; last_rc=2
while ((SECONDS < TIMEOUT)); do
  last_rc=0
  probe_ready "$READY_URL" || last_rc=$?
  if [[ "$last_rc" -eq 0 ]]; then break; fi
  i=$(((i + 1) % 4))
  if [[ -t 1 ]]; then
    # \r keeps it on one line: two minutes of silence reads as a hang, a moving counter doesn't.
    printf '\r%s' "$(sayf "$T_WAIT_PROGRESS_FMT" "${SPIN:$i:1}" "$SECONDS" "$TIMEOUT")"
  elif ((SECONDS % 30 < 2)); then
    # Piped into a log: \r would smear the whole wait onto one unreadable line.
    sayf "$T_WAIT_PROGRESS_FMT" "·" "$SECONDS" "$TIMEOUT"
  fi
  sleep 2
done
[[ -t 1 ]] && printf '\r%*s\r' 70 '' || true

if [[ "$last_rc" -ne 0 ]]; then
  if [[ "$last_rc" -eq 1 ]]; then diagnose "notready"; else diagnose "noanswer"; fi
fi
READY_SECONDS=$SECONDS   # roster_count() below takes up to 5s of its own — don't bill it here

# /ready being green does NOT mean anyone can log in — see roster_count() above. The check has
# always run; it just said NOTHING when it passed, so the operator ran the same two requests by
# hand afterwards to find out whether it had. The success line below names what was verified.
ACCOUNTS="?"
if [[ "$(grep -E '^SEED_DATABASE=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)" != "false" ]]; then
  ACCOUNTS="$(roster_count "$PORT")"
  if [[ "$ACCOUNTS" == "0" ]]; then
    printf '\n%s%s%s\n\n' "$C_ERR" "$T_DIAG_HEADER" "$C_0"
    sayf "$T_DIAG_NO_ACCOUNTS_FMT" "$ENV_FILE"
    say ""; say "$T_DIAG_LOGS"
    compose logs --tail 20 app 2>/dev/null || true
    say ""; say "$T_DIAG_FOOTER"
    exit 1
  fi
fi

# «?» is roster_count() saying it could not tell (no curl/wget on this host), and SEED_DATABASE=
# false is a deliberate skip. Claiming a verified login screen in either case would be the same
# silent lie in the other direction.
if [[ "$ACCOUNTS" =~ ^[0-9]+$ ]]; then
  ok "$(sayf "$T_READY_ROSTER_FMT" "$READY_SECONDS" "$ACCOUNTS")"
else
  ok "$(sayf "$T_READY_FMT" "$READY_SECONDS")"
fi

# ─── 6. Web Push, now that the app can be talked to ───────────────────────────────────────
#
# After /ready rather than before it, because these go into the DATABASE: the store needs a
# migrated schema and a reachable database, which is exactly what /ready has just proved. It
# also removes the container recreate the old .env path needed — a stored credential reaches
# its consumer on the next request, not the next restart.

step "$T_STEP_CREDS"
seed_credentials || true

# ─── 7. the backup schedule, now that there is something to back up ───────────────────────

step "$T_STEP_BACKUP"
apply_backup_cron

# ─── 8. what the operator must do next ────────────────────────────────────────────────────

step "$T_STEP_DONE"

URL="$(app_url)"

sayf "$T_DONE_URL_FMT" "$URL"
sayf "$T_DONE_LOGIN_FMT" "$KP_SEED_PIN"
sayf "$T_DONE_ADMIN_FMT" "$KP_ADMIN_SECRET"
say ""
sayf "$T_DONE_BACKUP_FMT" "$ENV_FILE"
if [[ -n "$DOMAIN" ]]; then
  say ""
  sayf "$T_DONE_DNS_FMT" "$DOMAIN"
fi
if [[ "$KP_FRONT_TAG" == "latest" && "$BUILD" -eq 0 ]]; then
  say ""
  say "$T_DONE_LATEST"
fi
say ""
say "$T_DONE_COMMANDS"

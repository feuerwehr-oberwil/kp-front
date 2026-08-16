#!/usr/bin/env bash
# Create a deployment .env from .env.example with strong secrets pre-filled.
#
# Fills POSTGRES_PASSWORD, SECRET_KEY, ADMIN_SECRET and SEED_PIN (six digits) so a
# self-hoster doesn't have to generate them by hand — and so the first boot actually creates
# an account to log in with. Refuses to clobber an existing .env (your secrets must stay stable).
#
#   ./scripts/init-env.sh            # writes ./.env from ./.env.example
#   just init-env                    # same, via the task runner
#   KP_ENV_FILE=/tmp/x.env ./scripts/init-env.sh    # write somewhere else (testing)
#
# This is the PLAIN, non-interactive path: it asks nothing and decides nothing — you review
# the resulting .env yourself (DOMAIN, APP_PORT, COOKIE_SECURE, KP_FRONT_TAG) and start the
# stack yourself. If you want to be walked through those decisions instead, run
# `./scripts/setup.sh` — the guided installer, which SOURCES this file rather than repeating
# it, so there is exactly one implementation of "generate the secrets and write the .env".
# Everything below `--- library ---` is that shared implementation.
set -euo pipefail

# --- library (also sourced by scripts/setup.sh) -------------------------------------------

# Random hex string, <bytes> bytes wide.
#
# openssl is the good path, but a minimal Debian netinst genuinely does not have it and
# "apt-get install openssl first" is not a setup step worth owning — /dev/urandom via od
# (coreutils, always present) is the same randomness.
kp_rand_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  elif [[ -r /dev/urandom ]]; then
    LC_ALL=C od -An -tx1 -N "$bytes" /dev/urandom | tr -d ' \n'
  else
    echo "ERROR: no openssl and no readable /dev/urandom — cannot generate secrets." >&2
    return 1
  fi
}

# Print a six-digit SEED_PIN the backend will accept.
#
# ⚠️ Six digits because that is what the PIN pad takes (settings.pin_length), and a leading
# zero is fine — hence printf rather than arithmetic. The exclusion list is
# backend/app/auth/security.py · TRIVIAL_PINS verbatim: resolve_seed_pin() RAISES on those,
# seeding runs outside any try/except in main.py, so a rejected PIN is not a weak login — it is
# a container that exits on boot and restart-loops. Keep the two lists in sync — a test does
# check it (backend/tests/test_seed_pin.py · test_init_env_excludes_exactly_the_backends_list).
kp_gen_seed_pin() {
  local pin
  while :; do
    pin="$(printf '%06d' "$(( 16#$(kp_rand_hex 3) % 1000000 ))")"
    case "$pin" in
      000000|111111|123456|654321|999999|012345) continue ;;
      *) printf '%s\n' "$pin"; return 0 ;;
    esac
  done
}

# kp_env_set KEY VALUE FILE — set (or add) one KEY=VALUE line in an env file.
#
# Rewrites the whole line, commented-out ones included, so `# SEED_PIN=` in the template
# becomes a real assignment. VALUE must not contain `|`, `&` or a backslash: callers pass
# hex, digits, hostnames and true/false, all validated upstream.
kp_env_set() {
  local key="$1" value="$2" file="$3"
  if grep -qE "^#? *${key}=" "$file"; then
    sed -i.bak -E "s|^#? *${key}=.*|${key}=${value}|" "$file"
    rm -f "${file}.bak"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

# kp_generate_env EXAMPLE TARGET — copy the template and fill the four required secrets.
#
# Exports the two the operator has to be told about (KP_ADMIN_SECRET, KP_SEED_PIN) so the
# caller can print them; nothing else ever shows them again. Refuses an existing TARGET:
# regenerating SECRET_KEY over a live deployment invalidates every PIN in the database.
kp_generate_env() {
  local example="$1" target="$2"
  if [[ ! -f "$example" ]]; then
    echo "ERROR: $example not found (run from the repo root)." >&2
    return 1
  fi
  if [[ -e "$target" ]]; then
    echo "ERROR: $target already exists — refusing to overwrite (keep your secrets stable)." >&2
    echo "       Delete it first if you really want a fresh one." >&2
    return 1
  fi

  cp "$example" "$target"
  chmod 600 "$target"   # it holds every secret this deployment has

  KP_ADMIN_SECRET="$(kp_rand_hex 24)"
  KP_SEED_PIN="$(kp_gen_seed_pin)"
  kp_env_set POSTGRES_PASSWORD "$(kp_rand_hex 16)" "$target"
  kp_env_set SECRET_KEY "$(kp_rand_hex 32)" "$target"
  kp_env_set ADMIN_SECRET "$KP_ADMIN_SECRET" "$target"
  kp_env_set SEED_PIN "$KP_SEED_PIN" "$target"
}

# --- plain (non-interactive) entry point --------------------------------------------------

kp_init_env_main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."   # repo root

  local target="${KP_ENV_FILE:-.env}"
  kp_generate_env ".env.example" "$target"

  echo "✓ Wrote $target with generated secrets:"
  echo "    POSTGRES_PASSWORD  (random)"
  echo "    SECRET_KEY         (signs JWTs + peppers PINs — KEEP STABLE)"
  echo "    ADMIN_SECRET       (unlocks /admin — note it somewhere safe)"
  echo "    SEED_PIN           (the PIN of the first account — change it after signing in)"
  echo ""
  echo "Write these two down NOW — nothing shows them again:"
  echo "    ADMIN_SECRET (unlocks /admin):   ${KP_ADMIN_SECRET}"
  # Not "user fu": that username is in the database and on NO screen. The login screen shows
  # person tiles labelled with display_name (backend/app/seed_users.json → "Führungsunter-
  # stützung") and the login API wants that account's UUID, so an operator told to log in as
  # "fu" has been handed a dead end. Name what is on the tile.
  echo "    SEED_PIN     (first login – tap «Führungsunterstützung»): ${KP_SEED_PIN}"
  echo ""
  echo "Next: review $target (DOMAIN, APP_PORT, COOKIE_SECURE, KP_FRONT_TAG), then"
  echo "      'docker compose up -d'.  Or let ./scripts/setup.sh decide those with you."
}

# Sourced by scripts/setup.sh → definitions only. Run directly → do the thing.
if [[ "${BASH_SOURCE[0]:-$0}" == "${0}" ]]; then
  kp_init_env_main "$@"
fi

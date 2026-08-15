#!/usr/bin/env bash
# Create a deployment .env from .env.example with strong secrets pre-filled.
#
# Fills POSTGRES_PASSWORD, SECRET_KEY (openssl rand -hex 32), ADMIN_SECRET
# (openssl rand -hex 24) and SEED_PIN (six digits) so a self-hoster doesn't have to
# generate them by hand — and so the first boot actually creates an account to log in with.
# Refuses to clobber an existing .env (your secrets must stay stable).
#
#   ./scripts/init-env.sh            # writes ./.env from ./.env.example
#   just init-env                    # same, via the task runner
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

EXAMPLE=".env.example"
TARGET=".env"

if [[ ! -f "$EXAMPLE" ]]; then
  echo "ERROR: $EXAMPLE not found (run from the repo root)." >&2
  exit 1
fi
if [[ -f "$TARGET" ]]; then
  echo "ERROR: $TARGET already exists — refusing to overwrite (keep your secrets stable)." >&2
  echo "       Delete it first if you really want a fresh one." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl not found — needed to generate secrets." >&2
  exit 1
fi

POSTGRES_PASSWORD="$(openssl rand -hex 16)"
SECRET_KEY="$(openssl rand -hex 32)"
ADMIN_SECRET="$(openssl rand -hex 24)"
# ⚠️ SEED_PIN too, or the first boot creates NO ACCOUNTS AT ALL. In production the seeding
# refuses to fall back to the seed file's public PIN (backend/app/seed.py), so leaving this
# blank means the stack comes up green, /ready says ok — and the login screen has nobody on
# it. Six digits because that is what the PIN pad takes; a leading zero is fine, hence the
# printf rather than arithmetic.
# …and never one of the PINs the backend refuses as publicly-known (seed.py · _TRIVIAL_PINS),
# which would land us straight back in the no-accounts case this generation exists to prevent.
while :; do
  SEED_PIN="$(printf '%06d' "$((0x$(openssl rand -hex 3) % 1000000))")"
  case "$SEED_PIN" in
    000000|111111|123456|654321|999999|012345) continue ;;
    *) break ;;
  esac
done

cp "$EXAMPLE" "$TARGET"
# Replace each KEY=... line wholesale. Values are hex, so no sed metacharacters to escape.
sed -i.bak -E "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" "$TARGET"
sed -i.bak -E "s|^SECRET_KEY=.*|SECRET_KEY=${SECRET_KEY}|" "$TARGET"
sed -i.bak -E "s|^ADMIN_SECRET=.*|ADMIN_SECRET=${ADMIN_SECRET}|" "$TARGET"
sed -i.bak -E "s|^#? *SEED_PIN=.*|SEED_PIN=${SEED_PIN}|" "$TARGET"
rm -f "${TARGET}.bak"

echo "✓ Wrote $TARGET with generated secrets:"
echo "    POSTGRES_PASSWORD  (random)"
echo "    SECRET_KEY         (signs JWTs + peppers PINs — KEEP STABLE)"
echo "    ADMIN_SECRET       (unlocks /admin — note it somewhere safe)"
echo "    SEED_PIN           (the PIN of the first account — change it after signing in)"
echo ""
echo "Write these two down NOW — nothing shows them again:"
echo "    ADMIN_SECRET (unlocks /admin):   ${ADMIN_SECRET}"
echo "    SEED_PIN     (first login, user 'fu'): ${SEED_PIN}"
echo ""
echo "Next: review $TARGET (DOMAIN, integrations), then 'docker compose up -d --build'."

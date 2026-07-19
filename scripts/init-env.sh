#!/usr/bin/env bash
# Create a deployment .env from .env.example with strong secrets pre-filled.
#
# Fills POSTGRES_PASSWORD, SECRET_KEY (openssl rand -hex 32) and ADMIN_SECRET
# (openssl rand -hex 24) so a self-hoster doesn't have to generate them by hand.
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

cp "$EXAMPLE" "$TARGET"
# Replace each KEY=... line wholesale. Values are hex, so no sed metacharacters to escape.
sed -i.bak -E "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" "$TARGET"
sed -i.bak -E "s|^SECRET_KEY=.*|SECRET_KEY=${SECRET_KEY}|" "$TARGET"
sed -i.bak -E "s|^ADMIN_SECRET=.*|ADMIN_SECRET=${ADMIN_SECRET}|" "$TARGET"
rm -f "${TARGET}.bak"

echo "✓ Wrote $TARGET with generated secrets:"
echo "    POSTGRES_PASSWORD  (random)"
echo "    SECRET_KEY         (signs JWTs + peppers PINs — KEEP STABLE)"
echo "    ADMIN_SECRET       (unlocks /admin — note it somewhere safe)"
echo ""
echo "Your ADMIN_SECRET (you'll need it to log into /admin):"
echo "    ${ADMIN_SECRET}"
echo ""
echo "Next: review $TARGET (DOMAIN, integrations), then 'docker compose up -d --build'."

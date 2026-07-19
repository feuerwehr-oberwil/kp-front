#!/usr/bin/env bash
# Reset the DEMO deployment to a clean, known state. Wipes incident data + roster, re-ensures
# the two demo accounts, and reloads the synthetic Musterdorf config/geodata/objects.
#
# Required env (the demo instance's values):
#   DATABASE_URL      demo Postgres URL (the PUBLIC proxy URL when run off-box)
#   SECRET_KEY        demo SECRET_KEY — MUST match the server's, or the PIN hashes this
#                     writes won't verify (PINs are peppered with SECRET_KEY).
#   KP_BASE_URL       demo app URL, e.g. https://kp-front-demo-production.up.railway.app
#   KP_ADMIN_SECRET   demo ADMIN_SECRET (for admin_geodata/admin_objects push)
#
# DEMO ONLY — demo_reset gates on KP_DEMO_RESET=1 so it can't hit a real station's DB.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
cd backend

: "${DATABASE_URL:?set DATABASE_URL to the demo database}"
: "${SECRET_KEY:?set SECRET_KEY to the demo SECRET_KEY (peppers the PIN hashes)}"
: "${KP_BASE_URL:?set KP_BASE_URL to the demo app URL}"
: "${KP_ADMIN_SECRET:?set KP_ADMIN_SECRET to the demo admin secret}"

echo "→ 1/4  wipe incidents + roster, re-ensure demo accounts"
KP_DEMO_RESET=1 uv run python -m app.demo_reset

echo "→ 2/4  reload deployment config"
uv run python -m app.admin_config load "$ROOT/examples/demo-data/config.json"

echo "→ 3/4  reload reference geodata (hydrants) via API push"
uv run python -m app.admin_geodata push "$ROOT/examples/demo-data/geodata.manifest.json"

echo "→ 4/4  reload Einsatzobjekte via API push"
uv run python -m app.admin_objects push "$ROOT/examples/demo-data/objects.manifest.json"

echo "✓ Demo reset complete."

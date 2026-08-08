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

# ⚠️ The three HTTP steps below talk to a RUNNING app, and the nightly cron fires whenever it
# fires — including while Railway is mid-redeploy, when the edge answers 502. On 08.08. that
# killed a reset between «config loaded» and «geodata/logo re-pushed». `admin_config load` no
# longer strips what these steps restore (app/admin_config · _RUNTIME_SECTIONS), so a lost run
# is survivable now; retrying means it usually is not lost at all.
retry() {
  local n=1
  until "$@"; do
    if [ "$n" -ge 3 ]; then
      echo "FAILED after $n attempts: $*" >&2
      return 1
    fi
    echo "   … attempt $n failed (the app may be redeploying) — retrying in 20s" >&2
    n=$((n + 1))
    sleep 20
  done
}

echo "→ 1/5  wipe incidents + roster, re-ensure demo accounts"
KP_DEMO_RESET=1 uv run python -m app.demo_reset

echo "→ 2/5  reload deployment config"
uv run python -m app.admin_config load "$ROOT/examples/demo-data/config.json"

echo "→ 3/5  reload reference geodata (hydrants) via API push"
retry uv run python -m app.admin_geodata push "$ROOT/examples/demo-data/geodata.manifest.json"

echo "→ 4/5  reload Einsatzobjekte via API push"
retry uv run python -m app.admin_objects push "$ROOT/examples/demo-data/objects.manifest.json"

# AFTER admin_config load, never before: that step rewrites identity.assets wholesale, so a
# logo pushed earlier would be wiped by the same reset that is supposed to install it.
#
# BOTH slots, from the same file: `reportLogo` is the letterhead of the printed Einsatzrapport,
# `logo` is the mark on the login screen and in the header. Only reportLogo was pushed here, so
# the demo has been running without a brandmark on screen — and config.json deliberately names
# NO asset URLs, because these two pushes are the only thing that creates the blobs behind them.
echo "→ 5/5  reload the Brandmark (Login-Screen + Rapport-Briefkopf)"
retry uv run python -m app.admin_branding push logo "$ROOT/examples/demo-data/report-logo.png"
retry uv run python -m app.admin_branding push reportLogo "$ROOT/examples/demo-data/report-logo.png"

echo "✓ Demo reset complete."

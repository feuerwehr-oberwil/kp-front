#!/usr/bin/env bash
# Load the synthetic Musterdorf demo dataset into a deployment's database:
# deployment config + the station brandmark + a hydrant/water reference layer + the Schloss
# Musterdorf Einsatzobjekt with synthetic module PDFs + demo checklists (an action list +
# tactical Stichworte).
#
#   just demo-load                      # against the local dev DB (needs 'just db' running)
#   DATABASE_URL=... bash examples/demo-data/load.sh   # against another DB
#
# Idempotent: config is a singleton, objects/checklists upsert by stable id, geodata re-uploads
# in place. Safe for an empty/fresh instance — this is exactly the empty-state → populated path.
set -euo pipefail

cd "$(dirname "$0")"          # examples/demo-data
HERE="$(pwd)"
cd ../../backend             # the admin CLIs run from backend/

echo "→ 1/6  deployment config"
uv run python -m app.admin_config load "$HERE/config.json"

# ⚠️ AFTER the config, never before: `admin_config load` replaces the whole document, and
# identity.assets is part of it. config.json names these two URLs, so the nightly demo reset
# keeps pointing at the blobs this step writes (stable, slot-derived keys — see admin_branding).
# Without it the demo ran with no brandmark at all: no logo on the login screen, and the printed
# Einsatzrapport had no letterhead.
echo "→ 2/6  Brandmark (Login-Screen + Rapport-Briefkopf)"
uv run python -m app.admin_branding load logo "$HERE/report-logo.png"
uv run python -m app.admin_branding load reportLogo "$HERE/report-logo.png"

echo "→ 3/6  reference geodata (water mains + hydrants)"
uv run python -m app.admin_geodata load "$HERE/geodata.manifest.json"

echo "→ 4/6  Einsatzobjekt + synthetic Modul-PDFs"
uv run python -m app.admin_objects load "$HERE/objects.manifest.json"

echo "→ 5/6  Checklisten (Aufgaben FU + Taktik-Stichworte)"
uv run python -m app.admin_checklists load "$HERE/checklists.manifest.json"

# Additive, never destructive — a Divera-synced roster just gains the demo names.
echo "→ 6/6  Mannschaft (synthetic crew, so Anwesenheit/Schichtenplanung have people)"
uv run python -m app.seed_personnel

echo ""
echo "✓ Demo data loaded — reference data and crew, no incident and no pending alarm."
echo "  Start the app ('just dev') and open an incident near Schloss Musterdorf: water mains,"
echo "  hydrants, object plans, and Checklisten will be available."

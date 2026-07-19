#!/usr/bin/env bash
# Load the synthetic Musterdorf demo dataset into a deployment's database:
# deployment config + a hydrant/water reference layer + the Schloss Musterdorf Einsatzobjekt
# with synthetic module PDFs + demo checklists (an action list + tactical Stichworte).
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

echo "→ 1/4  deployment config"
uv run python -m app.admin_config load "$HERE/config.json"

echo "→ 2/4  reference geodata (water mains + hydrants)"
uv run python -m app.admin_geodata load "$HERE/geodata.manifest.json"

echo "→ 3/4  Einsatzobjekt + synthetic Modul-PDFs"
uv run python -m app.admin_objects load "$HERE/objects.manifest.json"

echo "→ 4/4  Checklisten (Aufgaben FU + Taktik-Stichworte)"
uv run python -m app.admin_checklists load "$HERE/checklists.manifest.json"

echo ""
echo "✓ Demo data loaded. Start the app (just api + just dev) and open an incident near"
echo "  Schloss Musterdorf — water mains, hydrants, object plans, and Checklisten will be available."

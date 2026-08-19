# KP Front — task runner.  Run `just` (or `just --list`) to see everything.
# Frontend: pnpm + Vite.  Backend: uv + FastAPI + Postgres.  Most recipes are thin
# wrappers over the underlying tools — see README.md / docs/DEPLOYMENT.md for context.
#
# Three conventions worth knowing before you edit this file:
#   · `[group('…')]` is what puts a recipe under a heading in `just --list` — a comment
#     banner would only be visible in this file, not in the listing.
#   · `just --list` shows the LAST comment line above a recipe — keep the summary there and
#     put the caveats in the lines above it.
#   · File arguments go through `absolute_path()`, so paths are relative to where YOU are,
#     not to the backend/ directory the admin CLIs run from.

# Dev backend port. NOT 8000: that one is usually taken by a local kp-rueck, and a silent
# port clash sends the frontend's /api calls to the wrong app. Override: `just api_port=8000 dev`.
api_port := "8001"
api_url := "http://localhost:" + api_port

default:
    @just --list --unsorted

# --- Setup -------------------------------------------------------------------

# (A DEVELOPER machine: needs pnpm and uv. This is not the self-host path — a station server
# has neither, and never runs `just` at all. That path is `self-host` below, which is plain
# bash + docker on purpose.)
# Install ALL deps (frontend + backend) — run this once after cloning.
[group('Setup')]
setup:
    pnpm install
    cd backend && uv sync --extra dev
    @echo "\033[1;32m✓ Setup complete. Next: 'just demo-load' (demo data), then 'just dev' (db + backend + frontend).\033[0m"

# (The real entry point is `bash scripts/setup.sh` — this recipe is only here so a developer
# who lives in `just --list` can find it. It asks for the domain and the port and decides the
# things people get wrong from those two answers: COOKIE_SECURE, the tls profile, a free
# APP_PORT, KP_FRONT_TAG, and all four secrets. Pass flags through: `just self-host --build`,
# `just self-host --yes --lan`.)
# Guided first-run install of a station server — asks three questions, then starts the stack.
[group('Setup')]
self-host *args:
    bash scripts/setup.sh {{args}}

# (The non-interactive half of `self-host`, and the same code: it generates the secrets and
# stops. Nothing is asked, nothing is started — you set DOMAIN / APP_PORT / APP_BIND /
# COOKIE_SECURE / KP_FRONT_TAG in the .env yourself and run `docker compose up -d`.)
# Generate a deployment .env with all four required secrets (POSTGRES_PASSWORD / SECRET_KEY / ADMIN_SECRET / SEED_PIN).
[group('Setup')]
init-env:
    bash scripts/init-env.sh

# --- Operations  (the scripts a station runs; `just` is never required for them) ----

# (Read-only: it starts and stops nothing. Walks host → stack → app → backups and names the
# fix for each thing it finds, using the same diagnosis `setup.sh` prints on a failed install —
# one implementation, in scripts/lib.sh. A station runs `bash scripts/doctor.sh` directly.)
# Check a deployment and say what is wrong with it, in plain language.
[group('Operations')]
doctor *args:
    bash scripts/doctor.sh {{args}}

# (⚠️ DESTRUCTIVE — it drops the schema and refills the asset volume. Confirmation is the typed
# word `restore`, not y/N. Restores the database and the storage volume TOGETHER, because a
# database restored against a mismatched volume leaves media rows pointing at blobs that are not
# there. `--dry-run` first – it restores nothing, but it does START the db container to read what
# it would replace, so it is not read-only on a stopped stack. Deliberately a script and never a
# button: you need it when the app is down.)
# Restore a deployment from a backup pair — run the drill once before you rely on it.
[group('Operations')]
restore *args:
    bash scripts/restore.sh {{args}}

# --- Development -------------------------------------------------------------

# THE dev command: Postgres + backend + frontend in one terminal (Ctrl+C stops all).
[group('Development')]
dev: db migrate
    #!/usr/bin/env bash
    set -euo pipefail
    printf '\033[1;34m→ API  http://localhost:%s   ·   App  http://localhost:5188  (Ctrl+C stops both)\033[0m\n' '{{api_port}}'
    # PINs are peppered with SECRET_KEY (app/auth/security.py), so the dev backend must run
    # under the SAME key the dev DB's users were hashed with — the one in the root .env.
    # ONLY that var: the rest of .env is the docker deployment's config (real Divera/Traccar
    # keys, telemetry) and must not leak into a dev server. Without it every boot mints a
    # throwaway key and every login answers «Falsche PIN».
    (cd backend && SECRET_KEY="$(grep -m1 '^SECRET_KEY=' ../.env 2>/dev/null | cut -d= -f2- || true)" uv run uvicorn app.main:app --reload --port {{api_port}}) &
    api=$!
    # Ctrl+C reaches both directly (same process group). The trap covers the other exit paths —
    # vite crashing or being quit leaves nothing holding {{api_port}}. `uv run` passes the
    # signal on to uvicorn, and the database is a container: it stays up until 'just db-stop'.
    trap 'kill $api 2>/dev/null' EXIT
    # Vite in the foreground, so quitting it ends the recipe (and the trap takes the backend down).
    VITE_API_PROXY='{{api_url}}' pnpm dev

# Start the dev Postgres (docker-compose.dev.yml, localhost:5434) — waits until it's healthy.
[group('Development')]
db:
    docker compose -f docker-compose.dev.yml up -d --wait
    @echo "\033[1;32m✓ Dev Postgres on localhost:5434\033[0m"

# Stop the dev Postgres (keeps the data volume).
[group('Development')]
db-stop:
    docker compose -f docker-compose.dev.yml stop

# Wipe the dev Postgres volume and restart fresh — an empty database, no schema.
[group('Development')]
db-reset:
    docker compose -f docker-compose.dev.yml down -v
    docker compose -f docker-compose.dev.yml up -d --wait
    @echo "\033[1;32m✓ Fresh dev Postgres — rebuild with 'just migrate' (schema) or 'just demo-load' (schema + demo data).\033[0m"

# Apply database migrations (alembic upgrade head).
[group('Development')]
migrate:
    cd backend && uv run alembic upgrade head

# --- Demo & test data  (local dev DB — see examples/demo-data/README.md) ------

# The scenario `just scenario` replays when you don't name one (a variable, so the recipe
# signature stays short enough for `just --list` to keep its summary on one line).
demo_alarm := "examples/scenarios/zimmerbrand.json"

# (Starts the DB and migrates first, so this works on a fresh clone.)
# Load the Musterdorf demo dataset: config, geodata, Objekt, Checklisten, Mannschaft — no incident.
[group('Demo data')]
demo-load: db migrate
    bash examples/demo-data/load.sh

# (The dataset's config has demoMode ON — right for the public demo, but locally it shows the
# DEMO ribbon and blocks creating incidents. Re-run this after every 'just demo-load'.)
# Turn demo mode OFF in the local dev DB: no ribbon, no welcome, incidents can be created.
[group('Demo data')]
demo-off:
    docker compose -f docker-compose.dev.yml exec -T db psql -q -U kpfront -d kpfront -c \
      "update deployment_config set config_json = jsonb_set(config_json, '{identity,demoMode}', 'false') where id = 1;"
    @echo "\033[1;32m✓ Demo mode off (identity.demoMode = false)\033[0m"

# (Needs the dev backend running. Mints a fresh divera_id per run, so alarms never collide; it
# then waits for you to take the alarm before sending the times — Ctrl+C if you don't want them.)
# Inject a fake alarm through the real webhooks (default: the Zimmerbrand demo alarm).
[group('Demo data')]
scenario file=demo_alarm:
    cd backend && uv run python -m app.fake_scenario run "{{absolute_path(file)}}" --base {{api_url}}

# (Needs DATABASE_URL / SECRET_KEY / KP_BASE_URL / KP_ADMIN_SECRET set to the demo's values.)
# Reset a DEMO deployment: wipe incidents + roster, re-ensure accounts, reload data + demo incident.
[group('Demo data')]
demo-reset:
    bash scripts/demo-reset.sh

# --- Code quality  (run 'just ci' before pushing) -----------------------------

# (Mirrors .github/workflows/ci.yml. It exists because «lint + test» was NOT that set: a ruff
# FORMAT violation once passed locally and turned main red, because nothing here ran
# `ruff format --check`. The same thing then happened with `mypy`, which CI runs and this did
# not — so a fully green `just ci` still pushed a red main. And a third time with `pnpm build`,
# which is the ONLY step that parses CSS — `tsc` and `pnpm lint` never open a stylesheet, so a
# syntax error in one sailed through a green `just ci`. The landing page's drift check was
# missing for the same reason. And a FOURTH time, differently: this recipe ran pytest with no
# DATABASE_URL, so tests/conftest.py fell back to SQLite in-memory while ci.yml runs them
# against Postgres 16 — and SQLite does NOT abort a transaction on a statement error, which is
# the class of bug that difference hides. It now runs them where CI runs them, in their own
# database so nobody's dev data is dropped. Not covered — both need more than a container:
# the gitleaks scan and the image build.)
# Run everything CI would fail you on, before you push.
[group('Quality')]
ci: test-backend
    pnpm build
    node site/build.mjs --check
    pnpm test
    cd backend && uv run ruff format --check .
    cd backend && uv run ruff check .
    cd backend && uv run mypy app
    pnpm lint

# (Uses its OWN database on the dev Postgres — the suite creates and drops the schema, so
# pointing it at `kpfront` would take your dev data with it. `|| true` on the create: the
# second run is a duplicate-database error and that is the normal case.)
# Backend tests on Postgres, the way CI runs them (not the SQLite fallback).
[group('Quality')]
test-backend:
    docker compose -f docker-compose.dev.yml up -d --wait
    -docker compose -f docker-compose.dev.yml exec -T db psql -qU kpfront -d postgres \
      -c 'create database kpfront_test' 2>/dev/null
    cd backend && DATABASE_URL=postgresql+asyncpg://kpfront:kpfront@localhost:5434/kpfront_test \
      uv run pytest -q

# (Scope is CI's: `.`, not `app tests` — alembic/ is lint-clean too, and code CI checks but you
# don't is code that breaks on push rather than on save. Includes the format check.)
# Lint both stacks (eslint + ruff).
[group('Quality')]
lint:
    pnpm lint
    cd backend && uv run ruff format --check .
    cd backend && uv run ruff check .

# Test both stacks (vitest + pytest).
[group('Quality')]
test:
    pnpm test
    cd backend && uv run pytest -q

# Type-check the frontend without emitting.
[group('Quality')]
check:
    pnpm exec tsc --noEmit

# --- Build & release  (tag a green main commit — see CHANGELOG.md) ------------

# Type-check + production build (output: dist/).
[group('Release')]
build:
    pnpm build

# Dump the OpenAPI schema to docs/openapi.json (committed API contract).
[group('Release')]
openapi:
    cd backend && uv run python -m app.dump_openapi ../docs/openapi.json

# Regenerate the committed roster-snapshot contract (schemas + example). Run it in the same
# change that touches app/roster_snapshot.py, then update the checksums recorded in
# tests/test_roster_snapshot_contract.py AND in the kp-rueck copy. See docs/CONFIGURATION.md §4c.
[group('Release')]
roster-schema:
    cd backend && uv run python -m app.roster_snapshot schema > ../docs/roster-snapshot.schema.json
    cd backend && uv run python -m app.roster_snapshot outcome-schema > ../docs/roster-snapshot-outcome.schema.json
    cd backend && uv run python -m app.roster_snapshot example > roster.snapshot.example.json
    @shasum -a 256 docs/roster-snapshot.schema.json docs/roster-snapshot-outcome.schema.json

# (Needs no install — uvx fetches git-cliff. Add --tag vX.Y.Z to head it with a version.)
# Draft release notes from the commits since the last tag — a STARTING POINT: curate into CHANGELOG.md.
[group('Release')]
changelog:
    uvx git-cliff --unreleased

# Bump every version file + open the CHANGELOG section. Touches no git state — review the diff.
[group('Release')]
release version:
    python3 scripts/release.py {{version}}

# (Then: git push --follow-tags → CI gate → GHCR image + GitHub Release.)
# Commit the version bump and tag it. Stages ONLY the release files (this tree carries WIP).
[group('Release')]
release-tag version:
    git add package.json backend/pyproject.toml backend/uv.lock backend/app/config.py docs/openapi.json CHANGELOG.md
    git commit -m "chore(release): v{{version}}"
    git tag -a v{{version}} -m "v{{version}}"
    @echo "\033[1;32m✓ Tagged v{{version}}. Push with: git push --follow-tags\033[0m"

# --- Deployment config  (config-as-code — see docs/CONFIGURATION.md) ----------

# Pull the LIVE station config off a Railway deployment into a local file.
#
# ⚠️ The whole reason this exists: developing against the shipped defaults does not feel like
# the app the Wehr uses. Their Mittel catalogue, their Gruppen, their symbol lists and their
# Module are what make a screen look right or wrong, and a bug like «Stk» without a dot only
# shows up against real data.
#
# Read-only — it never writes to the deployment. `railway run` does NOT work for this: the
# DATABASE_URL it injects is the INTERNAL hostname and does not resolve from a laptop, so the
# public TCP proxy is read off the Postgres service instead.
#
# Pull a live deployment's config to a local file (read-only; via Railway's public Postgres proxy).
[group('Deployment config')]
config-pull out="backend/private/live.config.json" service="Postgres":
    @DB=$(railway variables --service {{service}} --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-); \
    test -n "$DB" || { echo "No DATABASE_PUBLIC_URL on service {{service}} — is the project linked?"; exit 1; }; \
    cd backend && DATABASE_URL="$DB" uv run python -m app.admin_config show > "{{absolute_path(out)}}"
    @echo "\033[1;32m✓ Live config → {{out}}\033[0m  (load it into your local DB with: just config-load {{out}})"

# Print a fully-populated example deployment config (starting point — copy & edit).
[group('Deployment config')]
config-example:
    cd backend && uv run python -m app.admin_config example

# Validate a config file (no DB needed).
[group('Deployment config')]
config-validate file:
    cd backend && uv run python -m app.admin_config validate "{{absolute_path(file)}}"

# Diff a config file against the deployment's stored config (needs DATABASE_URL).
[group('Deployment config')]
config-diff file:
    cd backend && uv run python -m app.admin_config diff "{{absolute_path(file)}}"

# ── load vs push ──────────────────────────────────────────────────────────────
# All five admin CLIs have both verbs and they are NOT interchangeable: `load` writes the
# database in DATABASE_URL plus this machine's storage (local dev, demo-reset), `push` goes
# through a running deployment's admin API so the server writes its own volume (a live
# station, from a workstation). Reach for `push` against anything real. Both take --dry-run:
# `just config-push file.json --dry-run`. Full comparison: docs/CONFIGURATION.md §9a.

# Load a config file into the deployment (needs DATABASE_URL).
[group('Deployment config')]
config-load file:
    cd backend && uv run python -m app.admin_config load "{{absolute_path(file)}}"

# Publish a config file to a RUNNING deployment via its API (KP_BASE_URL + KP_ADMIN_SECRET).
[group('Deployment config')]
config-push file *args:
    cd backend && uv run python -m app.admin_config push "{{absolute_path(file)}}" {{args}}

# Load a reference-geodata manifest (hydrants, WMS layers, …) into the deployment (DATABASE_URL).
[group('Deployment config')]
geodata-load file:
    cd backend && uv run python -m app.admin_geodata load "{{absolute_path(file)}}"

# Publish a reference-geodata manifest to a RUNNING deployment via its API.
[group('Deployment config')]
geodata-push file *args:
    cd backend && uv run python -m app.admin_geodata push "{{absolute_path(file)}}" {{args}}

# Load an object-plans manifest (Einsatzobjekte + Modul-PDFs) into the deployment (DATABASE_URL).
[group('Deployment config')]
objects-load file:
    cd backend && uv run python -m app.admin_objects load "{{absolute_path(file)}}"

# Publish an object-plans manifest (+ the PDFs) to a RUNNING deployment via its API.
[group('Deployment config')]
objects-push file *args:
    cd backend && uv run python -m app.admin_objects push "{{absolute_path(file)}}" {{args}}

# Load a checklist-templates manifest (+ diagram assets) into the deployment (DATABASE_URL).
[group('Deployment config')]
checklists-load file:
    cd backend && uv run python -m app.admin_checklists load "{{absolute_path(file)}}"

# Publish a checklist-templates manifest (+ diagram assets) to a RUNNING deployment via its API.
[group('Deployment config')]
checklists-push file *args:
    cd backend && uv run python -m app.admin_checklists push "{{absolute_path(file)}}" {{args}}

# (Slot is one of: logo | reportLogo | favicon | iconPng192 | iconPng512 – the last two are the
# installed PWA's home-screen icons and must be square PNGs of exactly that edge (or a larger
# square, up to 4×). Branding is the odd one out among the five CLIs – it has no
# schema/example/validate, because the payload is an image, not a document.)
# Load a branding asset into the deployment (DATABASE_URL + its blob store).
[group('Deployment config')]
branding-load slot file:
    cd backend && uv run python -m app.admin_branding load {{slot}} "{{absolute_path(file)}}"

# Publish a branding asset (logo | reportLogo | favicon | iconPng192 | iconPng512) to a RUNNING deployment.
[group('Deployment config')]
branding-push slot file *args:
    cd backend && uv run python -m app.admin_branding push {{slot}} "{{absolute_path(file)}}" {{args}}

# --- Symbol tooling ----------------------------------------------------------

# Run a symbol tool: just tool <script.py> [args...]
[group('Tools')]
tool script *args:
    cd tools && uv run python {{script}} {{args}}

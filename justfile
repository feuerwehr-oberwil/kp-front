# KP Front — task runner.  Run `just` (or `just --list`) to see everything.
# Frontend: pnpm + Vite.  Backend: uv + FastAPI + Postgres.  Most recipes are thin
# wrappers over the underlying tools — see README.md / docs/DEPLOYMENT.md for context.

default:
    @just --list --unsorted

# ============================================
# Setup
# ============================================

# Install ALL deps (frontend + backend) — run this once after cloning.
setup: install backend-install
    @echo "\033[1;32m✓ Setup complete. Next: 'just db' then 'just api' (backend), and 'just dev' (frontend).\033[0m"

# Install frontend deps (pnpm).
install:
    pnpm install

# Install backend deps (uv, incl. dev extras).
backend-install:
    cd backend && uv sync --extra dev

# Generate a deployment .env with strong secrets (POSTGRES_PASSWORD / SECRET_KEY / ADMIN_SECRET).
init-env:
    bash scripts/init-env.sh

# ============================================
# Development
# ============================================

# Frontend dev server with hot reload (http://localhost:5188). Runs standalone on demo data.
dev:
    @echo "\033[1;34m→ Vite dev server on http://localhost:5188 (Ctrl+C to stop)\033[0m"
    pnpm dev

# Alias for dev.
fe: dev

# Backend dev server (http://localhost:8000) — runs migrations first. Needs 'just db' running.
api: migrate
    @echo "\033[1;34m→ FastAPI (uvicorn --reload) on http://localhost:8000\033[0m"
    cd backend && uv run uvicorn app.main:app --reload --port 8000

# Start the dev Postgres (docker-compose.dev.yml, localhost:5434).
db:
    docker compose -f docker-compose.dev.yml up -d
    @echo "\033[1;32m✓ Dev Postgres on localhost:5434\033[0m"

# Stop the dev Postgres (keeps the data volume).
db-stop:
    docker compose -f docker-compose.dev.yml stop

# Wipe the dev Postgres volume and restart fresh (next 'just migrate' rebuilds the schema).
db-reset:
    docker compose -f docker-compose.dev.yml down -v
    docker compose -f docker-compose.dev.yml up -d
    @echo "\033[1;32m✓ Fresh dev Postgres on localhost:5434\033[0m"

# Apply database migrations (alembic upgrade head).
migrate:
    cd backend && uv run alembic upgrade head

# Seed the default editor user (idempotent; PIN/account from app/seed_users.json).
seed:
    cd backend && uv run python -m app.seed

# ============================================
# Code Quality  (run 'just lint && just test' before pushing)
# ============================================

# Lint both stacks.
lint: lint-fe lint-be
lint-fe:
    pnpm lint
lint-be:
    cd backend && uv run ruff check app tests

# Test both stacks.
test: test-fe test-be
test-fe:
    pnpm test
test-be:
    cd backend && uv run pytest -q

# Type-check the frontend without emitting.
check:
    pnpm exec tsc --noEmit

# ============================================
# Build
# ============================================

# Type-check + production build (output: dist/).
build:
    pnpm build

# Preview the production build (http://localhost:4173).
preview: build
    pnpm preview

# Dump the OpenAPI schema to docs/openapi.json (committed API contract).
openapi:
    cd backend && uv run python -m app.dump_openapi ../docs/openapi.json

# ============================================
# Deployment config  (config-as-code via the admin CLIs — see docs/CONFIGURATION.md)
# ============================================

# Print a fully-populated example deployment config (starting point — copy & edit).
config-example:
    cd backend && uv run python -m app.admin_config example

# Validate a config file (no DB needed).
config-validate file:
    cd backend && uv run python -m app.admin_config validate {{file}}

# Diff a config file against the deployment's stored config (needs DATABASE_URL).
config-diff file:
    cd backend && uv run python -m app.admin_config diff {{file}}

# Load a config file into the deployment (needs DATABASE_URL).
config-load file:
    cd backend && uv run python -m app.admin_config load {{file}}

# Validate / load a reference-geodata manifest (hydrants, WMS layers, …).
geodata-validate file:
    cd backend && uv run python -m app.admin_geodata validate {{file}}
geodata-load file:
    cd backend && uv run python -m app.admin_geodata load {{file}}

# Validate / load an object-plans manifest (Einsatzobjekte + Modul-PDFs).
objects-validate file:
    cd backend && uv run python -m app.admin_objects validate {{file}}
objects-load file:
    cd backend && uv run python -m app.admin_objects load {{file}}

# Load the synthetic Musterdorf demo dataset into the local dev DB (config + geodata + objects).
# Runs migrations first, so it works on a fresh 'just db'.
demo-load: migrate
    bash examples/demo-data/load.sh

# Reset a DEMO deployment: wipe incidents + roster, re-ensure demo accounts, reload demo data.
# Needs DATABASE_URL / KP_BASE_URL / KP_ADMIN_SECRET set to the demo instance's values.
demo-reset:
    bash scripts/demo-reset.sh

# ============================================
# Symbol Tooling (Python, via uv)
# ============================================

# Run a symbol tool: just tool <script.py> [args...]
tool script *args:
    cd tools && uv run python {{script}} {{args}}

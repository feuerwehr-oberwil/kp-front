#!/usr/bin/env bash
# Measure how a large / long Einsatz behaves — `just fat-perf [preset …]` (default: real large).
#
# Per preset, on a THROWAWAY stack (never the dev database): a fresh Postgres container, the
# built app served by the backend same-origin (production shape, no Vite dev mode), then
# e2e/fat-incident.perf.ts plays the fat incident in save by save and opens it on a throttled
# Chromium. Everything is torn down afterwards. Presets: src/lib/fatIncident.ts · FAT_PRESETS.
#
# Knobs: FAT_SAVES (saves actually sent, default 120), FAT_CPU (throttle, default 4),
# FAT_SKIP_BUILD=1 (reuse dist/), FAT_PORT / FAT_PG_PORT, E2E_PIN (default 000000 = dev seed).
# Chromium's system libraries missing (WSL without sudo)? Point LD_LIBRARY_PATH at them.
set -euo pipefail
cd "$(dirname "$0")/.."

presets=("$@")
[ ${#presets[@]} -gt 0 ] || presets=(real large)
port=${FAT_PORT:-8301}
pg_port=${FAT_PG_PORT:-55301}
pg=kp-fat-perf-$$
storage=$(mktemp -d)
api_pid=

cleanup() {
  # the backend runs in its own process group (setsid below): `uv run` does not pass a TERM on
  # to uvicorn, and a survivor would answer the next preset from the previous database
  if [ -n "$api_pid" ]; then
    kill -- -"$api_pid" 2>/dev/null || true
    while kill -0 -- -"$api_pid" 2>/dev/null; do sleep 0.2; done
  fi
  docker rm -f "$pg" >/dev/null 2>&1 || true
  rm -rf "$storage" "$storage.log"
}
trap cleanup EXIT

[ "${FAT_SKIP_BUILD:-}" = 1 ] || pnpm build >/dev/null

db_url="postgresql+asyncpg://kpfront:kpfront@localhost:${pg_port}/kpfront"
# a throwaway key per run — the seeded PIN is hashed with it, and nothing outlives the run
secret_key=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
for preset in "${presets[@]}"; do
  cleanup
  storage=$(mktemp -d)
  docker run -d --name "$pg" -e POSTGRES_USER=kpfront -e POSTGRES_PASSWORD=kpfront -e POSTGRES_DB=kpfront \
    -p "${pg_port}:5432" postgres:16-alpine >/dev/null
  until docker exec "$pg" pg_isready -U kpfront -q 2>/dev/null; do sleep 1; done
  sleep 1
  (cd backend && DATABASE_URL=$db_url uv run alembic upgrade head >/dev/null 2>&1)
  if curl -sf "localhost:${port}/health" >/dev/null; then echo "port ${port} is already taken — set FAT_PORT" >&2; exit 1; fi
  (cd backend && DATABASE_URL=$db_url MEDIA_STORAGE_DIR=$storage SPA_DIR=../dist \
    SECRET_KEY="$secret_key" \
    exec setsid uv run uvicorn app.main:app --port "$port" --log-level warning >"$storage.log" 2>&1) &
  api_pid=$!
  until curl -sf "localhost:${port}/health" >/dev/null; do sleep 1; done

  FAT_PRESET=$preset E2E_BASE_URL="http://localhost:${port}" E2E_PIN=${E2E_PIN:-000000} \
    pnpm exec playwright test --project=perf --reporter=line | grep -v '^\s*$' || true
  printf 'snapshot storage       %s on disk for the %s saves actually sent\n\n' \
    "$(du -sh "$storage" | cut -f1)" "${FAT_SAVES:-120}"
done

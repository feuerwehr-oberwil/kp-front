#!/usr/bin/env bash
# Shoot the screenshot regression states locally — `just visual [playwright args …]`, e.g.
# `just visual -g trupps`.
#
# A THROWAWAY stack (never the dev database): a fresh Postgres container and the built app served
# by the backend same-origin (production shape), then e2e/screens.visual.ts against
# e2e/visual/baseline/. Everything is torn down afterwards. CI's «Visual» job runs the same states
# against the production container (docs/testing/visual-regression.md).
#
# ⚠️ A local run is a look, not a verdict: the baselines are Linux Chromium on a GitHub runner,
# and another machine may anti-alias a glyph differently. A local run never writes a baseline
# over an existing one; a missing one is written so a new state can be looked at — commit the
# one CI shoots instead (`just visual-accept <run-id>`).
#
# Knobs: VISUAL_SKIP_BUILD=1 (reuse dist/), VISUAL_PORT / VISUAL_PG_PORT, E2E_PIN (default
# 000000 = dev seed). Chromium's system libraries missing (WSL without sudo)? Point
# LD_LIBRARY_PATH at them.
set -euo pipefail
cd "$(dirname "$0")/.."

port=${VISUAL_PORT:-8303}
pg_port=${VISUAL_PG_PORT:-55303}
pg=kp-visual-$$
storage=$(mktemp -d)
api_pid=

cleanup() {
  # the backend runs in its own process group (setsid below): `uv run` does not pass a TERM on
  if [ -n "$api_pid" ]; then
    kill -- -"$api_pid" 2>/dev/null || true
    while kill -0 -- -"$api_pid" 2>/dev/null; do sleep 0.2; done
  fi
  docker rm -f "$pg" >/dev/null 2>&1 || true
  rm -rf "$storage" "$storage.log"
}
trap cleanup EXIT

[ "${VISUAL_SKIP_BUILD:-}" = 1 ] || pnpm build >/dev/null

if curl -sf "localhost:${port}/health" >/dev/null; then echo "port ${port} is already taken — set VISUAL_PORT" >&2; exit 1; fi
db_url="postgresql+asyncpg://kpfront:kpfront@localhost:${pg_port}/kpfront"
secret_key=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
docker run -d --name "$pg" -e POSTGRES_USER=kpfront -e POSTGRES_PASSWORD=kpfront -e POSTGRES_DB=kpfront \
  -p "${pg_port}:5432" postgres:16-alpine -c fsync=off >/dev/null
until docker exec "$pg" pg_isready -U kpfront -q 2>/dev/null; do sleep 1; done
sleep 1
(cd backend && DATABASE_URL=$db_url uv run alembic upgrade head >/dev/null 2>&1)
(cd backend && DATABASE_URL=$db_url MEDIA_STORAGE_DIR=$storage SPA_DIR=../dist SECRET_KEY="$secret_key" \
  COOKIE_SECURE=false exec setsid uv run uvicorn app.main:app --port "$port" --log-level warning >"$storage.log" 2>&1) &
api_pid=$!
until curl -sf "localhost:${port}/health" >/dev/null; do sleep 1; done

rm -rf visual-results
set +e
VISUAL=1 E2E_BASE_URL="http://localhost:${port}" E2E_PIN=${E2E_PIN:-000000} PLAYWRIGHT_JSON_OUTPUT_NAME=visual-results/report.json \
  pnpm exec playwright test --project=visual --reporter=line,json "$@"
rc=$?
node scripts/visual-report.mjs visual-results/report.json visual-results
set -e
[ "$rc" = 0 ] || echo "✗ a state differs or broke — pictures in visual-results/ (diff/ marks the changed pixels)" >&2
exit "$rc"

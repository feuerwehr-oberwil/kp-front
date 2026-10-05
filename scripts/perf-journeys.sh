#!/usr/bin/env bash
# Walk the performance journeys locally — `just perf [playwright args …]`, e.g. `just perf -g idle`.
#
# A THROWAWAY stack (never the dev database): a fresh Postgres container and the built app served
# by the backend same-origin (production shape, no Vite dev mode), then e2e/journeys.journey.ts and
# the report against e2e/perf/baseline.json. Everything is torn down afterwards. CI's «Performance»
# job runs the same journeys against the production container (docs/testing/perf-journeys.md).
#
# ⚠️ A local run is a look, not a verdict: the baseline comes from a GitHub runner, and while the
# report scales its time budgets by the machine's speed, a loaded box (other sessions, a build)
# still skews every time. Counts and sizes compare as they are.
#
# Knobs: PERF_CPU (CPU throttle, default 1), PERF_SKIP_BUILD=1 (reuse dist/), PERF_PORT /
# PERF_PG_PORT, E2E_PIN (default 000000 = dev seed). Chromium's system libraries missing (WSL
# without sudo)? Point LD_LIBRARY_PATH at them.
set -euo pipefail
cd "$(dirname "$0")/.."

port=${PERF_PORT:-8302}
pg_port=${PERF_PG_PORT:-55302}
pg=kp-perf-journeys-$$
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

[ "${PERF_SKIP_BUILD:-}" = 1 ] || pnpm build >/dev/null

if curl -sf "localhost:${port}/health" >/dev/null; then echo "port ${port} is already taken — set PERF_PORT" >&2; exit 1; fi
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

rm -rf perf-results
set +e
PERF_JOURNEYS=1 PERF_OUT=perf-results/run1 E2E_BASE_URL="http://localhost:${port}" E2E_PIN=${E2E_PIN:-000000} \
  pnpm exec playwright test --project=journeys --reporter=line "$@"
rc=$?
node scripts/perf-report.mjs --summary /dev/null perf-results/run1
report=$?
set -e
[ "$rc" = 0 ] || echo "✗ a journey failed (playwright exit ${rc}) — its numbers are missing above" >&2
exit $(( rc || report ))

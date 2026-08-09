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

: "${DATABASE_URL:?set DATABASE_URL to the demo database}"
: "${SECRET_KEY:?set SECRET_KEY to the demo SECRET_KEY (peppers the PIN hashes)}"
: "${KP_BASE_URL:?set KP_BASE_URL to the demo app URL}"
: "${KP_ADMIN_SECRET:?set KP_ADMIN_SECRET to the demo admin secret}"

# ⚠️ PREFLIGHT: this script publishes whatever the tree it runs in happens to hold, and step 1
# WIPES before anything is re-pushed. Twice on 09.08. the demo was reset from an old checkout —
# the second time from v0.1.0 — which restored July's generated placeholder Objektpläne, a Modul 6
# retired the day before, and July's deployment config, quietly and with every step reporting OK.
# So the tree states which commit it is before it is allowed to touch the demo at all.
#
# Deliberately BEFORE step 1: refusing after the wipe would leave the demo empty, which is not
# "nothing happened".
#
# `git ls-remote` is read-only and writes nothing locally. Set KP_DEMO_RESET_ALLOW_STALE=1 to
# publish a tree that is not the published main on purpose (e.g. testing a branch against a
# throwaway deployment) — it prints what it is doing.
if [ "${KP_DEMO_RESET_ALLOW_STALE:-0}" = "1" ]; then
  echo "⚠ KP_DEMO_RESET_ALLOW_STALE=1 — publishing this tree without checking it against origin/main."
elif ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "✖ Not a git checkout — refusing: there is no way to tell whether this tree is current." >&2
  echo "✖ Run the 'Demo reset' workflow from main, or set KP_DEMO_RESET_ALLOW_STALE=1 to override." >&2
  exit 1
else
  head_sha="$(git -C "$ROOT" rev-parse HEAD)"
  main_sha="$(git -C "$ROOT" ls-remote origin refs/heads/main 2>/dev/null | cut -f1)"
  if [ -z "$main_sha" ]; then
    echo "✖ Could not read origin/main (network? remote?) — refusing rather than guessing." >&2
    echo "✖ Set KP_DEMO_RESET_ALLOW_STALE=1 to publish this tree anyway." >&2
    exit 1
  fi
  if [ "$head_sha" != "$main_sha" ]; then
    echo "✖ This checkout is not origin/main." >&2
    echo "✖   HEAD        $head_sha  ($(git -C "$ROOT" log -1 --format=%s HEAD))" >&2
    echo "✖   origin/main $main_sha" >&2
    echo "✖ Publishing it would put this tree's demo data — config, plans, geodata — on the live" >&2
    echo "✖ demo. That is how July's placeholder Objektpläne came back. Nothing was touched." >&2
    echo "✖ Run the 'Demo reset' workflow from main instead (Actions → Demo reset → Run workflow)." >&2
    exit 1
  fi
  dirty="$(git -C "$ROOT" status --porcelain -- examples/demo-data)"
  if [ -n "$dirty" ]; then
    echo "✖ Uncommitted changes under examples/demo-data:" >&2
    echo "$dirty" >&2
    echo "✖ Refusing: the demo would then serve something that is in nobody's history." >&2
    echo "✖ Commit and push it first, or set KP_DEMO_RESET_ALLOW_STALE=1." >&2
    exit 1
  fi
  echo "✓ Preflight: publishing origin/main @ ${head_sha:0:12}"
fi

cd backend

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

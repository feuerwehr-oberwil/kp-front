#!/usr/bin/env bash
# Are the published images pullable by someone who is NOT logged in?
#
# Both READMEs open with `docker compose up -d`, which pulls from GHCR anonymously. A package
# left private fails that first command with a 403 that reads like a broken project, so this
# check answers the only question that matters to a stranger: can they install it?
#
# Usage: scripts/check_ghcr_public.sh          → 200 = public, 403 = still private
set -uo pipefail

OWNER="${GHCR_OWNER:-feuerwehr-oberwil}"
# kp-print-agent is the current name; kp-rueck-print-agent is the deprecated alias
# kp-rueck still dual-publishes for one more release. Check both until it goes away,
# otherwise this script goes blind on the real package the moment the alias is dropped.
PACKAGES=(kp-front kp-rueck-backend kp-rueck-frontend kp-rueck-tileserver kp-print-agent kp-rueck-print-agent)

fail=0
for pkg in "${PACKAGES[@]}"; do
  # Anonymous pull token. For a PRIVATE package this request itself 401s, so no -f here:
  # an empty token is a normal outcome, not a script error. The tag listing below is what
  # actually distinguishes public from private.
  token=$(curl -sS "https://ghcr.io/token?scope=repository:${OWNER}/${pkg}:pull&service=ghcr.io" 2>/dev/null \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null)

  code=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" \
    "https://ghcr.io/v2/${OWNER}/${pkg}/tags/list")

  case "$code" in
    200) printf '  ✅ %-24s public\n' "$pkg" ;;
    403) printf '  ❌ %-24s still PRIVATE (403)\n' "$pkg"; fail=1 ;;
    *)   printf '  ⚠️  %-24s unexpected HTTP %s\n' "$pkg" "$code"; fail=1 ;;
  esac
done

echo
if [ "$fail" -eq 0 ]; then
  echo "All ${#PACKAGES[@]} packages are pullable anonymously — the documented quick start works."
else
  echo "Flip the failing ones: https://github.com/orgs/${OWNER}/packages"
  echo "  → package → Settings → Danger Zone → Change visibility → Public"
fi
exit "$fail"

#!/usr/bin/env bash
# The full dependency audit, with the temporary Picomatch exception from pnpm-workspace.yaml.
set -euo pipefail

# GHSA-fc5q-39xc-vjpf: this parser runs on repository patterns in development and CI.
# Remove the exception when a patched version is available. Expiry is enforced in UTC.
if [[ $(date -u +%F) > 2026-11-30 ]]; then
  echo "Picomatch audit exception expired on 2026-12-01. Review the upstream fix." >&2
  exit 1
fi
production_paths=$(pnpm why --prod picomatch)
if [[ -n "$production_paths" ]]; then
  echo "The Picomatch exception only covers development tooling. Production paths:" >&2
  echo "$production_paths" >&2
  exit 1
fi
pnpm audit --audit-level moderate

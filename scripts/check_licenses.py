#!/usr/bin/env python3
"""Dependency LICENSE audit (distinct from the security audits CI also runs).

Fails when a production dependency carries a license outside the AGPL-compatible
allowlist, so a new dependency with a hostile license (SSPL, BUSL, CC-BY-NC,
proprietary, missing) breaks CI instead of sneaking into a release.

Usage:
    python3 scripts/check_licenses.py frontend   # needs pnpm + node_modules installed
    python3 scripts/check_licenses.py backend    # needs uv (runs pip-licenses ephemerally)

Wired into ci.yml as a step of the frontend and backend jobs. Last full audit with
verified results: 2026-07-03.
"""

import json
import subprocess
import sys

# Licenses compatible with distributing an AGPL-3.0-or-later application.
# Additions are fine if genuinely compatible — extend deliberately, with a PR reviewer's eye.
ALLOWED = {
    # permissive
    "MIT", "MIT License", "MIT-CMU", "ISC", "BSD", "BSD License", "BSD-2-Clause",
    "BSD-3-Clause", "0BSD", "Apache-2.0", "Apache License 2.0", "Apache Software License",
    "BlueOak-1.0.0", "Unlicense", "WTFPL", "CC0-1.0", "Zlib", "Python-2.0", "PSF-2.0",
    "Python Software Foundation License",
    # weak copyleft (file-level; fine to combine with AGPL)
    "MPL-2.0", "Mozilla Public License 2.0 (MPL 2.0)", "LGPL-3.0", "LGPL-3.0-or-later",
    # fonts (assets, not linked code)
    "OFL-1.1",
    # same/compatible copyleft
    "AGPL-3.0-or-later", "AGPL-3.0", "GPL-3.0-or-later",
}

# Per-package exceptions with the reason on record.
OVERRIDES = {
    # metadata gap: fork of jsonlint, upstream is MIT; no license field in package.json
    "@mapbox/jsonlint-lines-primitives": "MIT upstream; package metadata missing",
    # react-map-gl v7 hard peer dep; the app imports ONLY react-map-gl/maplibre, and the
    # built bundle was verified mapbox-free (2026-07-03). Remove this override when
    # react-map-gl v8 (which drops the mapbox-gl peer) lands.
    "mapbox-gl": "unused peer of react-map-gl v7; not imported, not bundled",
    # the backend package itself
    "kp-front-backend": "first-party (AGPL-3.0-or-later)",
}


def license_ok(expr: str) -> bool:
    """Check a license expression: OR → any alternative allowed; AND/';' → all parts."""
    expr = expr.strip()
    if expr in ALLOWED:  # exact names first — some contain parentheses themselves
        return True
    if expr.startswith("(") and expr.endswith(")"):
        expr = expr[1:-1]
    if " OR " in expr:
        return any(license_ok(p) for p in expr.split(" OR "))
    parts = [p for chunk in expr.split(";") for p in chunk.split(" AND ")]
    return all(p.strip() in ALLOWED for p in parts)


def check(pairs: list[tuple[str, str]]) -> int:
    bad = []
    for name, lic in pairs:
        if name in OVERRIDES:
            continue
        if not license_ok(lic or "UNKNOWN"):
            bad.append((name, lic))
    for name, lic in bad:
        print(f"DISALLOWED  {name}: {lic!r}")
    print(f"checked {len(pairs)} packages, {len(bad)} disallowed, {len(OVERRIDES)} overrides on record")
    return 1 if bad else 0


def frontend() -> int:
    out = subprocess.run(
        ["pnpm", "licenses", "list", "--prod", "--json"],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)  # {license: [{name, versions, ...}]}
    pairs = [(p["name"], lic) for lic, pkgs in data.items() for p in pkgs]
    return check(pairs)


def backend() -> int:
    out = subprocess.run(
        ["uv", "run", "--with", "pip-licenses", "pip-licenses", "--format=json"],
        capture_output=True, text=True, check=True, cwd="backend",
    ).stdout
    data = json.loads(out)
    pairs = [(p["Name"], p["License"]) for p in data]
    return check(pairs)


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else ""
    if which not in ("frontend", "backend"):
        sys.exit("usage: check_licenses.py frontend|backend")
    sys.exit(frontend() if which == "frontend" else backend())

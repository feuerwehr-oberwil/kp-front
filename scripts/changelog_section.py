#!/usr/bin/env python3
"""Print one release's CHANGELOG section – the body of the GitHub Release.

    python3 scripts/changelog_section.py 0.2.0

Used by .github/workflows/release.yml so published release notes are exactly the text that
was reviewed and committed, never a live-generated list. Exits non-zero when the section is
missing, which fails the release rather than publishing an empty one.
"""

from __future__ import annotations

import pathlib
import re
import sys

CHANGELOG = pathlib.Path(__file__).resolve().parent.parent / "CHANGELOG.md"


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: changelog_section.py <version>", file=sys.stderr)
        raise SystemExit(2)
    version = sys.argv[1].lstrip("v")

    text = CHANGELOG.read_text()
    # Heading looks like:  ## [0.2.0] – 2026-07-25
    m = re.search(
        rf"^## \[{re.escape(version)}\].*?$(.*?)(?=^## \[|\Z)",
        text,
        flags=re.MULTILINE | re.DOTALL,
    )
    if not m:
        print(f"error: CHANGELOG.md has no section for {version}", file=sys.stderr)
        raise SystemExit(1)

    body = m.group(1).strip()
    if not body:
        print(f"error: CHANGELOG.md section for {version} is empty", file=sys.stderr)
        raise SystemExit(1)

    print(body)


if __name__ == "__main__":
    main()

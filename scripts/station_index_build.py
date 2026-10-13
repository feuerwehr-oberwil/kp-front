#!/usr/bin/env python3
"""Write a station index (index.json) for a folder of station-data files.

    python3 scripts/station_index_build.py /srv/station-data --provider meine-wehr

Every ``*.json`` file in the folder (not in sub-folders, not ``index.json`` itself) that names its
contract in a top-level ``"schema"`` field is listed under its kind, with its sha256 and size:

    roster-snapshot/1  -> kind "roster"
    <name>-snapshot/N  -> kind "<name>"   (vehicles-snapshot/1 -> "vehicles", …)

Files without a ``schema`` field are skipped and named on stderr. The index is written
atomically, so an app polling it never reads half a file — and it is written LAST: run this after
the data files are in place, so the checksums are the files' final ones. Both KP apps read the
same index (docs: «Station index»). Standard library only; byte-identical in KP Front and KP Rück.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

PROVIDER_RE = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
SCHEMA_RE = re.compile(r"^([a-z][a-z0-9-]*)/([0-9]+)$")
INDEX_NAME = "index.json"


def kind_of(schema: str) -> str | None:
    """``roster-snapshot/1`` -> ``roster``; anything not shaped ``<name>-snapshot/N`` -> None."""
    m = SCHEMA_RE.match(schema)
    if not m or not m.group(1).endswith("-snapshot"):
        return None
    kind = m.group(1)[: -len("-snapshot")]
    return kind if PROVIDER_RE.match(kind) else None


def build(folder: Path, *, provider: str, now: datetime | None = None) -> tuple[dict, list[str]]:
    """(index document, skipped file names)."""
    if not PROVIDER_RE.match(provider):
        raise ValueError(f"--provider {provider!r}: lowercase letters, digits, - and _, 2-32 characters")
    files: list[dict] = []
    skipped: list[str] = []
    seen: dict[str, str] = {}
    for path in sorted(folder.glob("*.json")):
        if path.name == INDEX_NAME:
            continue
        raw = path.read_bytes()
        try:
            schema = json.loads(raw).get("schema")
        except (ValueError, AttributeError):
            schema = None
        kind = kind_of(schema) if isinstance(schema, str) else None
        if kind is None:
            skipped.append(path.name)
            continue
        if kind in seen:
            raise ValueError(f"two files of kind {kind!r}: {seen[kind]} and {path.name} – one per kind")
        seen[kind] = path.name
        files.append(
            {
                "kind": kind,
                "path": path.name,
                "schema": schema,
                "sha256": hashlib.sha256(raw).hexdigest(),
                "bytes": len(raw),
            }
        )
    if not files:
        raise ValueError(f"no station-data file in {folder} (a *.json with a 'schema' like 'roster-snapshot/1')")
    doc = {
        "schema": "station-index/1",
        "schema_version": 1,
        "generated_at": (now or datetime.now(UTC)).isoformat(timespec="seconds"),
        "provider": provider,
        "files": files,
    }
    return doc, skipped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write index.json for a folder of station-data files.")
    parser.add_argument("folder")
    parser.add_argument("--provider", required=True, help="who publishes this folder, e.g. meine-wehr")
    args = parser.parse_args(argv)
    folder = Path(args.folder)
    try:
        doc, skipped = build(folder, provider=args.provider)
    except (OSError, ValueError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    for name in skipped:
        print(f"note: skipped {name} (no 'schema' field naming a <kind>-snapshot/N contract)", file=sys.stderr)
    target = folder / INDEX_NAME
    tmp = target.with_name(INDEX_NAME + ".tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(target)
    print(f"OK: {target} lists {', '.join(f['kind'] for f in doc['files'])}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Turn a roster spreadsheet (CSV) into a roster snapshot both KP apps can read.

    python3 scripts/roster_snapshot_from_csv.py roster.csv --provider meine-wehr > roster.json

The reference producer for ``roster-snapshot/1`` (docs/roster-snapshot.schema.json). Any tool
may write the format — an HR system, fwo-admin, a nightly script — and this one exists so a
station with nothing but a spreadsheet can too. Standard library only, so it runs wherever a
Python 3.10+ does, without either app installed. Byte-identical in KP Front and KP Rück.

The columns (UTF-8, comma- or semicolon-separated, header row; names are case-insensitive):

    external_id   required – YOUR stable key for the person. Never reuse one, never renumber:
                  it is what the apps match on, and a changed key reads as «left + joined».
    display_name  required – «Meier Anna» (or `name`)
    first_name    optional
    last_name     optional
    rank          optional – a rank KEY from the station's list («wm», «kpl»), not a label
    active        optional – 1/0, ja/nein, yes/no, true/false; empty = active
    id:<provider> optional, any number – the person's id in another system, e.g. `id:divera`
                  (4711). This is how the apps link the snapshot to people they already know.

**Every other column is dropped, and named on stderr.** A personnel export usually carries
things that must never leave it — Arztuntersuchung, Tauglichkeit, Impfungen, phone numbers. They
do not reach the snapshot, whatever they are called; the apps would refuse a medically named
key anyway, but the safe place to stop one is here, before it is published.

``--partial`` marks the file as covering only some people (the apps then deactivate nobody for
being absent). Without it the file is a statement about everyone.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

SCHEMA = "roster-snapshot/1"
PROVIDER_RE = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
RANK_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
KNOWN = {"external_id", "display_name", "name", "first_name", "last_name", "rank", "active"}
TRUE = {"", "1", "ja", "yes", "true", "j", "y", "x", "aktiv", "active"}
FALSE = {"0", "nein", "no", "false", "n", "inaktiv", "inactive"}


class CsvError(ValueError):
    """A problem in the spreadsheet, worded with the line it is on."""


def _sniff(text: str) -> csv.Dialect | type[csv.Dialect]:
    try:
        return csv.Sniffer().sniff(text.splitlines()[0] if text else "", delimiters=",;\t")
    except csv.Error:
        return csv.excel


def convert(text: str, *, provider: str, complete: bool = True, now: datetime | None = None) -> tuple[dict, list[str]]:
    """CSV text → (snapshot document, the columns that were dropped)."""
    if not PROVIDER_RE.match(provider):
        raise CsvError(f"--provider {provider!r}: lowercase letters, digits, - and _, 2–32 characters")
    text = text.lstrip("﻿")
    reader = csv.DictReader(io.StringIO(text), dialect=_sniff(text))
    if not reader.fieldnames:
        raise CsvError("the file has no header row")
    header = {name: (name or "").strip().lower() for name in reader.fieldnames}
    dropped = [name for name, key in header.items() if key not in KNOWN and not key.startswith("id:")]
    if "external_id" not in header.values():
        raise CsvError("the column 'external_id' is required – a stable key per person, never reused")
    if not {"display_name", "name"} & set(header.values()):
        raise CsvError("the column 'display_name' (or 'name') is required")

    people: list[dict] = []
    seen: set[str] = set()
    for line, raw in enumerate(reader, start=2):
        row = {header[k]: (v or "").strip() for k, v in raw.items() if k is not None}
        if not any(row.values()):
            continue
        ext = row.get("external_id", "")
        name = row.get("display_name") or row.get("name") or ""
        if not ext:
            raise CsvError(f"line {line}: external_id is empty")
        if ext in seen:
            raise CsvError(f"line {line}: external_id {ext!r} appears twice")
        seen.add(ext)
        if not name:
            raise CsvError(f"line {line}: display_name is empty")
        flag = row.get("active", "").lower()
        if flag not in TRUE | FALSE:
            raise CsvError(f"line {line}: active {flag!r} – use 1/0, ja/nein, yes/no")
        rank = row.get("rank", "").lower() or None
        if rank is not None and not RANK_RE.match(rank):
            raise CsvError(f"line {line}: rank {rank!r} is not a rank key (e.g. 'wm', 'kpl')")
        identities = []
        for key, value in row.items():
            if key.startswith("id:") and value:
                other = key[3:].strip()
                if not PROVIDER_RE.match(other):
                    raise CsvError(f"column {key!r}: {other!r} is not a provider key")
                identities.append({"provider": other, "external_id": value})
        people.append(
            {
                "external_id": ext,
                "display_name": " ".join(name.split()),
                "first_name": row.get("first_name") or None,
                "last_name": row.get("last_name") or None,
                "rank": rank,
                "active": flag not in FALSE,
                "identities": identities,
            }
        )
    if not people:
        raise CsvError("the file lists nobody – an empty roster is a broken export, not an empty brigade")
    doc = {
        "schema": SCHEMA,
        "schema_version": 1,
        "generated_at": (now or datetime.now(UTC)).isoformat(timespec="seconds"),
        "provider": provider,
        "complete": complete,
        "count": len(people),
        "people": people,
    }
    return doc, dropped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Roster CSV → roster-snapshot/1 JSON (stdout or --out).")
    parser.add_argument("csv", help="the spreadsheet, exported as CSV (UTF-8)")
    parser.add_argument("--provider", required=True, help="the key this file's ids are filed under, e.g. meine-wehr")
    parser.add_argument("--partial", action="store_true", help="the file covers only some people")
    parser.add_argument("--out", help="write here instead of stdout (written atomically)")
    args = parser.parse_args(argv)
    try:
        doc, dropped = convert(
            Path(args.csv).read_text(encoding="utf-8"), provider=args.provider, complete=not args.partial
        )
    except (OSError, CsvError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    if dropped:
        print(f"note: dropped columns (never published): {', '.join(dropped)}", file=sys.stderr)
    out = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    if args.out:
        # Atomic: an app polling this path must never read half a file.
        target = Path(args.out)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(out, encoding="utf-8")
        tmp.replace(target)
    else:
        sys.stdout.write(out)
    print(f"OK: {doc['count']} people from {args.csv}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Compile the bundled ERG dataset (src/data/erg.json) from tools/erg-source/*.json.

Sources transcribe the public-domain ERG 2024 (PHMSA) — see tools/erg-source/README.md for
provenance + verification. Output is compact and metric-only (Swiss deployment):

  { "version": "ERG2024",
    "un": { "1005": { "g": 125, "tih": [ { "n": null, "si": "30 m", "pd": "0.1 km",
                                           "pn": "0.2 km", "l": "T3" } ] },
            "1010": { "g": 116, "p": true } } }

g  = orange-pages guide number       p  = polymerization hazard ('P' guide suffix)
tih rows (Table 1, TIH/PIH only): n = distinguishing label when a UN has several rows,
si = small-spill isolation, pd/pn = protective distance day/night; l = large-spill —
either {li, ld, ln} or "T3" (six common gases: ERG Table 3 by container/wind).

Usage: python3 tools/gen_erg.py
"""

import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "tools/erg-source"
OUT = ROOT / "src/data/erg.json"

METRIC = re.compile(r"^\s*([\d.]+\s*(?:m|km))\s*(?:\(.*\))?\s*$")


def metric(s: str | None) -> str | None:
    """'30 m (100 ft)' → '30 m' — the book pairs metric+imperial; we ship metric."""
    if not s:
        return None
    m = METRIC.match(s)
    return m.group(1).replace("  ", " ") if m else s.strip()


def main() -> None:
    yellow = json.loads((SRC / "erg_yellow.json").read_text())
    table1 = json.loads((SRC / "erg_table1.json").read_text())

    un: dict[str, dict] = {}
    for e in yellow:
        uid, guide = e.get("id_number"), e.get("guide_number")
        if not uid or not guide:
            continue
        poly = guide.endswith("P")
        g = int(guide.rstrip("P"))
        cur = un.setdefault(uid, {"g": g})
        # a UN listed under several names always shares one guide in the ERG; keep the first
        if poly:
            cur["p"] = True

    for uid, rows in table1.items():
        entry = un.setdefault(uid, {})
        tih = []
        for r in rows:
            small = r.get("small") or {}
            row: dict = {
                "n": r.get("label") or (r["names"][0] if len(rows) > 1 and r.get("names") else None),
                "si": metric(small.get("isolate")),
                "pd": metric(small.get("protect_day")),
                "pn": metric(small.get("protect_night")),
            }
            large = r.get("large")
            if isinstance(large, dict):
                row["l"] = {
                    "li": metric(large.get("isolate")),
                    "ld": metric(large.get("protect_day")),
                    "ln": metric(large.get("protect_night")),
                }
            elif large:
                row["l"] = "T3"
            if not entry.get("g") and r.get("guide"):
                entry["g"] = int(str(r["guide"]).rstrip("P"))
            tih.append({k: v for k, v in row.items() if v is not None})
        entry["tih"] = tih

    out = {"version": "ERG2024", "un": un}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    tih_count = sum(1 for v in un.values() if v.get("tih"))
    print(f"wrote {OUT.relative_to(ROOT)}: {len(un)} UN entries, {tih_count} with Table-1 distances, "
          f"{sum(1 for v in un.values() if v.get('p'))} polymerization-flagged "
          f"({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()

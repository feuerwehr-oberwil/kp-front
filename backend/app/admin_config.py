"""Admin CLI for the deployment-config singleton row (id=1) — config-as-code.

A single kp-front build serves many fire-brigade deployments; each one's per-station
config (identity/map/referenceLayers/fleet/symbols/doctrine/roster/mittel) lives in the
``deployment_config`` singleton row and is served to the frontend by the PUBLIC
``GET /api/config`` (see app/api/config.py). This command is how an admin (or an agent)
authors, validates, and applies that config from a JSON file — locally against SQLite or
against production by exporting ``DATABASE_URL`` first.

Designed to be driven by an LLM/agent: the loop is

    schema → (author config.json) → validate → diff → load

Usage (from the ``backend/`` directory, via ``uv run python -m app.admin_config <cmd>``):

    schema              print the JSON Schema of the config document (the contract)
    example             print a populated example config you can edit
    validate <file>     parse + validate a file (no DB needed, nothing written)
    diff <file>         show what would change vs the currently-stored config
    load <file>         validate + upsert the file into the row (writes to the DB)
    load <file> --dry-run   same as ``validate`` (no write)
    show                print the currently-stored config

Back-compat: ``app.admin_config <file.json>`` (bare path) still means ``load``, and
``--show`` / no args still means ``show``.

Behaviour:
- Files are validated through ``DeploymentConfigIn`` — the SAME schema the ``PUT /api/config``
  endpoint uses. Invalid JSON or a schema failure prints precise ``field.path: message`` lines
  and exits non-zero; nothing is written.
- ``load`` persists the NORMALIZED document (defaults filled in) as ``config_json`` so GET
  round-trips consistently. Idempotent; ``updated_by`` is left NULL (out-of-band admin load,
  not a logged-in editor PUT).
- ``schema``/``example``/``validate``/``diff`` against a file need NO database connection.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select

from .database import async_session_maker
from .models import DeploymentConfig
from .schemas import DeploymentConfigIn

# A representative, schema-valid example. Mirrors CONFIGURATION.md §1; edit to taste.
EXAMPLE_CONFIG: dict[str, Any] = {
    "identity": {
        "appName": "Feuerwehr Musterdorf",
        "locale": "de-CH",
        "accentColor": "#c4161c",
        "helpIntro": "Digitale Lage- und Einsatzführung der Feuerwehr Musterdorf.",
        "kommandant": "Maj Hans Muster",
    },
    "map": {
        "defaultView": {"center": [7.5662, 47.5201], "zoom": 16},
        "geocoder": {
            "defaultLocality": "4104 Musterdorf BL",
            "bboxLv95": "2606000,1258000,2614000,1266000",
        },
    },
    "referenceLayers": [
        {
            "id": "bl-hochwasser",
            "group": "Gefahren",
            "label": "Hochwasser",
            "icon": "drop",
            "kind": "wms",
            "tiles": [
                "https://geowms.example.ch/?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap"
                "&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:3857&WIDTH=256&HEIGHT=256"
                "&LAYERS=hochwasser&BBOX={bbox-epsg-3857}"
            ],
            "opacity": 65,
            "attribution": "© Geodaten Kanton …",
        },
        {
            "id": "hydrant",
            "group": "Wasser",
            "label": "Hydranten",
            "icon": "drop",
            "kind": "geojson",
            "geojson": "hydranten.geojson",
            "vectorKind": "point",
            "symbol": "SI Ueberflurhydrant",
            "color": "#0f52b5",
        },
    ],
    # Objektplan modules: tile label/order (M1, 2/3, …) + the importer's filename parsing rule
    # (`match` regex). One config drives both the app's plan tiles and `import_einsatzplaene`.
    # `combinedWith` = a combined sheet that fills several slots; `family` = generative (the
    # `match` capture becomes a sub-slot, e.g. "Modul 5 - Wasser" → modul5-wasser).
    "modules": [
        {"id": "modul1", "code": "M1", "title": "Übersicht", "order": 1, "orientation": "portrait", "match": r"modul\s*1(?!\s*[-–/]\s*\d)"},
        {"id": "modul2", "code": "M2", "title": "Umgebung", "order": 2, "match": r"modul\s*2(?!\s*[-–/]\s*\d)"},
        {"id": "modul3", "code": "M3", "title": "Objektplan", "order": 3, "match": r"modul\s*3(?!\s*[-–/]\s*\d)"},
        {"id": "modul2-3", "code": "2/3", "title": "Umgebung & Objekt", "order": 4, "match": r"modul\s*2\s*[-–/]\s*3", "combinedWith": ["modul2", "modul3"]},
        {"id": "modul6", "code": "M6", "title": "Gebäudepläne", "order": 6, "orientation": "portrait", "match": r"modul\s*6"},
        {"id": "modul5", "code": "M5", "title": "Spezialpläne", "order": 5, "family": True, "match": r"modul\s*5(?:\s*[-–—]\s*([0-9A-Za-zÄÖÜäöü]+))?"},
        {"id": "modul4", "code": "M4", "title": "Spezialplan", "order": 7, "match": r"modul\s*4"},
    ],
    "fleet": {
        # Data-driven Auswahl-Vorschläge: attach a suggestion list to a symbol field.
        # `field` is "title" (the title combobox) or a detail-row key ("Typ", "Einheit", …).
        # Free typing always stays possible; edit in Verwaltung › Fahrzeuge & Geräte.
        # (Legacy vehicleTypes/luefterTypes/kleinloeschTypes/partner still work as a fallback.)
        "attributeLists": [
            {"symbol": "VKF Fahrzeug", "field": "title", "options": ["TLF", "ADL", "HLF", "ELW"]},
            {"symbol": "VKF Luefter mobil", "field": "Typ", "options": ["Überdruck", "Elektro"]},
            {"symbol": "FW Kleinloeschgeraet", "field": "Typ", "options": ["Wasser", "Schaum", "CO₂"]},
            {"symbol": "VKF Bereich Feuerwehr", "field": "Einheit", "options": ["Stützpunkt", "Nachbarwehr"]},
            {"symbol": "VKF Bereich Sanitaet", "field": "Einheit", "options": ["Rettungsdienst", "Rega"]},
            {"symbol": "VKF Bereich Polizei", "field": "Einheit", "options": ["Kantonspolizei"]},
        ],
    },
    "doctrine": {
        "defaultFunkkanal": 1,
        "contactIntervalMin": 5,
        "contactGraceSec": 60,
        "mindestBar": 60,
    },
    "roster": {
        "source": "manual",
        # Ordered Dienstgrade, most senior first (position = seniority). Generic Swiss militia
        # fire-service set — a station overrides this to match its own ranks. `tier` drives the
        # "nur Offiziere" picker filter + Anwesenheit grouping. Keep in sync with the frontend
        # fallback in src/lib/rank.ts (SWISS_DEFAULT_RANKS).
        "ranks": [
            {"key": "kdt", "label": "Kommandant", "abbr": "Kdt", "tier": "officer"},
            {"key": "maj", "label": "Major", "abbr": "Maj", "tier": "officer"},
            {"key": "hptm", "label": "Hauptmann", "abbr": "Hptm", "tier": "officer"},
            {"key": "oblt", "label": "Oberleutnant", "abbr": "Oblt", "tier": "officer"},
            {"key": "lt", "label": "Leutnant", "abbr": "Lt", "tier": "officer"},
            {"key": "fw", "label": "Feldweibel", "abbr": "Fw", "tier": "nco"},
            {"key": "wm", "label": "Wachtmeister", "abbr": "Wm", "tier": "nco"},
            {"key": "kpl", "label": "Korporal", "abbr": "Kpl", "tier": "nco"},
            {"key": "gfr", "label": "Gefreiter", "abbr": "Gfr", "tier": "crew"},
            {"key": "fwm", "label": "Feuerwehrmann", "abbr": "Fwm", "tier": "crew"},
        ],
    },
    "mittel": {
        # Station catalogue of materials/equipment crews use up OR deploy. `unit` is the default
        # unit (editable per incident); `category` groups the picker + Bestand view; optional
        # `stock` is the nominal load-out per source (drives the used/available + Bestand readout).
        # Anything not listed can be typed in the app as «Anderes Mittel».
        "catalogue": [
            {"id": "schaummittel", "label": "Schaummittel", "unit": "l", "category": "Ölwehr"},
            {"id": "bindemittel", "label": "Ölbindemittel", "unit": "Sack", "category": "Ölwehr"},
            {
                "id": "luefter",
                "label": "Lüfter",
                "unit": "Stk",
                "category": "Geräte",
                "stock": [{"source": "tlf", "qty": 2}, {"source": "lf", "qty": 1}],
            },
        ],
        # Where a material was drawn from (vehicle / depot / …); optional on every entry.
        "sources": [
            {"id": "tlf", "label": "TLF"},
            {"id": "lf", "label": "LF"},
            {"id": "depot", "label": "Magazin"},
        ],
        # Common unit suggestions for custom entries; free text always stays possible.
        "units": ["Stk", "l", "m", "Sack", "Flasche", "kg"],
    },
    "alarms": {
        # Auto-open: a NEW Divera alarm becomes an incident with no human in the loop (the
        # generic POST /api/alarms intake always creates — its env secret is the opt-in).
        # Filters (None/absent = accept all): priorities against the inferred HIGH/LOW,
        # keywords as case-insensitive substrings of title+text.
        "autoOpen": False,
        "autoOpenPriorities": None,
        "autoOpenKeywords": None,
        # Untouched auto-opened incidents (never any workspace sync) archive after N days;
        # 0 disables the sweep. Archived incidents stay visible in the Verlauf/history.
        "autoArchiveDays": 7,
        # Erfassungs-Poster reach: how long after opening an incident the station capture
        # link (/e/<token>) can still record attendance/material/notes for it.
        "captureWindowHours": 12,
        # Outbound: every URL gets a POST on incident creation (see docs/ALARM-INTEGRATIONS.md).
        # Fail-open — retried + logged, never blocking intake. [] = off.
        "webhooks": [],
    },
}


def _fail(message: str) -> None:
    """Print an error to stderr and exit non-zero (nothing written)."""
    print(message, file=sys.stderr)
    raise SystemExit(1)


def _format_validation_error(path: Path, err: ValidationError) -> str:
    """Turn a pydantic ValidationError into precise ``field.path: message`` lines."""
    lines = [f"ERROR: {path} failed DeploymentConfigIn validation ({err.error_count()} issue(s)):"]
    for e in err.errors():
        loc = ".".join(str(p) for p in e["loc"]) or "(root)"
        lines.append(f"  {loc}: {e['msg']} [{e['type']}]")
    return "\n".join(lines)


def _read_and_validate(path: Path) -> dict[str, Any]:
    """Read + parse + validate a config file. Returns the NORMALIZED document. Exits on error."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as e:
        _fail(f"ERROR: cannot read {path}: {e}")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        _fail(f"ERROR: {path} is not valid JSON: {e}")
    if not isinstance(data, dict):
        _fail(f"ERROR: {path} must contain a JSON object at the top level, got {type(data).__name__}.")
    try:
        doc = DeploymentConfigIn(**data)
    except ValidationError as e:
        _fail(_format_validation_error(path, e))
    return doc.model_dump(mode="json")


def _diff(old: dict[str, Any] | None, new: dict[str, Any], prefix: str = "") -> list[str]:
    """Recursive, readable diff between two JSON documents → ``path: old -> new`` lines."""
    out: list[str] = []
    old = old or {}
    for key in sorted(set(old) | set(new)):
        p = f"{prefix}{key}"
        in_old, in_new = key in old, key in new
        ov, nv = old.get(key), new.get(key)
        if in_old and not in_new:
            out.append(f"  - {p}: {json.dumps(ov, ensure_ascii=False)}")
        elif in_new and not in_old:
            out.append(f"  + {p}: {json.dumps(nv, ensure_ascii=False)}")
        elif isinstance(ov, dict) and isinstance(nv, dict):
            out.extend(_diff(ov, nv, prefix=f"{p}."))
        elif ov != nv:
            out.append(f"  ~ {p}: {json.dumps(ov, ensure_ascii=False)} -> {json.dumps(nv, ensure_ascii=False)}")
    return out


def _summary(doc_json: dict[str, Any]) -> str:
    """Concise one-liner: which top-level keys carry non-empty content."""
    set_keys = []
    for key, val in doc_json.items():
        if isinstance(val, dict):
            if any(v not in (None, {}, [], "") for v in val.values()):
                set_keys.append(key)
        elif val not in (None, [], {}, ""):
            set_keys.append(key)
    return ", ".join(set_keys) if set_keys else "(none — empty config)"


async def _show() -> dict[str, Any] | None:
    async with async_session_maker() as db:
        row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        return row.config_json if (row and row.config_json) else None


async def _load(doc_json: dict[str, Any]) -> None:
    async with async_session_maker() as db:
        row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        if row is None:
            db.add(DeploymentConfig(id=1, config_json=doc_json))
        else:
            row.config_json = doc_json
        await db.commit()


def _normalize_argv(argv: list[str]) -> list[str]:
    """Back-compat shim: map the legacy ``<file>`` and ``--show`` forms onto subcommands."""
    cmds = {"schema", "example", "validate", "diff", "load", "show"}
    if not argv or argv == ["--show"]:
        return ["show"]
    if argv[0] in cmds or argv[0] in ("-h", "--help"):
        return argv
    # Legacy: a bare path (optionally with --dry-run) means ``load``.
    return ["load", *argv]


async def _amain(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.admin_config",
        description="Manage the kp-front deployment-config singleton row (config-as-code).",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("schema", help="print the config JSON Schema (no DB)")
    sub.add_parser("example", help="print a populated example config (no DB)")
    p_val = sub.add_parser("validate", help="validate a file, no write (no DB)")
    p_val.add_argument("file")
    p_diff = sub.add_parser("diff", help="show changes a file would make vs stored config")
    p_diff.add_argument("file")
    p_load = sub.add_parser("load", help="validate + upsert a file into the row")
    p_load.add_argument("file")
    p_load.add_argument("--dry-run", action="store_true", help="validate only, do not write")
    sub.add_parser("show", help="print the currently-stored config")

    args = parser.parse_args(_normalize_argv(argv))

    if args.cmd == "schema":
        print(json.dumps(DeploymentConfigIn.model_json_schema(), indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "example":
        print(json.dumps(EXAMPLE_CONFIG, indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "validate":
        doc_json = _read_and_validate(Path(args.file))
        print(f"OK: {args.file} is valid. Top-level keys set: {_summary(doc_json)}")
        return 0
    if args.cmd == "diff":
        doc_json = _read_and_validate(Path(args.file))
        stored = await _show()
        changes = _diff(stored, doc_json)
        if not changes:
            print("No changes — the file matches the stored config.")
        else:
            print(f"{len(changes)} change(s) vs stored config:")
            print("\n".join(changes))
        return 0
    if args.cmd == "load":
        doc_json = _read_and_validate(Path(args.file))
        if args.dry_run:
            print(f"OK (dry-run): {args.file} is valid; not written. Keys: {_summary(doc_json)}")
            return 0
        await _load(doc_json)
        print(f"OK: loaded {args.file} into deployment_config id=1.")
        print(f"    top-level keys set: {_summary(doc_json)}")
        return 0
    # show
    stored = await _show()
    print(json.dumps(stored, indent=2, ensure_ascii=False) if stored else "No deployment config stored (row absent or empty).")
    return 0


def main() -> None:
    sys.exit(asyncio.run(_amain(sys.argv[1:])))


if __name__ == "__main__":
    main()

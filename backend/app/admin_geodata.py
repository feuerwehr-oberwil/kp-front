"""Admin CLI for per-station GEODATA — reference layers as code (sibling to admin_config).

A station's reference layers (hydrants, Leitungskataster, canton WMS, …) are STATION DATA:
they never live in the open-source repo. Instead they live in a private data repo as a
GeoJSON folder + a manifest, and this command loads them into a running deployment — the
GeoJSON files go into the reference store (served at ``/api/reference/geo:<slug>``) and the
render config (group/label/colour/symbol/tiles) is written into the ``deployment_config``
row's ``referenceLayers``, which the frontend turns into map layers (see
``src/lib/deploymentConfig.ts`` → ``referenceLayersFromConfig``).

Run from ``backend/`` via ``uv run python -m app.admin_geodata <cmd>`` (against SQLite locally,
or production by exporting ``DATABASE_URL`` first):

    schema                 print the JSON Schema of a manifest entry (the contract)
    example                print a populated example manifest you can edit
    validate <manifest>    parse + validate the manifest AND every referenced GeoJSON (no DB)
    load <manifest>        upload the GeoJSON into the store + write referenceLayers (writes DB)
    load <manifest> --dry-run        same as validate (no write)
    load <manifest> --config-only    write only referenceLayers, skip file upload
    push <manifest>        upload GeoJSON + config to a RUNNING deployment via its API (remote-safe)
    show                   print the referenceLayers currently stored in the config

`load` writes the GeoJSON to the LOCAL storage dir, so run it server-side (or use --config-only)
for a remote DB. `push` instead goes through a running server's HTTP API (ADMIN_SECRET), so the
server writes its own volume — the way to refresh a remote deployment's data from a workstation.

Manifest = a JSON list of layer entries (or ``{"layers": [...]}``). Paths in ``file`` are
resolved relative to the manifest's own directory. Each entry is one of:
  * ``kind: geojson`` with ``file`` (local GeoJSON → store) or ``geojson`` (already-hosted URL)
  * ``kind: wms`` / ``wmts`` with ``tiles`` (raster template(s))

GeoJSON is validated as a WGS84 ``[lng, lat]`` FeatureCollection — LV95-looking coordinates
are rejected (convert at the edge first; see scripts in the private data repo).
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError, model_validator
from sqlalchemy import select

from . import storage
from .database import async_session_maker
from .models import DeploymentConfig, ReferenceDataset
from .schemas import DeploymentConfigIn, ReferenceLayerConfig


class GeodataManifestEntry(BaseModel):
    """One reference layer in a station's geodata manifest.

    Superset of ``ReferenceLayerConfig`` with two load-time-only fields — ``file`` (a local
    GeoJSON to push into the store) and ``dataset`` (the store slug, default = file stem).
    ``extra=forbid`` so a typo'd key fails loudly instead of being silently dropped.
    """

    model_config = ConfigDict(extra="forbid")
    id: str
    kind: Literal["wms", "wmts", "geojson"]
    file: str | None = None  # geojson layers: local path (rel. to manifest) → reference store
    dataset: str | None = None  # store slug → geo:<slug>; default = file stem
    geojson: str | None = None  # already-hosted URL, instead of `file`
    tiles: list[str] | None = None  # wms/wmts raster template(s)
    group: str | None = None
    label: str | None = None
    icon: str | None = None
    vectorKind: str | None = None
    symbol: str | None = None
    color: str | None = None
    nightColor: str | None = None
    opacity: float | None = None
    maxzoom: float | None = None
    attribution: str | None = None
    autoActivate: list[str] | None = None  # Einsatz categories that auto-show this layer
    sourceNote: str | None = None  # provenance, stored on the dataset row (not sent to the client)

    @model_validator(mode="after")
    def _kind_payload(self) -> "GeodataManifestEntry":
        if self.kind in ("wms", "wmts"):
            if not self.tiles:
                raise ValueError(f"layer {self.id!r}: raster layer ({self.kind}) requires 'tiles'")
        elif self.kind == "geojson":
            if bool(self.file) == bool(self.geojson):
                raise ValueError(f"layer {self.id!r}: geojson layer needs exactly one of 'file' or 'geojson'")
        return self

    def slug(self) -> str:
        """Reference-store slug for a file-backed layer (geo:<slug>)."""
        if self.dataset:
            return self.dataset
        return Path(self.file).stem if self.file else self.id


EXAMPLE_MANIFEST: list[dict[str, Any]] = [
    {
        "id": "lk-hydrant",
        "kind": "geojson",
        "file": "hydrant.geojson",
        "group": "Wasser",
        "label": "Hydranten",
        "icon": "drop",
        "vectorKind": "point",
        "symbol": "SI Ueberflurhydrant",
        "color": "#0f52b5",
        "nightColor": "#5b9bff",
        "attribution": "© Wasserversorgung Musterdorf",
        "autoActivate": ["Brandbekämpfung"],
        "sourceNote": "Hydranten-Export der Wasserversorgung",
    },
    {
        "id": "bl-hochwasser",
        "kind": "wms",
        "tiles": [
            "https://geowms.example.ch/?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap"
            "&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:3857&WIDTH=256&HEIGHT=256"
            "&LAYERS=hochwasser&BBOX={bbox-epsg-3857}"
        ],
        "group": "Gefahren",
        "label": "Hochwasser",
        "icon": "drop",
        "opacity": 65,
        "attribution": "© Geodaten Kanton Musterland",
    },
]


def _fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


# --- manifest + GeoJSON validation (no DB) ----------------------------------------------


def _read_manifest(path: Path) -> list[GeodataManifestEntry]:
    """Read + parse + validate a manifest file. Returns the entries. Exits on any error."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as e:
        _fail(f"ERROR: cannot read {path}: {e}")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        _fail(f"ERROR: {path} is not valid JSON: {e}")
    if isinstance(data, dict) and isinstance(data.get("layers"), list):
        data = data["layers"]
    if not isinstance(data, list):
        _fail(f"ERROR: {path} must be a JSON list of layers (or {{\"layers\": [...]}}).")
    entries: list[GeodataManifestEntry] = []
    seen: set[str] = set()
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            _fail(f"ERROR: {path}[{i}] is not an object.")
        try:
            entry = GeodataManifestEntry(**item)
        except ValidationError as e:
            loc = f"{path}[{i}]"
            lines = [f"ERROR: {loc} failed validation ({e.error_count()} issue(s)):"]
            for err in e.errors():
                field = ".".join(str(p) for p in err["loc"]) or "(root)"
                lines.append(f"  {field}: {err['msg']} [{err['type']}]")
            _fail("\n".join(lines))
        if entry.id in seen:
            _fail(f"ERROR: {path}: duplicate layer id {entry.id!r}.")
        seen.add(entry.id)
        entries.append(entry)
    return entries


def _validate_geojson_wgs84(path: Path) -> int:
    """Validate a file is a WGS84 [lng, lat] FeatureCollection; return feature count. Exits on error."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as e:
        _fail(f"ERROR: cannot read GeoJSON {path}: {e}")
    except json.JSONDecodeError as e:
        _fail(f"ERROR: {path} is not valid JSON: {e}")
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
        _fail(f"ERROR: {path} is not a GeoJSON FeatureCollection.")
    # Sample the first coordinate pair to catch the classic mistake — LV95 E/N (millions of
    # metres) shipped where WGS84 lon/lat is expected. Any |value| > 180 can't be lon/lat.
    sample = _first_coord(data["features"])
    if sample is not None:
        x, y = sample
        if abs(x) > 180 or abs(y) > 90:
            _fail(
                f"ERROR: {path} coordinates look like LV95/projected ({x:.1f}, {y:.1f}), not WGS84 "
                "[lng, lat]. Reproject to EPSG:4326 before loading."
            )
    return len(data["features"])


def _first_coord(features: list) -> tuple[float, float] | None:
    """First [x, y] pair found under any feature geometry (any nesting)."""
    for feat in features:
        geom = feat.get("geometry") if isinstance(feat, dict) else None
        if isinstance(geom, dict):
            c = _dig(geom.get("coordinates"))
            if c is not None:
                return c
    return None


def _dig(node: Any) -> tuple[float, float] | None:
    if isinstance(node, (list, tuple)):
        if len(node) >= 2 and all(isinstance(v, (int, float)) for v in node[:2]):
            return float(node[0]), float(node[1])
        for child in node:
            c = _dig(child)
            if c is not None:
                return c
    return None


def _resolve(manifest_path: Path, entry: GeodataManifestEntry) -> Path:
    """Absolute path of a file-backed entry's GeoJSON, relative to the manifest's directory."""
    return (manifest_path.parent / entry.file).resolve()


def _to_reference_layers(entries: list[GeodataManifestEntry]) -> list[dict[str, Any]]:
    """Manifest entries → validated ReferenceLayerConfig dicts (the client-facing render config).

    File-backed geojson layers get their ``geojson`` URL pointed at the reference store. The
    load-time-only fields (file/dataset/sourceNote) are dropped here — they never reach the client.
    """
    out: list[dict[str, Any]] = []
    for e in entries:
        layer = ReferenceLayerConfig(
            id=e.id,
            group=e.group,
            label=e.label,
            icon=e.icon,
            kind=e.kind,
            tiles=e.tiles,
            geojson=e.geojson if e.geojson else (f"/api/reference/geo:{e.slug()}" if e.kind == "geojson" else None),
            vectorKind=e.vectorKind,
            symbol=e.symbol,
            color=e.color,
            nightColor=e.nightColor,
            opacity=e.opacity,
            maxzoom=e.maxzoom,
            attribution=e.attribution,
            autoActivate=e.autoActivate,
        )
        out.append(layer.model_dump(mode="json", exclude_none=True))
    return out


# --- DB writes --------------------------------------------------------------------------


async def _write_config(db, ref_layers: list[dict[str, Any]]) -> None:
    """Merge referenceLayers into the config (preserve identity/map/fleet/…), then re-validate
    the whole document so GET /api/config round-trips the normalized form."""
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    current = dict(row.config_json) if (row and row.config_json) else {}
    current["referenceLayers"] = ref_layers
    normalized = DeploymentConfigIn(**current).model_dump(mode="json")
    if row is None:
        db.add(DeploymentConfig(id=1, config_json=normalized))
    else:
        row.config_json = normalized


async def _load(manifest_path: Path, entries: list[GeodataManifestEntry], feature_counts: dict[str, int]) -> tuple[int, int]:
    """Upload file-backed GeoJSON into the store and write referenceLayers into the config.

    Returns (datasets_written, layers_written).
    """
    ref_layers = _to_reference_layers(entries)
    async with async_session_maker() as db:
        ds_written = 0
        for e in entries:
            if e.kind != "geojson" or not e.file:
                continue
            ds_id = f"geo:{e.slug()}"
            src = _resolve(manifest_path, e)
            data = src.read_bytes()
            key = storage.new_key("reference", "-" + ds_id.replace(":", "_"))
            storage.put_bytes(key, data)
            existing = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == ds_id))).scalar_one_or_none()
            if existing is None:
                existing = ReferenceDataset(id=ds_id, kind="geojson", current_version=1)
                db.add(existing)
            else:
                existing.current_version += 1
            existing.kind = "geojson"
            existing.title = e.label or existing.title or ds_id
            existing.source_type = "uploaded"
            existing.source_note = e.sourceNote if e.sourceNote is not None else existing.source_note
            existing.storage_key = key
            existing.content_type = "application/geo+json"
            existing.size_bytes = len(data)
            existing.feature_count = feature_counts.get(e.id)
            ds_written += 1
        await _write_config(db, ref_layers)
        await db.commit()
    return ds_written, len(ref_layers)


async def _load_config_only(entries: list[GeodataManifestEntry]) -> int:
    """Write ONLY referenceLayers — no file access, no dataset rows touched. For a remote
    deployment whose GeoJSON is already in its store (storage writes here would land on the
    LOCAL disk, not the server volume). Returns layers_written."""
    ref_layers = _to_reference_layers(entries)
    async with async_session_maker() as db:
        await _write_config(db, ref_layers)
        await db.commit()
    return len(ref_layers)


def _push(
    manifest_path: Path, entries: list[GeodataManifestEntry], base: str, admin_secret: str, dry_run: bool
) -> tuple[int, int]:
    """Push file content + render config to a RUNNING deployment over its HTTP API. Unlike a
    direct DB load this works against a remote server: each GeoJSON is PUT to the reference
    store (the server writes its OWN volume) and the config is PUT to /api/config. Authenticates
    with the deployment ADMIN_SECRET (not an editor PIN). Returns (files_uploaded, layers_written)."""
    import httpx  # lazy: only `push` needs the network

    base = base.rstrip("/")
    files = [e for e in entries if e.kind == "geojson" and e.file]
    with httpx.Client(base_url=base, timeout=180.0) as c:
        r = c.post("/api/admin/login", json={"secret": admin_secret})
        if r.status_code != 200:
            _fail(f"ERROR: admin login to {base} failed ({r.status_code}): {r.text[:200]}")
        if dry_run:
            cfg = c.get("/api/config")
            if cfg.status_code != 200:
                _fail(f"ERROR: GET /api/config failed ({cfg.status_code}): {cfg.text[:200]}")
            print(f"OK (dry-run): authenticated to {base}; would upload {len(files)} file(s) and write {len(entries)} layer(s). Nothing written.")
            return 0, 0
        uploaded = 0
        for e in files:
            src = _resolve(manifest_path, e)
            form = {"source_note": e.sourceNote} if e.sourceNote else {}
            rr = c.put(
                f"/api/reference/geo:{e.slug()}",
                files={"file": (src.name, src.read_bytes(), "application/geo+json")},
                data=form,
            )
            if rr.status_code != 200:
                _fail(f"ERROR: upload geo:{e.slug()} failed ({rr.status_code}): {rr.text[:200]}")
            uploaded += 1
            print(f"  ↑ geo:{e.slug()} ({src.name})")
        cfg_resp = c.get("/api/config")
        if cfg_resp.status_code != 200:
            _fail(f"ERROR: GET /api/config failed ({cfg_resp.status_code}): {cfg_resp.text[:200]}")
        cfg = cfg_resp.json()
        cfg.pop("integrations", None)  # env-derived, read-only (mirrors ConfigEditor's PUT)
        cfg["referenceLayers"] = _to_reference_layers(entries)
        pc = c.put("/api/config", json=cfg)
        if pc.status_code != 200:
            _fail(f"ERROR: PUT /api/config failed ({pc.status_code}): {pc.text[:300]}")
    return uploaded, len(entries)


async def _show() -> list[dict[str, Any]]:
    async with async_session_maker() as db:
        row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        cfg = row.config_json if (row and row.config_json) else {}
        return cfg.get("referenceLayers", []) if isinstance(cfg, dict) else []


# --- CLI --------------------------------------------------------------------------------


def _validate_files(manifest_path: Path, entries: list[GeodataManifestEntry]) -> dict[str, int]:
    """Validate every file-backed entry's GeoJSON; return {entry.id: feature_count}."""
    counts: dict[str, int] = {}
    for e in entries:
        if e.kind == "geojson" and e.file:
            src = _resolve(manifest_path, e)
            if not src.is_file():
                _fail(f"ERROR: {manifest_path}: layer {e.id!r} file not found: {src}")
            counts[e.id] = _validate_geojson_wgs84(src)
    return counts


async def _amain(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.admin_geodata",
        description="Load per-station reference layers (geodata-as-code) into a deployment.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("schema", help="print the manifest-entry JSON Schema (no DB)")
    sub.add_parser("example", help="print a populated example manifest (no DB)")
    p_val = sub.add_parser("validate", help="validate the manifest + referenced GeoJSON (no DB)")
    p_val.add_argument("manifest")
    p_load = sub.add_parser("load", help="upload GeoJSON + write referenceLayers into the config")
    p_load.add_argument("manifest")
    p_load.add_argument("--dry-run", action="store_true", help="validate only, do not write")
    p_load.add_argument(
        "--config-only",
        action="store_true",
        help="write only referenceLayers, skip file upload (for a remote DB whose GeoJSON is already stored)",
    )
    p_push = sub.add_parser("push", help="upload GeoJSON + config to a RUNNING deployment via its API")
    p_push.add_argument("manifest")
    p_push.add_argument("--base", default=os.environ.get("KP_BASE_URL"), help="deployment base URL (env KP_BASE_URL)")
    p_push.add_argument("--admin-secret", default=os.environ.get("KP_ADMIN_SECRET"), help="deployment ADMIN_SECRET (env KP_ADMIN_SECRET)")
    p_push.add_argument("--dry-run", action="store_true", help="authenticate + report only, do not upload/write")
    sub.add_parser("show", help="print the stored referenceLayers")

    args = parser.parse_args(argv)

    if args.cmd == "schema":
        print(json.dumps(GeodataManifestEntry.model_json_schema(), indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "example":
        print(json.dumps(EXAMPLE_MANIFEST, indent=2, ensure_ascii=False))
        return 0
    if args.cmd in ("validate", "load"):
        path = Path(args.manifest)
        entries = _read_manifest(path)
        config_only = args.cmd == "load" and args.config_only
        # config-only never touches the files, so don't require them to be present/valid.
        counts = {} if config_only else _validate_files(path, entries)
        n_files = sum(1 for e in entries if e.kind == "geojson" and e.file)
        n_feats = sum(counts.values())
        if args.cmd == "validate" or args.dry_run:
            tag = "dry-run" if args.cmd == "load" else "valid"
            scope = " (config-only)" if config_only else f", {n_files} GeoJSON file(s), {n_feats} feature(s)"
            print(f"OK ({tag}): {len(entries)} layer(s){scope}. Nothing written.")
            return 0
        if config_only:
            layers = await _load_config_only(entries)
            print(f"OK: wrote {layers} referenceLayer(s) into deployment_config id=1 (config-only; files untouched).")
            return 0
        ds, layers = await _load(path, entries, counts)
        print(f"OK: wrote {ds} dataset(s) to the reference store and {layers} referenceLayer(s) into deployment_config id=1.")
        return 0
    if args.cmd == "push":
        if not args.base or not args.admin_secret:
            _fail("ERROR: push needs --base and --admin-secret (or KP_BASE_URL / KP_ADMIN_SECRET).")
        path = Path(args.manifest)
        entries = _read_manifest(path)
        if not args.dry_run:
            _validate_files(path, entries)  # reject bad/LV95 GeoJSON before uploading anything
        up, layers = _push(path, entries, args.base, args.admin_secret, args.dry_run)
        if not args.dry_run:
            print(f"OK: uploaded {up} file(s) and wrote {layers} referenceLayer(s) to {args.base}.")
        return 0
    # show
    layers = await _show()
    print(json.dumps(layers, indent=2, ensure_ascii=False) if layers else "No referenceLayers stored.")
    return 0


def main() -> None:
    sys.exit(asyncio.run(_amain(sys.argv[1:])))


if __name__ == "__main__":
    main()

"""Admin CLI for per-station EINSATZOBJEKTE — object plans as code (sibling to admin_geodata).

A station's pre-planned Einsatzobjekte (a site + its Modul-PDFs) are STATION DATA: they never
live in the open-source repo. They live in a private data repo as a ``plans/`` PDF folder + an
``objects.manifest.json``, produced there by the station-specific importer
(``scripts/import_einsatzplaene.py``, which walks the OneDrive plan library and geocodes). This
command loads that manifest into a running deployment — each object becomes an ``ObjectSite`` row,
each Modul-PDF a ``ReferenceDataset`` (``plan:<obj>:<module>``) with its blob in object storage,
served at ``/api/reference/<id>`` and auto-surfaced on a nearby incident (see
``src/lib/useObjectPlans.ts``).

It mirrors ``admin_geodata``: ``fetch_geodata.py`` → manifest+geojson → ``admin_geodata`` is the
geodata pipeline; ``import_einsatzplaene.py`` → manifest+plans → ``admin_objects`` is the objects
pipeline. The OSS CLI is generic (knows nothing about OneDrive); the private importer owns the
station specifics.

Run from ``backend/`` via ``uv run python -m app.admin_objects <cmd>`` (against SQLite locally,
or production by exporting ``DATABASE_URL`` first):

    schema                 print the JSON Schema of a manifest object (the contract)
    example                print a populated example manifest you can edit
    validate <manifest>    parse the manifest + check every referenced PDF exists (no DB)
    load <manifest>        upsert objects + copy PDFs into the store (writes DB + storage)
    load <manifest> --dry-run        same as validate (no write)
    push <manifest>        upload objects + PDFs to a RUNNING deployment via its API (remote-safe)
    show                   print the objects + plan counts currently stored

`load` writes PDFs to the LOCAL storage dir, so run it server-side for a remote DB. `push` instead
goes through a running server's HTTP API (ADMIN_SECRET), so the server writes its OWN volume — the
way to refresh a remote deployment's object plans from a workstation.

Manifest = a JSON list of objects (or ``{"objects": [...]}``). Paths in each plan's ``file`` are
resolved relative to the manifest's own directory. Object ``id`` is a stable UUID (the importer
derives a deterministic uuid5 per folder), so reruns upsert in place rather than duplicating.
"""

import argparse
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError, model_validator
from sqlalchemy import func, select

from . import storage
from .database import async_session_maker
from .models import ObjectSite, ReferenceDataset


class PlanEntry(BaseModel):
    """One Modul-PDF attached to an object. ``module`` is the app slot (``modul1`` … ``modul6``,
    or a named Modul-5 sub-slot like ``modul5-wasser`` / ``modul5-pv``)."""

    model_config = ConfigDict(extra="forbid")
    module: str
    file: str  # local PDF path, relative to the manifest's directory
    title: str | None = None
    sourceNote: str | None = None

    @model_validator(mode="after")
    def _check(self) -> "PlanEntry":
        if not self.module.strip():
            raise ValueError("plan: 'module' must not be empty")
        if len(self.module) > 16:
            raise ValueError(f"plan: module {self.module!r} exceeds 16 chars (DB column limit)")
        if not self.file.lower().endswith(".pdf"):
            raise ValueError(f"plan {self.module!r}: 'file' must be a .pdf ({self.file!r})")
        return self


class ObjectEntry(BaseModel):
    """One Einsatzobjekt in a station's objects manifest."""

    model_config = ConfigDict(extra="forbid")
    id: uuid.UUID
    name: str
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    sourceNote: str | None = None
    plans: list[PlanEntry] = []

    @model_validator(mode="after")
    def _check(self) -> "ObjectEntry":
        if not self.name.strip():
            raise ValueError(f"object {self.id}: 'name' must not be empty")
        if (self.lat is None) != (self.lng is None):
            raise ValueError(f"object {self.id}: lat and lng must both be set or both omitted")
        if self.lat is not None and (abs(self.lat) > 90 or abs(self.lng) > 180):
            raise ValueError(
                f"object {self.id}: ({self.lat}, {self.lng}) is not WGS84 [lat, lng] — reproject before loading"
            )
        seen: set[str] = set()
        for p in self.plans:
            if p.module in seen:
                raise ValueError(f"object {self.id}: duplicate plan module {p.module!r}")
            seen.add(p.module)
        return self


EXAMPLE_MANIFEST: dict[str, Any] = {
    "objects": [
        {
            "id": "11111111-2222-5333-8444-555555555555",
            "name": "Schulhaus Dorfmatt",
            "address": "Schulstrasse 7",
            "lat": 47.52382,
            "lng": 7.57037,
            "sourceNote": "Einsatzplan-Bibliothek: Schulhaus Dorfmatt",
            "plans": [
                {"module": "modul1", "file": "plans/dorfmatt/modul1.pdf", "title": "Schulhaus Dorfmatt – Übersicht"},
                {"module": "modul2", "file": "plans/dorfmatt/modul2-3.pdf", "title": "Schulhaus Dorfmatt – Umgebung"},
                {"module": "modul6", "file": "plans/dorfmatt/modul6.pdf", "title": "Schulhaus Dorfmatt – Gebäudepläne"},
                {"module": "modul5-wasser", "file": "plans/dorfmatt/modul5-wasser.pdf", "title": "Schulhaus Dorfmatt – Löschwasser"},
            ],
        }
    ]
}


def _fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


# --- manifest validation (no DB) --------------------------------------------------------


def _read_manifest(path: Path) -> list[ObjectEntry]:
    """Read + parse + validate a manifest file. Returns the objects. Exits on any error."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as e:
        _fail(f"ERROR: cannot read {path}: {e}")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        _fail(f"ERROR: {path} is not valid JSON: {e}")
    if isinstance(data, dict) and isinstance(data.get("objects"), list):
        data = data["objects"]
    if not isinstance(data, list):
        _fail(f"ERROR: {path} must be a JSON list of objects (or {{\"objects\": [...]}}).")
    objects: list[ObjectEntry] = []
    seen: set[uuid.UUID] = set()
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            _fail(f"ERROR: {path}[{i}] is not an object.")
        try:
            entry = ObjectEntry(**item)
        except ValidationError as e:
            lines = [f"ERROR: {path}[{i}] failed validation ({e.error_count()} issue(s)):"]
            for err in e.errors():
                field = ".".join(str(p) for p in err["loc"]) or "(root)"
                lines.append(f"  {field}: {err['msg']} [{err['type']}]")
            _fail("\n".join(lines))
        if entry.id in seen:
            _fail(f"ERROR: {path}: duplicate object id {entry.id}.")
        seen.add(entry.id)
        objects.append(entry)
    return objects


def _resolve(manifest_path: Path, plan: PlanEntry) -> Path:
    """Absolute path of a plan's PDF, relative to the manifest's directory."""
    return (manifest_path.parent / plan.file).resolve()


def _validate_files(manifest_path: Path, objects: list[ObjectEntry]) -> int:
    """Check every referenced PDF exists and starts with the PDF magic; return total plan count."""
    n = 0
    for o in objects:
        for p in o.plans:
            src = _resolve(manifest_path, p)
            if not src.is_file():
                _fail(f"ERROR: {manifest_path}: object {o.id} plan {p.module!r} file not found: {src}")
            with src.open("rb") as fh:
                if fh.read(5) != b"%PDF-":
                    _fail(f"ERROR: {src} is not a PDF (missing %PDF- header).")
            n += 1
    return n


# --- DB writes (server-side) ------------------------------------------------------------


async def _load(manifest_path: Path, objects: list[ObjectEntry]) -> tuple[int, int]:
    """Upsert objects + copy their PDFs into the local store. Returns (objects, plans) written."""
    async with async_session_maker() as db:
        n_plans = 0
        for o in objects:
            existing = (
                await db.execute(select(ObjectSite).where(ObjectSite.id == o.id))
            ).scalar_one_or_none()
            if existing is None:
                existing = ObjectSite(id=o.id)
                db.add(existing)
            existing.name = o.name
            existing.address = o.address
            existing.lat = o.lat
            existing.lng = o.lng
            existing.source_note = o.sourceNote

            for p in o.plans:
                ds_id = f"plan:{o.id}:{p.module}"
                src = _resolve(manifest_path, p)
                data = src.read_bytes()
                key = storage.new_key(f"plans/{o.id}", f"-{p.module}.pdf")
                storage.put_bytes(key, data)
                ds = (
                    await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == ds_id))
                ).scalar_one_or_none()
                if ds is None:
                    ds = ReferenceDataset(id=ds_id, object_id=o.id, module=p.module, kind="pdf")
                    db.add(ds)
                else:
                    ds.current_version += 1
                ds.object_id = o.id
                ds.module = p.module
                ds.kind = "pdf"
                ds.title = p.title or ds.title or f"{o.name} – {p.module}"
                ds.source_type = "uploaded"
                ds.source_note = p.sourceNote if p.sourceNote is not None else ds.source_note
                ds.storage_key = key
                ds.content_type = "application/pdf"
                ds.size_bytes = len(data)
                n_plans += 1
        await db.commit()
    return len(objects), n_plans


def _push(
    manifest_path: Path, objects: list[ObjectEntry], base: str, admin_secret: str, dry_run: bool
) -> tuple[int, int]:
    """Push objects + their PDFs to a RUNNING deployment over its HTTP API. Each object is PUT to
    /api/objects/<id> and each plan PUT to /api/objects/<id>/plans/<module> (the server writes its
    OWN volume). Authenticates with the deployment ADMIN_SECRET (not an editor PIN).
    Returns (objects, plans) written."""
    import httpx  # lazy: only `push` needs the network

    base = base.rstrip("/")
    total_plans = sum(len(o.plans) for o in objects)
    with httpx.Client(base_url=base, timeout=180.0) as c:
        r = c.post("/api/admin/login", json={"secret": admin_secret})
        if r.status_code != 200:
            _fail(f"ERROR: admin login to {base} failed ({r.status_code}): {r.text[:200]}")
        if dry_run:
            print(
                f"OK (dry-run): authenticated to {base}; would upsert {len(objects)} object(s) "
                f"and upload {total_plans} plan(s). Nothing written."
            )
            return 0, 0
        n_obj = n_plans = 0
        for o in objects:
            ro = c.put(
                f"/api/objects/{o.id}",
                json={
                    "name": o.name,
                    "address": o.address,
                    "lat": o.lat,
                    "lng": o.lng,
                    "source_note": o.sourceNote,
                },
            )
            if ro.status_code != 200:
                _fail(f"ERROR: upsert object {o.id} failed ({ro.status_code}): {ro.text[:200]}")
            n_obj += 1
            for p in o.plans:
                src = _resolve(manifest_path, p)
                form = {}
                if p.title:
                    form["title"] = p.title
                if p.sourceNote:
                    form["source_note"] = p.sourceNote
                rp = c.put(
                    f"/api/objects/{o.id}/plans/{p.module}",
                    files={"file": (src.name, src.read_bytes(), "application/pdf")},
                    data=form,
                )
                if rp.status_code != 200:
                    _fail(f"ERROR: upload {o.id}/{p.module} failed ({rp.status_code}): {rp.text[:200]}")
                n_plans += 1
            print(f"  ↑ {o.name}  ({len(o.plans)} plan(s))")
    return n_obj, n_plans


async def _show() -> list[dict[str, Any]]:
    async with async_session_maker() as db:
        objs = list((await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars())
        counts = dict(
            (
                await db.execute(
                    select(ReferenceDataset.object_id, func.count())
                    .where(ReferenceDataset.kind == "pdf")
                    .group_by(ReferenceDataset.object_id)
                )
            ).all()
        )
        return [
            {
                "id": str(o.id),
                "name": o.name,
                "address": o.address,
                "lat": float(o.lat) if o.lat is not None else None,
                "lng": float(o.lng) if o.lng is not None else None,
                "plans": int(counts.get(o.id, 0)),
            }
            for o in objs
        ]


# --- CLI --------------------------------------------------------------------------------


async def _amain(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.admin_objects",
        description="Load per-station Einsatzobjekte + Modul-PDFs (objects-as-code) into a deployment.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("schema", help="print the manifest-object JSON Schema (no DB)")
    sub.add_parser("example", help="print a populated example manifest (no DB)")
    p_val = sub.add_parser("validate", help="validate the manifest + referenced PDFs (no DB)")
    p_val.add_argument("manifest")
    p_load = sub.add_parser("load", help="upsert objects + copy PDFs into the store (writes DB + storage)")
    p_load.add_argument("manifest")
    p_load.add_argument("--dry-run", action="store_true", help="validate only, do not write")
    p_push = sub.add_parser("push", help="upload objects + PDFs to a RUNNING deployment via its API")
    p_push.add_argument("manifest")
    p_push.add_argument("--base", default=os.environ.get("KP_BASE_URL"), help="deployment base URL (env KP_BASE_URL)")
    p_push.add_argument("--admin-secret", default=os.environ.get("KP_ADMIN_SECRET"), help="deployment ADMIN_SECRET (env KP_ADMIN_SECRET)")
    p_push.add_argument("--dry-run", action="store_true", help="authenticate + report only, do not upload/write")
    sub.add_parser("show", help="print the stored objects + plan counts")

    args = parser.parse_args(argv)

    if args.cmd == "schema":
        print(json.dumps(ObjectEntry.model_json_schema(), indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "example":
        print(json.dumps(EXAMPLE_MANIFEST, indent=2, ensure_ascii=False))
        return 0
    if args.cmd in ("validate", "load"):
        path = Path(args.manifest)
        objects = _read_manifest(path)
        n_plans = _validate_files(path, objects)
        if args.cmd == "validate" or args.dry_run:
            tag = "dry-run" if args.cmd == "load" else "valid"
            print(f"OK ({tag}): {len(objects)} object(s), {n_plans} plan PDF(s). Nothing written.")
            return 0
        n_obj, written = await _load(path, objects)
        print(f"OK: upserted {n_obj} object(s) and wrote {written} plan(s) to the reference store.")
        return 0
    if args.cmd == "push":
        if not args.base or not args.admin_secret:
            _fail("ERROR: push needs --base and --admin-secret (or KP_BASE_URL / KP_ADMIN_SECRET).")
        path = Path(args.manifest)
        objects = _read_manifest(path)
        if not args.dry_run:
            _validate_files(path, objects)  # reject missing/non-PDF files before uploading anything
        n_obj, n_plans = _push(path, objects, args.base, args.admin_secret, args.dry_run)
        if not args.dry_run:
            print(f"OK: upserted {n_obj} object(s) and uploaded {n_plans} plan(s) to {args.base}.")
        return 0
    # show
    rows = await _show()
    print(json.dumps(rows, indent=2, ensure_ascii=False) if rows else "No objects stored.")
    return 0


def main() -> None:
    sys.exit(asyncio.run(_amain(sys.argv[1:])))


if __name__ == "__main__":
    main()

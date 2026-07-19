"""Admin CLI for per-station CHECKLISTS — checklist templates as code (sibling to admin_objects).

A station's checklists are STATION DATA: the FU phase task list, the Lagerapport agenda, and the
EL tactical playbook are the brigade's own documents and never live in the open-source repo. They
live in a private data repo as a ``checklists/`` folder (one JSON ``ChecklistTemplate`` per list,
plus playbook diagram images) + a ``checklists.manifest.json``. This command loads that manifest
into a running deployment — each template becomes a ``ReferenceDataset`` (``checklists:<id>``) and
each diagram a ``ReferenceDataset`` (``checklists:<id>:p<N>``), served at ``/api/reference/<id>``,
fetched + offline-cached by the Checkliste surface (see ``src/lib/checklists.ts``).

It mirrors ``admin_objects``: ``import_einsatzplaene.py`` → manifest+plans → ``admin_objects`` is
the objects pipeline; the station's checklist authoring → manifest+templates → ``admin_checklists``
is the checklists pipeline. The OSS CLI is generic; the private data repo owns the station content.

Run from ``backend/`` via ``uv run python -m app.admin_checklists <cmd>`` (against SQLite locally,
or production by exporting ``DATABASE_URL`` first):

    schema                 print the JSON Schema of a manifest entry (the contract)
    example                print a populated example manifest you can edit
    validate <manifest>    parse the manifest + check every template JSON + asset image (no DB)
    load <manifest>        upsert templates + copy assets into the store (writes DB + storage)
    load <manifest> --dry-run        same as validate (no write)
    push <manifest>        upload templates + assets to a RUNNING deployment via its API (remote-safe)
    show                   print the checklist templates + asset counts currently stored

`load` writes to the LOCAL storage dir, so run it server-side for a remote DB. `push` instead goes
through a running server's HTTP API (ADMIN_SECRET), so the server writes its OWN volume — the way
to refresh a remote deployment's checklists from a workstation.

Manifest = a JSON list of entries (or ``{"checklists": [...]}``). Paths in each ``file`` / asset
``file`` are resolved relative to the manifest's own directory. Entry ``id`` is a stable slug
(``fu-aktion``, ``el-playbook``); reruns upsert in place.
"""

import argparse
import asyncio
import json
import mimetypes
import os
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError, model_validator
from sqlalchemy import select

from . import storage
from .database import async_session_maker
from .models import ReferenceDataset

_TEMPLATE_KINDS = {"action", "rapport", "reference"}
_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".svg"}


class AssetEntry(BaseModel):
    """One diagram image for a reference template (a page from the source playbook PDF).
    Stored as ``checklists:<template>:p<page>`` and rendered inline by the reference reader."""

    model_config = ConfigDict(extra="forbid")
    page: int
    file: str  # local image path, relative to the manifest's directory

    @model_validator(mode="after")
    def _check(self) -> "AssetEntry":
        if self.page < 0:
            raise ValueError(f"asset: page {self.page} must be >= 0")
        if Path(self.file).suffix.lower() not in _IMAGE_EXT:
            raise ValueError(f"asset p{self.page}: 'file' must be an image {sorted(_IMAGE_EXT)} ({self.file!r})")
        return self


class ChecklistEntry(BaseModel):
    """One checklist template in a station's checklists manifest."""

    model_config = ConfigDict(extra="forbid")
    id: str
    kind: str
    title: str
    file: str  # local ChecklistTemplate JSON path, relative to the manifest's directory
    sourceNote: str | None = None
    order: int | None = None  # rail sort order; falls back to the manifest position if unset
    assets: list[AssetEntry] = []

    @model_validator(mode="after")
    def _check(self) -> "ChecklistEntry":
        if not self.id.strip() or ":" in self.id:
            raise ValueError(f"entry id {self.id!r} must be a non-empty slug without ':' (the id separator)")
        if self.kind not in _TEMPLATE_KINDS:
            raise ValueError(f"entry {self.id!r}: unknown kind {self.kind!r} (expected {sorted(_TEMPLATE_KINDS)})")
        if not self.file.lower().endswith(".json"):
            raise ValueError(f"entry {self.id!r}: 'file' must be a .json template ({self.file!r})")
        if self.assets and self.kind != "reference":
            raise ValueError(f"entry {self.id!r}: only reference templates carry diagram assets")
        seen: set[int] = set()
        for a in self.assets:
            if a.page in seen:
                raise ValueError(f"entry {self.id!r}: duplicate asset page {a.page}")
            seen.add(a.page)
        return self


EXAMPLE_MANIFEST: dict[str, Any] = {
    "checklists": [
        {
            "id": "fu-aktion",
            "kind": "action",
            "title": "Aufgaben FU",
            "file": "checklists/fu-aktion.json",
            "sourceNote": "Checklisten FU.pdf",
            "order": 1,
        },
        {
            "id": "lagerapport",
            "kind": "rapport",
            "title": "Lagerapport",
            "file": "checklists/lagerapport.json",
            "sourceNote": "Lagerapport_BL_BS.pdf",
            "order": 2,
        },
        {
            "id": "el-playbook",
            "kind": "reference",
            "title": "Einsatzleiter-Checklisten",
            "file": "checklists/el-playbook.json",
            "sourceNote": "Checklisten EL.pdf",
            "order": 3,
            "assets": [
                {"page": 12, "file": "checklists/assets/el-p12.jpg"},
                {"page": 14, "file": "checklists/assets/el-p14.jpg"},
            ],
        },
    ]
}


def _fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


# --- manifest validation (no DB) --------------------------------------------------------


def _read_manifest(path: Path) -> list[ChecklistEntry]:
    """Read + parse + validate a manifest file. Returns the entries. Exits on any error."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as e:
        _fail(f"ERROR: cannot read {path}: {e}")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        _fail(f"ERROR: {path} is not valid JSON: {e}")
    if isinstance(data, dict) and isinstance(data.get("checklists"), list):
        data = data["checklists"]
    if not isinstance(data, list):
        _fail(f"ERROR: {path} must be a JSON list of entries (or {{\"checklists\": [...]}}).")
    entries: list[ChecklistEntry] = []
    seen: set[str] = set()
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            _fail(f"ERROR: {path}[{i}] is not an object.")
        try:
            entry = ChecklistEntry(**item)
        except ValidationError as e:
            lines = [f"ERROR: {path}[{i}] failed validation ({e.error_count()} issue(s)):"]
            for err in e.errors():
                field = ".".join(str(p) for p in err["loc"]) or "(root)"
                lines.append(f"  {field}: {err['msg']} [{err['type']}]")
            _fail("\n".join(lines))
        if entry.id in seen:
            _fail(f"ERROR: {path}: duplicate entry id {entry.id!r}.")
        seen.add(entry.id)
        entries.append(entry)
    return entries


def _resolve(manifest_path: Path, rel: str) -> Path:
    """Absolute path of a manifest-relative file."""
    return (manifest_path.parent / rel).resolve()


def _validate_template_json(src: Path, entry: ChecklistEntry) -> None:
    """Parse a template JSON and check its shape matches the entry (same rules the API enforces)."""
    try:
        tpl = json.loads(src.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        _fail(f"ERROR: {src} is not readable JSON: {e}")
    if not isinstance(tpl, dict):
        _fail(f"ERROR: {src} must be a JSON object (a ChecklistTemplate).")
    if tpl.get("id") != entry.id:
        _fail(f"ERROR: {src}: template id {tpl.get('id')!r} != manifest id {entry.id!r}.")
    if tpl.get("kind") != entry.kind:
        _fail(f"ERROR: {src}: template kind {tpl.get('kind')!r} != manifest kind {entry.kind!r}.")
    has_phases = isinstance(tpl.get("phases"), list) and tpl["phases"]
    has_entries = isinstance(tpl.get("entries"), list) and tpl["entries"]
    if bool(has_phases) == bool(has_entries):
        _fail(f"ERROR: {src}: needs exactly one of 'phases' (action/rapport) or 'entries' (reference).")


def _validate_files(manifest_path: Path, entries: list[ChecklistEntry]) -> tuple[int, int]:
    """Check every template JSON + asset image exists and is well-formed; return (templates, assets)."""
    n_assets = 0
    for e in entries:
        src = _resolve(manifest_path, e.file)
        if not src.is_file():
            _fail(f"ERROR: {manifest_path}: entry {e.id!r} template file not found: {src}")
        _validate_template_json(src, e)
        for a in e.assets:
            asrc = _resolve(manifest_path, a.file)
            if not asrc.is_file():
                _fail(f"ERROR: {manifest_path}: entry {e.id!r} asset p{a.page} file not found: {asrc}")
            n_assets += 1
    return len(entries), n_assets


def _content_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _template_bytes(src: Path, order: int) -> bytes:
    """Read a template JSON and stamp the rail sort `order` into it, so the manifest is the single
    place a station controls checklist ordering (the served template carries `order`; the frontend
    sorts by it). Non-destructive to the source file — only the stored/uploaded copy gets `order`."""
    data = json.loads(src.read_text(encoding="utf-8"))
    data["order"] = order
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


def _expected_ids(entries: list[ChecklistEntry]) -> set[str]:
    """Every dataset id the manifest owns: checklists:<id> per template + checklists:<id>:p<N>
    per asset. Anything else under checklists:* is stale and gets pruned (rename/removal safety)."""
    ids: set[str] = set()
    for e in entries:
        ids.add(f"checklists:{e.id}")
        for a in e.assets:
            ids.add(f"checklists:{e.id}:p{a.page}")
    return ids


# --- DB writes (server-side) ------------------------------------------------------------


async def _upsert(db, ds_id: str, kind: str, title: str | None, source_note: str | None, data: bytes, content_type: str, storage_dir: str, suffix: str) -> None:
    key = storage.new_key(storage_dir, suffix)
    storage.put_bytes(key, data)
    ds = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == ds_id))).scalar_one_or_none()
    if ds is None:
        ds = ReferenceDataset(id=ds_id, kind=kind)
        db.add(ds)
    else:
        ds.current_version += 1
    ds.kind = kind
    if title is not None:
        ds.title = title
    ds.source_type = "uploaded"
    if source_note is not None:
        ds.source_note = source_note
    ds.storage_key = key
    ds.content_type = content_type
    ds.size_bytes = len(data)


async def _load(manifest_path: Path, entries: list[ChecklistEntry]) -> tuple[int, int, int]:
    """Upsert templates + copy their assets into the local store, then prune stale checklists:*
    datasets. Returns (templates, assets, pruned)."""
    async with async_session_maker() as db:
        n_assets = 0
        for idx, e in enumerate(entries):
            src = _resolve(manifest_path, e.file)
            await _upsert(
                db, f"checklists:{e.id}", "checklists", e.title, e.sourceNote,
                _template_bytes(src, e.order if e.order is not None else idx), "application/json", "reference", f"-checklists_{e.id}.json",
            )
            for a in e.assets:
                asrc = _resolve(manifest_path, a.file)
                await _upsert(
                    db, f"checklists:{e.id}:p{a.page}", "checklists", None, None,
                    asrc.read_bytes(), _content_type(asrc), "reference", f"-checklists_{e.id}_p{a.page}{asrc.suffix}",
                )
                n_assets += 1
        # prune ghosts: a renamed/removed template must not linger (the frontend would still fetch it)
        expected = _expected_ids(entries)
        stale = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id.like("checklists:%")))).scalars().all()
        n_pruned = 0
        for ds in stale:
            if ds.id not in expected:
                if ds.storage_key:
                    storage.delete(ds.storage_key)
                await db.delete(ds)
                n_pruned += 1
        await db.commit()
    return len(entries), n_assets, n_pruned


def _push(manifest_path: Path, entries: list[ChecklistEntry], base: str, admin_secret: str, dry_run: bool) -> tuple[int, int]:
    """Push templates + their assets to a RUNNING deployment over its HTTP API. Each is PUT to
    /api/reference/<id> (the server writes its OWN volume). Authenticates with the deployment
    ADMIN_SECRET (not an editor PIN). Returns (templates, assets) written."""
    import httpx  # lazy: only `push` needs the network

    base = base.rstrip("/")
    total_assets = sum(len(e.assets) for e in entries)
    with httpx.Client(base_url=base, timeout=180.0) as c:
        r = c.post("/api/admin/login", json={"secret": admin_secret})
        if r.status_code != 200:
            _fail(f"ERROR: admin login to {base} failed ({r.status_code}): {r.text[:200]}")
        if dry_run:
            print(
                f"OK (dry-run): authenticated to {base}; would upsert {len(entries)} template(s) "
                f"and upload {total_assets} asset(s). Nothing written."
            )
            return 0, 0
        n_tpl = n_assets = 0
        for idx, e in enumerate(entries):
            src = _resolve(manifest_path, e.file)
            form = {"title": e.title}
            if e.sourceNote:
                form["source_note"] = e.sourceNote
            rt = c.put(
                f"/api/reference/checklists:{e.id}",
                files={"file": (src.name, _template_bytes(src, e.order if e.order is not None else idx), "application/json")},
                data=form,
            )
            if rt.status_code != 200:
                _fail(f"ERROR: upload template {e.id!r} failed ({rt.status_code}): {rt.text[:200]}")
            n_tpl += 1
            for a in e.assets:
                asrc = _resolve(manifest_path, a.file)
                ra = c.put(
                    f"/api/reference/checklists:{e.id}:p{a.page}",
                    files={"file": (asrc.name, asrc.read_bytes(), _content_type(asrc))},
                )
                if ra.status_code != 200:
                    _fail(f"ERROR: upload asset {e.id}:p{a.page} failed ({ra.status_code}): {ra.text[:200]}")
                n_assets += 1
            print(f"  ↑ {e.title}  ({len(e.assets)} asset(s))")
        # prune ghosts server-side: delete any checklists:* not in this manifest (rename/removal safety)
        rp = c.post("/api/reference/checklists/prune", json=sorted(_expected_ids(entries)))
        if rp.status_code != 200:
            _fail(f"ERROR: prune failed ({rp.status_code}): {rp.text[:200]}")
        pruned = rp.json().get("pruned", [])
        if pruned:
            print(f"  ✗ pruned {len(pruned)} stale dataset(s): {', '.join(pruned)}")
    return n_tpl, n_assets


async def _show() -> list[dict[str, Any]]:
    async with async_session_maker() as db:
        rows = list(
            (
                await db.execute(
                    select(ReferenceDataset)
                    .where(ReferenceDataset.kind == "checklists")
                    .order_by(ReferenceDataset.id)
                )
            ).scalars()
        )
        # An id's segment after the `checklists:` prefix identifies the template; a further ':'
        # marks an asset (checklists:<template>:p<N>). Count assets per template.
        assets: dict[str, int] = {}
        for r in rows:
            rest = r.id[len("checklists:") :]
            if ":" in rest:
                assets[rest.split(":", 1)[0]] = assets.get(rest.split(":", 1)[0], 0) + 1
        return [
            {"id": r.id, "title": r.title, "assets": assets.get(r.id[len("checklists:") :], 0), "version": r.current_version}
            for r in rows
            if ":" not in r.id[len("checklists:") :]
        ]


# --- CLI --------------------------------------------------------------------------------


async def _amain(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.admin_checklists",
        description="Load per-station checklist templates + diagram assets (checklists-as-code) into a deployment.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("schema", help="print the manifest-entry JSON Schema (no DB)")
    sub.add_parser("example", help="print a populated example manifest (no DB)")
    p_val = sub.add_parser("validate", help="validate the manifest + referenced templates/assets (no DB)")
    p_val.add_argument("manifest")
    p_load = sub.add_parser("load", help="upsert templates + copy assets into the store (writes DB + storage)")
    p_load.add_argument("manifest")
    p_load.add_argument("--dry-run", action="store_true", help="validate only, do not write")
    p_push = sub.add_parser("push", help="upload templates + assets to a RUNNING deployment via its API")
    p_push.add_argument("manifest")
    p_push.add_argument("--base", default=os.environ.get("KP_BASE_URL"), help="deployment base URL (env KP_BASE_URL)")
    p_push.add_argument("--admin-secret", default=os.environ.get("KP_ADMIN_SECRET"), help="deployment ADMIN_SECRET (env KP_ADMIN_SECRET)")
    p_push.add_argument("--dry-run", action="store_true", help="authenticate + report only, do not upload/write")
    sub.add_parser("show", help="print the stored checklist templates + asset counts")

    args = parser.parse_args(argv)

    if args.cmd == "schema":
        print(json.dumps(ChecklistEntry.model_json_schema(), indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "example":
        print(json.dumps(EXAMPLE_MANIFEST, indent=2, ensure_ascii=False))
        return 0
    if args.cmd in ("validate", "load"):
        path = Path(args.manifest)
        entries = _read_manifest(path)
        n_tpl, n_assets = _validate_files(path, entries)
        if args.cmd == "validate" or args.dry_run:
            tag = "dry-run" if args.cmd == "load" else "valid"
            print(f"OK ({tag}): {n_tpl} template(s), {n_assets} asset image(s). Nothing written.")
            return 0
        n_tpl, written, pruned = await _load(path, entries)
        extra = f"; pruned {pruned} stale dataset(s)" if pruned else ""
        print(f"OK: upserted {n_tpl} template(s) and wrote {written} asset(s) to the reference store{extra}.")
        return 0
    if args.cmd == "push":
        if not args.base or not args.admin_secret:
            _fail("ERROR: push needs --base and --admin-secret (or KP_BASE_URL / KP_ADMIN_SECRET).")
        path = Path(args.manifest)
        entries = _read_manifest(path)
        if not args.dry_run:
            _validate_files(path, entries)  # reject missing/malformed files before uploading anything
        n_tpl, n_assets = _push(path, entries, args.base, args.admin_secret, args.dry_run)
        if not args.dry_run:
            print(f"OK: upserted {n_tpl} template(s) and uploaded {n_assets} asset(s) to {args.base}.")
        return 0
    # show
    rows = await _show()
    print(json.dumps(rows, indent=2, ensure_ascii=False) if rows else "No checklists stored.")
    return 0


def main() -> None:
    sys.exit(asyncio.run(_amain(sys.argv[1:])))


if __name__ == "__main__":
    main()

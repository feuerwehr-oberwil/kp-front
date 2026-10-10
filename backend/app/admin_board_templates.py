"""Admin CLI for per-station BOARD TEMPLATES — the Tafel's pages as code (sibling to admin_checklists).

A station's board templates (``board-template/1``, app/board_templates) are the paper forms its
Tafel offers under «+ Seite»: the FKS «Erste Führung» and Handbuch sheets as bundled, or the
station's own copy of them with its switches set (header line, trend, Erledigt …). They live in the
private data repo as a ``tafel/`` folder (one JSON file per template) + a ``tafel.manifest.json``,
and travel EXACTLY like the checklists: each template becomes a ``ReferenceDataset``
(``tafel:<id>``), served at ``/api/reference/tafel:<id>``, fetched + offline-cached by the Tafel
(src/lib/boardTemplates). ⚠️ A station set REPLACES the bundled FKS set — start the station copy
from ``src/data/boardTemplates/fks-erste-fuehrung.json`` (docs/board-templates.md).

Run from ``backend/`` via ``uv run python -m app.admin_board_templates <cmd>``:

    schema                 print the board-template/1 JSON Schema (the contract, docs/board-template.schema.json)
    example                print a populated example manifest you can edit
    validate <manifest>    parse the manifest + validate every template file (no DB)
    load <manifest>        upsert the templates into the store, prune the ones that left (writes DB + storage)
    load <manifest> --dry-run        same as validate (no write)
    push <manifest>        upload the templates to a RUNNING deployment via its API, prune there (remote-safe)
    show                   print the board templates currently stored

Manifest = a JSON list of entries (or ``{"templates": [...]}``); ``file`` is relative to the
manifest. The entry ``id`` must equal the template's own ``id``. Reruns upsert in place; a
template whose entry left the manifest is PRUNED, so a renamed or dropped one never lingers on
the tablets.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select

from . import storage
from .admin_checklists import _upsert
from .admin_cli import add_push_args, admin_client, fail, require_push_target
from .admin_manifest import template_hint
from .board_templates import BoardTemplate, LabelSet, parse_board_template, template_json_schema
from .database import async_session_maker
from .models import ReferenceDataset

PREFIX = "tafel:"
KIND = "tafel"


class TemplateEntry(BaseModel):
    """One board template in the manifest."""

    model_config = ConfigDict(extra="forbid")

    #: stable slug — the dataset is ``tafel:<id>``; must equal the template's own ``id``
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*$", max_length=64)
    #: the template JSON, relative to the manifest
    file: str
    sourceNote: str | None = None


EXAMPLE_MANIFEST = {
    "templates": [
        {
            "id": "fks-erste-fuehrung",
            "file": "tafel/fks-erste-fuehrung.json",
            "sourceNote": "FKS Plakat «Erste Führung» + Handbuch Grossereignisse Kap. 8, Stationskopie",
        }
    ]
}


def _read_manifest(path: Path) -> list[TemplateEntry]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as e:
        fail(f"ERROR: cannot read {path}: {e}")
    except json.JSONDecodeError as e:
        fail(f"ERROR: {path} is not valid JSON: {e}")
    if isinstance(data, dict) and isinstance(data.get("templates"), list):
        data = data["templates"]
    if not isinstance(data, list):
        fail(f'ERROR: {path} must be a JSON list of entries (or {{"templates": [...]}}).')
    entries: list[TemplateEntry] = []
    seen: set[str] = set()
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            fail(f"ERROR: {path}[{i}] is not an object.")
        try:
            entry = TemplateEntry(**item)
        except ValidationError as e:
            lines = [f"ERROR: {path}[{i}] failed validation ({e.error_count()} issue(s)):"]
            for err in e.errors():
                field = ".".join(str(p) for p in err["loc"]) or "(root)"
                lines.append(f"  {field}: {err['msg']} [{err['type']}]")
            fail("\n".join(lines))
        if entry.id in seen:
            fail(f"ERROR: {path}: duplicate entry id {entry.id!r}.")
        seen.add(entry.id)
        entries.append(entry)
    return entries


def _resolve(manifest_path: Path, rel: str) -> Path:
    return (manifest_path.parent / rel).resolve()


def _title(t: BoardTemplate) -> str:
    return t.title.de if isinstance(t.title, LabelSet) else t.title


def _load_templates(
    manifest_path: Path, entries: list[TemplateEntry]
) -> list[tuple[TemplateEntry, BoardTemplate, bytes]]:
    """Every template file read and validated — the same rules the upload API enforces."""
    out: list[tuple[TemplateEntry, BoardTemplate, bytes]] = []
    for e in entries:
        src = _resolve(manifest_path, e.file)
        if not src.is_file():
            fail(
                f"ERROR: {manifest_path}: entry {e.id!r} template file not found: {src}"
                + template_hint(manifest_path, complete_example="examples/demo-data/tafel.manifest.json")
            )
        raw = src.read_bytes()
        try:
            tpl = parse_board_template(raw)
        except ValueError as err:
            fail(f"ERROR: {src}: {err}")
        if tpl.id != e.id:
            fail(f"ERROR: {src}: template id {tpl.id!r} != manifest id {e.id!r}.")
        out.append((e, tpl, raw))
    return out


def expected_ids(entries: list[TemplateEntry]) -> set[str]:
    """Every dataset the manifest owns; anything else under ``tafel:`` is stale and pruned."""
    return {f"{PREFIX}{e.id}" for e in entries}


async def _load(templates: list[tuple[TemplateEntry, BoardTemplate, bytes]]) -> tuple[int, int]:
    async with async_session_maker() as db:
        for e, tpl, raw in templates:
            await _upsert(
                db,
                f"{PREFIX}{e.id}",
                KIND,
                _title(tpl),
                e.sourceNote,
                raw,
                "application/json",
                "reference",
                f"-tafel_{e.id}.json",
            )
        keep = expected_ids([e for e, _t, _r in templates])
        stale = (
            (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id.like(f"{PREFIX}%")))).scalars().all()
        )
        n_pruned = 0
        for ds in stale:
            if ds.id not in keep:
                if ds.storage_key:
                    storage.delete_after_commit(db, ds.storage_key)
                await db.delete(ds)
                n_pruned += 1
        await db.commit()
    return len(templates), n_pruned


def _push(
    templates: list[tuple[TemplateEntry, BoardTemplate, bytes]], base: str, admin_secret: str, dry_run: bool
) -> int:
    base = base.rstrip("/")
    with admin_client(base, admin_secret, timeout=120.0) as c:
        if dry_run:
            print(
                f"OK (dry-run): authenticated to {base}; would upsert {len(templates)} board template(s). Nothing written."
            )
            return 0
        for e, tpl, raw in templates:
            form = {"title": _title(tpl)}
            if e.sourceNote:
                form["source_note"] = e.sourceNote
            r = c.put(
                f"/api/reference/{PREFIX}{e.id}", files={"file": (f"{e.id}.json", raw, "application/json")}, data=form
            )
            if r.status_code != 200:
                fail(f"ERROR: upload board template {e.id!r} failed ({r.status_code}): {r.text[:200]}")
            print(f"  ↑ {_title(tpl)}  ({len(tpl.pages)} page(s), version {tpl.version})")
        rp = c.post("/api/reference/tafel/prune", json=sorted(expected_ids([e for e, _t, _r in templates])))
        if rp.status_code != 200:
            fail(f"ERROR: prune failed ({rp.status_code}): {rp.text[:200]}")
        pruned = rp.json().get("pruned", [])
        if pruned:
            print(f"  ✗ pruned {len(pruned)} stale board template(s): {', '.join(pruned)}")
    return len(templates)


async def _show() -> list[dict[str, Any]]:
    async with async_session_maker() as db:
        rows = (
            await db.execute(
                select(ReferenceDataset).where(ReferenceDataset.kind == KIND).order_by(ReferenceDataset.id)
            )
        ).scalars()
        return [{"id": r.id, "title": r.title, "version": r.current_version, "bytes": r.size_bytes} for r in rows]


async def _amain(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.admin_board_templates",
        description="Load per-station board templates (the Tafel's pages, board-template/1) into a deployment.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("schema", help="print the board-template/1 JSON Schema (no DB)")
    sub.add_parser("example", help="print a populated example manifest (no DB)")
    p_val = sub.add_parser("validate", help="validate the manifest + every template file (no DB)")
    p_val.add_argument("manifest")
    p_load = sub.add_parser("load", help="upsert the templates into the store + prune (writes DB + storage)")
    p_load.add_argument("manifest")
    p_load.add_argument("--dry-run", action="store_true", help="validate only, do not write")
    p_push = sub.add_parser("push", help="upload the templates to a RUNNING deployment via its API + prune")
    p_push.add_argument("manifest")
    add_push_args(p_push, dry_run_help="authenticate + report only, do not upload/write")
    sub.add_parser("show", help="print the stored board templates")
    args = parser.parse_args(argv)

    if args.cmd == "schema":
        print(json.dumps(template_json_schema(), indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "example":
        print(json.dumps(EXAMPLE_MANIFEST, indent=2, ensure_ascii=False))
        return 0
    if args.cmd in ("validate", "load"):
        path = Path(args.manifest)
        templates = _load_templates(path, _read_manifest(path))
        if args.cmd == "validate" or args.dry_run:
            tag = "dry-run" if args.cmd == "load" else "valid"
            pages = sum(len(t.pages) for _e, t, _r in templates)
            print(f"OK ({tag}): {len(templates)} board template(s), {pages} page(s). Nothing written.")
            return 0
        n, pruned = await _load(templates)
        extra = f"; pruned {pruned} stale template(s)" if pruned else ""
        print(f"OK: upserted {n} board template(s) into the reference store{extra}.")
        return 0
    if args.cmd == "push":
        require_push_target(args)
        path = Path(args.manifest)
        # a malformed file is refused before anything is uploaded (a dry run checks it too)
        templates = _load_templates(path, _read_manifest(path))
        n = _push(templates, args.base, args.admin_secret, args.dry_run)
        if not args.dry_run:
            print(f"OK: upserted {n} board template(s) to {args.base}.")
        return 0
    rows = await _show()
    print(json.dumps(rows, indent=2, ensure_ascii=False) if rows else "No board templates stored.")
    return 0


def main() -> None:
    sys.exit(asyncio.run(_amain(sys.argv[1:])))


if __name__ == "__main__":
    main()

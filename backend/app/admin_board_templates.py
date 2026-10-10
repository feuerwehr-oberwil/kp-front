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
    load <manifest>        upsert the templates into the store (writes DB + storage)
    load <manifest> --dry-run        validate + list what would be upserted and what --prune would delete
    push <manifest>        upload the templates to a RUNNING deployment via its API (remote-safe)
    … --prune              ALSO delete every stored template the manifest does not list (never implicit)
    show                   print the board templates currently stored

Manifest = a JSON list of entries (or ``{"templates": [...]}``); ``file`` is relative to the
manifest. The entry ``id`` must equal the template's own ``id``. Reruns upsert in place. A
template whose entry left the manifest is only LISTED as a prune candidate — an /admin upload
looks exactly like one — and deleted with an explicit ``--prune``. An empty manifest is refused
(review of #338).
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
    """Every dataset the manifest owns; anything else under ``tafel:`` is a prune candidate."""
    return {f"{PREFIX}{e.id}" for e in entries}


def prune_candidates(stored_ids: list[str], entries: list[TemplateEntry]) -> list[str]:
    """What a ``--prune`` would delete: every stored board template the manifest does not list —
    a template uploaded through /admin included, which is why pruning is never implicit."""
    keep = expected_ids(entries)
    return sorted(i for i in stored_ids if i.startswith(PREFIX) and i not in keep)


def _report_stale(stale: list[str], pruned: bool) -> None:
    if not stale:
        return
    if pruned:
        print(f"  ✗ pruned {len(stale)} board template(s) not in the manifest: {', '.join(stale)}")
    else:
        print(
            f"  ! {len(stale)} stored board template(s) not in the manifest, LEFT IN PLACE: {', '.join(stale)}\n"
            "    (an /admin upload is one of them? keep it, or add --prune to delete what the manifest does not list)"
        )


async def _stored_ids(db) -> list[str]:
    rows = (await db.execute(select(ReferenceDataset.id).where(ReferenceDataset.id.like(f"{PREFIX}%")))).scalars().all()
    return list(rows)


async def _load(
    templates: list[tuple[TemplateEntry, BoardTemplate, bytes]], prune: bool, dry_run: bool = False
) -> tuple[int, list[str]]:
    entries = [e for e, _t, _r in templates]
    async with async_session_maker() as db:
        stale = prune_candidates(await _stored_ids(db), entries)
        if dry_run:
            return 0, stale
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
        if prune and stale:
            rows = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id.in_(stale)))).scalars().all()
            for ds in rows:
                if ds.storage_key:
                    storage.delete_after_commit(db, ds.storage_key)
                await db.delete(ds)
        await db.commit()
    return len(templates), stale


def _push(
    templates: list[tuple[TemplateEntry, BoardTemplate, bytes]],
    base: str,
    admin_secret: str,
    dry_run: bool,
    prune: bool,
) -> int:
    base = base.rstrip("/")
    entries = [e for e, _t, _r in templates]
    with admin_client(base, admin_secret, timeout=120.0) as c:
        listed = c.get("/api/reference")
        if listed.status_code != 200:
            fail(f"ERROR: cannot list the deployment's datasets ({listed.status_code}): {listed.text[:200]}")
        stale = prune_candidates([d.get("id", "") for d in listed.json() if isinstance(d, dict)], entries)
        if dry_run:
            print(f"OK (dry-run): authenticated to {base}; would upsert {len(templates)} board template(s):")
            for e, tpl, _r in templates:
                print(f"  ↑ {PREFIX}{e.id}  {_title(tpl)} (version {tpl.version})")
            if stale:
                what = "would PRUNE" if prune else "would leave in place (no --prune)"
                print(f"  {what}: {', '.join(stale)}")
            print("Nothing written.")
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
        if prune and stale:
            rp = c.post("/api/reference/tafel/prune", json=sorted(expected_ids(entries)))
            if rp.status_code != 200:
                fail(f"ERROR: prune failed ({rp.status_code}): {rp.text[:200]}")
            _report_stale(rp.json().get("pruned", []), True)
        else:
            _report_stale(stale, False)
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
    prune_help = "also DELETE every stored board template the manifest does not list (an /admin upload too)"
    p_load = sub.add_parser("load", help="upsert the templates into the store (writes DB + storage)")
    p_load.add_argument("manifest")
    p_load.add_argument("--dry-run", action="store_true", help="validate + list what would change, write nothing")
    p_load.add_argument("--prune", action="store_true", help=prune_help)
    p_push = sub.add_parser("push", help="upload the templates to a RUNNING deployment via its API")
    p_push.add_argument("manifest")
    p_push.add_argument("--prune", action="store_true", help=prune_help)
    add_push_args(p_push, dry_run_help="authenticate + list what would change, upload nothing")
    sub.add_parser("show", help="print the stored board templates")
    args = parser.parse_args(argv)

    if args.cmd == "schema":
        print(json.dumps(template_json_schema(), indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "example":
        print(json.dumps(EXAMPLE_MANIFEST, indent=2, ensure_ascii=False))
        return 0
    if args.cmd in ("validate", "load", "push"):
        path = Path(args.manifest)
        entries = _read_manifest(path)
        # an empty manifest is never «the station has no templates»: with --prune it would delete
        # every one of them, without it it does nothing — either way it is a mistake to say so
        if not entries:
            fail(f"ERROR: {path} lists no board template. (Removing them all is /admin › Tafel-Vorlagen's job.)")
        # a malformed file is refused before anything is written or uploaded (a dry run checks it too)
        templates = _load_templates(path, entries)
        if args.cmd == "validate":
            pages = sum(len(t.pages) for _e, t, _r in templates)
            print(f"OK (valid): {len(templates)} board template(s), {pages} page(s). Nothing written.")
            return 0
        if args.cmd == "load":
            n, stale = await _load(templates, args.prune, args.dry_run)
            if args.dry_run:
                print(f"OK (dry-run): would upsert {len(templates)} board template(s).")
                if stale:
                    what = "would PRUNE" if args.prune else "would leave in place (no --prune)"
                    print(f"  {what}: {', '.join(stale)}")
                print("Nothing written.")
                return 0
            print(f"OK: upserted {n} board template(s) into the reference store.")
            _report_stale(stale, args.prune)
            return 0
        require_push_target(args)
        n = _push(templates, args.base, args.admin_secret, args.dry_run, args.prune)
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

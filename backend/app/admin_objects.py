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

Run from ``backend/`` via ``uv run python -m app.admin_objects <cmd>``. It talks to whatever
``DATABASE_URL`` points at — the local dev Postgres from ``just db`` by default; export a
different ``DATABASE_URL`` to target another deployment. (kp-front is Postgres-only: there is
no database file anywhere. SQLite exists solely as a pytest fallback.)

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
resolved relative to the manifest's own directory. Every object is keyed by a stable UUID, so
reruns upsert in place rather than duplicating — give it either as ``id`` (what the private
importer's deterministic uuid5 per folder writes) or, when a human maintains the manifest, as
``key``: a short string this module hashes to the same uuid5 every time (see
:func:`object_id_for_key`).
"""

import argparse
import asyncio
import hashlib
import json
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import func, select

from . import storage
from .admin_cli import add_push_args, admin_client, fail, require_push_target
from .admin_manifest import template_hint
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
    #: Optional SHA-256 of the PDF, lower-case hex. Set it and every `validate`/`load`/`push`
    #: refuses to publish anything else under this module.
    #:
    #: ⚠️ This is not a corruption check — it is a WRONG-TREE check, and on its own it is only
    #: half of one. A manifest is published from whatever checkout runs the script, so a stale
    #: worktree quietly republishes whatever PDFs it happens to hold: on 09.08. the demo went
    #: back to the generated placeholders (and a Modul 6 retired the day before) because a reset
    #: ran from a tree that predated the drawn sheets — twice, hours apart, the second time from
    #: a checkout at v0.1.0. This pin catches only the case where the MANIFEST is current and the
    #: PDF beside it is not; an old tree brings an old manifest *and* an old copy of this file,
    #: so nothing here ever runs. The half that does hold is server-side —
    #: ``api/objects._check_plan_digest`` + ``REQUIRE_PLAN_DIGEST`` — because the server is the
    #: only participant that cannot itself be stale.
    sha256: str | None = None

    @model_validator(mode="after")
    def _check(self) -> "PlanEntry":
        if not self.module.strip():
            raise ValueError("plan: 'module' must not be empty")
        if len(self.module) > 16:
            raise ValueError(f"plan: module {self.module!r} exceeds 16 chars (DB column limit)")
        if not self.file.lower().endswith(".pdf"):
            raise ValueError(f"plan {self.module!r}: 'file' must be a .pdf ({self.file!r})")
        if self.sha256 is not None:
            digest = self.sha256.strip().lower()
            if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
                raise ValueError(f"plan {self.module!r}: 'sha256' must be 64 hex characters ({self.sha256!r})")
            object.__setattr__(self, "sha256", digest)
        return self


#: Namespace for :func:`object_id_for_key`. ⚠️ NEVER change this value: it is half of what makes
#: a ``key`` mean the same Einsatzobjekt next year as it does today. Changing it would turn every
#: keyed manifest into a set of brand-new objects on the next load.
OBJECT_KEY_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://kp-front.ch/einsatzobjekte")


def object_id_for_key(key: str) -> uuid.UUID:
    """The stable object UUID for a station's own ``key`` (uuid5, so the same key always wins).

    An id an operator invents by hand is a trap: the shipped example manifest carried a literal
    ``11111111-2222-5333-8444-555555555555``, and a UUID that is reused (or retyped with one
    digit wrong) a year later silently DUPLICATES the object instead of updating it — the
    upsert matches on the id and nothing else. A ``key`` is retypable: it is the station's own
    name for the site ("schulhaus-dorfmatt"), and the same key hashes to the same id from any
    checkout, on any machine, forever.

    Normalised before hashing — whitespace collapsed and case folded — so «Schulhaus Dorfmatt»,
    «schulhaus dorfmatt» and a stray trailing space are one object, not three.
    """
    normalised = " ".join(key.split()).casefold()
    if not normalised:
        raise ValueError("object 'key' must not be empty")
    return uuid.uuid5(OBJECT_KEY_NAMESPACE, normalised)


class ObjectEntry(BaseModel):
    """One Einsatzobjekt in a station's objects manifest."""

    model_config = ConfigDict(extra="forbid")
    #: The object's stable UUID. Give this OR ``key``, not neither. Machine-generated manifests
    #: (the private importer) write the uuid5 they derived; a hand-maintained manifest is far
    #: better off with ``key``, which produces the same id without anyone inventing a UUID.
    id: uuid.UUID | None = Field(
        default=None,
        description=(
            "Stable UUID of this Einsatzobjekt — the upsert key, so it must be the SAME value "
            "every time this object is loaded. Optional if 'key' is given (then it is derived "
            "from it, uuid5). Do not invent one by hand and do not copy the example's: a reused "
            "or mistyped UUID creates a second object instead of updating the first."
        ),
    )
    #: A stable, human-retypable name for this object, hashed to ``id``. See ``object_id_for_key``.
    key: str | None = Field(
        default=None,
        description=(
            "The station's own stable name for this object (e.g. 'schulhaus-dorfmatt'), hashed "
            "to a fixed uuid5 that becomes 'id'. Use this instead of 'id' in a manifest a person "
            "maintains: the same key always addresses the same Einsatzobjekt, so retyping it "
            "next year updates the object rather than duplicating it. Case and surrounding "
            "whitespace are ignored. Independent of 'sourceKey', which the plan pull matches on."
        ),
    )
    name: str
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    #: The station's stable key for this object (e.g. the source folder name). Optional.
    #: Set it if a scheduled pull should be able to match plans to this object.
    sourceKey: str | None = None
    sourceNote: str | None = None
    plans: list[PlanEntry] = []

    @property
    def object_id(self) -> uuid.UUID:
        """The UUID this entry upserts under — ``id`` verbatim, or the uuid5 of ``key``.

        Always resolvable: ``_check`` refuses an entry that carries neither.
        """
        return self.id if self.id is not None else object_id_for_key(self.key or "")

    @model_validator(mode="after")
    def _check(self) -> "ObjectEntry":
        if self.id is None and self.key is None:
            raise ValueError(
                f"object {self.name!r}: needs 'key' (recommended — a stable name we hash to a "
                "uuid5) or 'id' (an explicit UUID). One of them is what makes a rerun update "
                "this object instead of creating a second one."
            )
        if self.key is not None and not self.key.strip():
            raise ValueError("object: 'key' must not be empty")
        if self.id is not None and self.key is not None and self.id != object_id_for_key(self.key):
            raise ValueError(
                f"object {self.name!r}: 'id' {self.id} is not the uuid5 of 'key' {self.key!r} "
                f"(that would be {object_id_for_key(self.key)}). Keep whichever one already "
                "addresses the stored object and drop the other — two disagreeing keys is how "
                "an object gets duplicated."
            )
        oid = self.object_id
        if not self.name.strip():
            raise ValueError(f"object {oid}: 'name' must not be empty")
        if (self.lat is None) != (self.lng is None):
            raise ValueError(f"object {oid}: lat and lng must both be set or both omitted")
        if self.lat is not None and self.lng is not None and (abs(self.lat) > 90 or abs(self.lng) > 180):
            raise ValueError(
                f"object {oid}: ({self.lat}, {self.lng}) is not WGS84 [lat, lng] — reproject before loading"
            )
        seen: set[str] = set()
        for p in self.plans:
            if p.module in seen:
                raise ValueError(f"object {oid}: duplicate plan module {p.module!r}")
            seen.add(p.module)
        return self


EXAMPLE_MANIFEST: dict[str, Any] = {
    "objects": [
        {
            # `key`, not a literal UUID: the placeholder that used to sit here got copied,
            # reused and retyped, and every one of those is a duplicated object rather than an
            # updated one. A key is retypable and hashes to the same id every time.
            "key": "schulhaus-dorfmatt",
            "name": "Schulhaus Dorfmatt",
            "address": "Schulstrasse 7",
            "lat": 47.52382,
            "lng": 7.57037,
            "sourceNote": "Einsatzplan-Bibliothek: Schulhaus Dorfmatt",
            "plans": [
                {"module": "modul1", "file": "plans/dorfmatt/modul1.pdf", "title": "Schulhaus Dorfmatt – Übersicht"},
                {"module": "modul2", "file": "plans/dorfmatt/modul2-3.pdf", "title": "Schulhaus Dorfmatt – Umgebung"},
                {"module": "modul6", "file": "plans/dorfmatt/modul6.pdf", "title": "Schulhaus Dorfmatt – Gebäudepläne"},
                {
                    "module": "modul5-wasser",
                    "file": "plans/dorfmatt/modul5-wasser.pdf",
                    "title": "Schulhaus Dorfmatt – Löschwasser",
                },
            ],
        }
    ]
}


# --- manifest validation (no DB) --------------------------------------------------------


def _read_manifest(path: Path) -> list[ObjectEntry]:
    """Read + parse + validate a manifest file. Returns the objects. Exits on any error."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as e:
        fail(f"ERROR: cannot read {path}: {e}")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        fail(f"ERROR: {path} is not valid JSON: {e}")
    if isinstance(data, dict) and isinstance(data.get("objects"), list):
        data = data["objects"]
    if not isinstance(data, list):
        fail(f'ERROR: {path} must be a JSON list of objects (or {{"objects": [...]}}).')
    objects: list[ObjectEntry] = []
    seen: set[uuid.UUID] = set()
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            fail(f"ERROR: {path}[{i}] is not an object.")
        try:
            entry = ObjectEntry(**item)
        except ValidationError as e:
            lines = [f"ERROR: {path}[{i}] failed validation ({e.error_count()} issue(s)):"]
            for err in e.errors():
                field = ".".join(str(p) for p in err["loc"]) or "(root)"
                lines.append(f"  {field}: {err['msg']} [{err['type']}]")
            fail("\n".join(lines))
        if entry.object_id in seen:
            fail(f"ERROR: {path}: duplicate object id {entry.object_id} ({entry.name!r}).")
        seen.add(entry.object_id)
        objects.append(entry)
    return objects


def _resolve(manifest_path: Path, plan: PlanEntry) -> Path:
    """Absolute path of a plan's PDF, relative to the manifest's directory."""
    return (manifest_path.parent / plan.file).resolve()


def _validate_files(manifest_path: Path, objects: list[ObjectEntry]) -> int:
    """Check every referenced PDF exists, is a PDF, and — where the manifest pins one — matches
    its recorded SHA-256. Returns the total plan count.

    The digest check runs on EVERY door (`validate`, `load`, `push`), because the failure it
    guards is publishing from the wrong tree, and the wrong tree is exactly the one that would
    skip a separate verification step.
    """
    n = 0
    for o in objects:
        for p in o.plans:
            src = _resolve(manifest_path, p)
            if not src.is_file():
                fail(
                    f"ERROR: {manifest_path}: object {o.object_id} plan {p.module!r} file not found: {src}"
                    + template_hint(manifest_path, complete_example="examples/demo-data/objects.manifest.json")
                )
            raw = src.read_bytes()
            if raw[:5] != b"%PDF-":
                fail(f"ERROR: {src} is not a PDF (missing %PDF- header).")
            if p.sha256:
                actual = hashlib.sha256(raw).hexdigest()
                if actual != p.sha256:
                    fail(
                        f"ERROR: {src} is not the plan this manifest pins.\n"
                        f"       expected sha256 {p.sha256}\n"
                        f"       actual   sha256 {actual}  ({len(raw)} bytes)\n"
                        f"       This usually means the checkout is stale — publishing it would put the "
                        f"wrong sheet in front of a crew. Update the tree, or re-pin the digest if the "
                        f"new PDF is the intended one."
                    )
            n += 1
    return n


# --- DB writes (server-side) ------------------------------------------------------------


@dataclass
class WriteResult:
    """What a `load` or `push` actually did — the thing the command has to print.

    Both used to answer with two integers, which could not tell «created» from «updated» and
    had no way at all to say «this plan did not land». During a fresh-station install a push
    produced an object with no plans, no output and exit 0, and the operator had no way to know
    the difference between that and success. Silence is not a report.
    """

    created: list[str] = field(default_factory=list)  # object names newly inserted
    updated: list[str] = field(default_factory=list)  # object names that already existed
    #: Plan PDFs attached — or, on a dry run, the number that would be.
    plans_written: int = 0
    #: (object name, module, why) for every plan the run did NOT attach. Never silent: a run
    #: with anything in here reports INCOMPLETE and exits non-zero.
    plans_skipped: list[tuple[str, str, str]] = field(default_factory=list)

    def report(self, *, where: str, dry_run: bool = False) -> int:
        """Print the summary and return the process exit code (non-zero if anything was skipped)."""
        counts = f"{len(self.created)} object(s) created, {len(self.updated)} updated"
        if dry_run:
            print(
                f"OK (dry-run): would be {counts}, {self.plans_written} plan PDF(s) uploaded {where}. Nothing written."
            )
            return 0
        for name, module, why in self.plans_skipped:
            print(f"  ! {name} / {module} — NOT attached: {why}", file=sys.stderr)
        if self.plans_skipped:
            print(
                f"INCOMPLETE: {counts}, {self.plans_written} plan PDF(s) attached, "
                f"{len(self.plans_skipped)} NOT attached {where}. Nothing else was changed — "
                f"fix the reasons above and run it again."
            )
            return 1
        print(f"OK: {counts}, {self.plans_written} plan PDF(s) attached {where}.")
        return 0


async def _load(manifest_path: Path, objects: list[ObjectEntry]) -> WriteResult:
    """Upsert objects + copy their PDFs into the local store."""
    res = WriteResult()
    async with async_session_maker() as db:
        for o in objects:
            oid = o.object_id
            existing = (await db.execute(select(ObjectSite).where(ObjectSite.id == oid))).scalar_one_or_none()
            is_new = existing is None
            if existing is None:
                existing = ObjectSite(id=oid)
                db.add(existing)
                res.created.append(o.name)
            else:
                res.updated.append(o.name)
            existing.name = o.name
            existing.address = o.address
            existing.lat = o.lat
            existing.lng = o.lng
            existing.source_key = o.sourceKey
            existing.source_note = o.sourceNote

            for p in o.plans:
                ds_id = f"plan:{oid}:{p.module}"
                src = _resolve(manifest_path, p)
                data = src.read_bytes()
                key = storage.new_key(f"plans/{oid}", f"-{p.module}.pdf")
                storage.put_bytes(key, data)
                ds = (
                    await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == ds_id))
                ).scalar_one_or_none()
                storage.replaced_in_transaction(db, new_key=key, old_key=ds.storage_key if ds is not None else None)
                if ds is None:
                    ds = ReferenceDataset(id=ds_id, object_id=oid, module=p.module, kind="pdf")
                    db.add(ds)
                else:
                    ds.current_version += 1
                ds.object_id = oid
                ds.module = p.module
                ds.kind = "pdf"
                ds.title = p.title or ds.title or f"{o.name} – {p.module}"
                ds.source_type = "uploaded"
                ds.source_note = p.sourceNote if p.sourceNote is not None else ds.source_note
                ds.storage_key = key
                ds.content_type = "application/pdf"
                ds.size_bytes = len(data)
                res.plans_written += 1
            print(f"  {'+' if is_new else '~'} {o.name}  ({len(o.plans)} plan PDF(s))")
        await db.commit()
    return res


def _push(manifest_path: Path, objects: list[ObjectEntry], base: str, admin_secret: str, dry_run: bool) -> WriteResult:
    """Push objects + their PDFs to a RUNNING deployment over its HTTP API. Each object is PUT to
    /api/objects/<id> and each plan PUT to /api/objects/<id>/plans/<module> (the server writes its
    OWN volume). Authenticates with the deployment ADMIN_SECRET (not an editor PIN).

    Reads the deployment's current object list first — one GET — purely so the run can say which
    objects it CREATED and which it updated. An upsert answers 200 either way, and «upserted 3
    objects» is the sentence that hid a fresh-station install writing an object nobody expected.
    """
    base = base.rstrip("/")
    res = WriteResult()
    with admin_client(base, admin_secret, timeout=180.0) as c:
        rl = c.get("/api/objects")
        if rl.status_code != 200:
            fail(f"ERROR: reading the objects already at {base} failed ({rl.status_code}): {rl.text[:200]}")
        known: set[str] = {str(o["id"]) for o in rl.json()}

        for o in objects:
            (res.updated if str(o.object_id) in known else res.created).append(o.name)
        if dry_run:
            res.plans_written = sum(len(o.plans) for o in objects)  # would-be, not did (see the field)
            return res

        for o in objects:
            oid = str(o.object_id)
            is_new = oid not in known
            ro = c.put(
                f"/api/objects/{oid}",
                json={
                    "name": o.name,
                    "address": o.address,
                    "lat": o.lat,
                    "lng": o.lng,
                    "source_key": o.sourceKey,
                    "source_note": o.sourceNote,
                },
            )
            if ro.status_code != 200:
                fail(f"ERROR: upsert object {oid} failed ({ro.status_code}): {ro.text[:200]}")
            attached = 0
            for p in o.plans:
                src = _resolve(manifest_path, p)
                raw = src.read_bytes()
                # Always declare the bytes, pinned in the manifest or not. The server verifies
                # what it is given and — where it is configured to (the public demo) — refuses a
                # publish that declares nothing at all, because a client that cannot name its own
                # bytes is older than the guard. See api/objects._check_plan_digest.
                form = {"sha256": hashlib.sha256(raw).hexdigest()}
                if p.title:
                    form["title"] = p.title
                if p.sourceNote:
                    form["source_note"] = p.sourceNote
                rp = c.put(
                    f"/api/objects/{oid}/plans/{p.module}",
                    files={"file": (src.name, raw, "application/pdf")},
                    data=form,
                )
                if rp.status_code == 404:
                    # The object was PUT one request ago and the server says it has no such
                    # object. Counted and NAMED rather than aborting the manifest: the rest of
                    # the push is still worth doing, and a plan that silently never arrived is
                    # exactly the failure this command was hiding — an Einsatzobjekt with
                    # "plans": [] and an exit code of 0.
                    res.plans_skipped.append(
                        (o.name, p.module, f"the server has no object {oid} (404) — rerun the push")
                    )
                    continue
                if rp.status_code != 200:
                    fail(f"ERROR: upload {oid}/{p.module} failed ({rp.status_code}): {rp.text[:200]}")
                res.plans_written += 1
                attached += 1
            print(f"  {'+' if is_new else '~'} {o.name}  ({attached}/{len(o.plans)} plan PDF(s))")
    return res


async def _show() -> list[dict[str, Any]]:
    async with async_session_maker() as db:
        objs = list((await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars())
        # .tuples() so the rows are typed as (object_id, count) pairs rather than opaque Rows —
        # dict() over them then needs no annotation and no cast.
        counts: dict[uuid.UUID | None, int] = dict(
            (
                await db.execute(
                    select(ReferenceDataset.object_id, func.count())
                    .where(ReferenceDataset.kind == "pdf")
                    .group_by(ReferenceDataset.object_id)
                )
            )
            .tuples()
            .all()
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
    add_push_args(p_push, dry_run_help="authenticate + report only, do not upload/write")
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
        return (await _load(path, objects)).report(where="in the local reference store")
    if args.cmd == "push":
        require_push_target(args)
        path = Path(args.manifest)
        objects = _read_manifest(path)
        if not args.dry_run:
            _validate_files(path, objects)  # reject missing/non-PDF files before uploading anything
        res = _push(path, objects, args.base, args.admin_secret, args.dry_run)
        return res.report(where=f"at {args.base}", dry_run=args.dry_run)
    # show
    rows = await _show()
    print(json.dumps(rows, indent=2, ensure_ascii=False) if rows else "No objects stored.")
    return 0


def main() -> None:
    sys.exit(asyncio.run(_amain(sys.argv[1:])))


if __name__ == "__main__":
    main()

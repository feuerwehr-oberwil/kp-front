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
    merge-duplicates       fold objects whose names differ only in Unicode form into one, onto the
                           id every future import mints for that name (report only)
    repair-sharepoint-keys fold what the SharePoint pull minted under the WHOLE folder name onto
                           the «Adresse - Name» convention, geocoding what it splits out, and list
                           every object that still has no coordinates (report only)
    remove-empty           delete objects that carry no plans and nothing points at (report only)

`merge-duplicates`, `repair-sharepoint-keys` and `remove-empty` REPORT by default and write only
with ``--apply`` — see :func:`_merge_duplicates` and :func:`_repair_sharepoint_keys`. The repair's
dry run is also the read-only way to CHECK a deployment: it prints the object census and every
Einsatzobjekt that carries plans but no coordinates (and so surfaces at no incident).

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
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import UTC
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import Text, cast, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from . import storage
from .admin_cli import add_push_args, admin_client, fail, require_push_target
from .admin_manifest import template_hint
from .database import async_session_maker
from .geocode import geocode
from .models import DeploymentConfig, Incident, IncidentEvent, JournalEntry, ObjectSite, ReferenceDataset


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


#: What a station's plan-library folder name puts between the address and the object's name:
#: «Im Buech 10 - Hof Thürkauf, Im Buech 15, Im Buech 20». Spaces on both sides, so a name that
#: merely contains a hyphen («Am Mühlebach 1-11») is not torn in half.
FOLDER_SEP = " - "


@dataclass(frozen=True)
class FolderIdentity:
    """A plan-library folder name read as an Einsatzobjekt's identity — what it is KEYED by, and
    the two fields that key was split out of.

    One convention, three doors: the private importer
    (``scripts/import_einsatzplaene.py``) has always written «Adresse - Name» folders into a
    manifest as ``address`` + ``name`` and keyed the object on the NAME alone, the SharePoint pull
    reads the same folders off Graph, and :func:`_repair_sharepoint_keys` repairs what the pull
    minted before it agreed. Verified against production on 11.09.2026: folder «Im Buech 10 - Hof
    Thürkauf, Im Buech 15, Im Buech 20» is stored as ``301a412f…`` =
    ``object_id_for_key('Hof Thürkauf, Im Buech 15, Im Buech 20')``, address «Im Buech 10» — NOT
    the uuid5 of the whole folder string.

    ⚠️ NFC-composed before anything else, because the id is a hash of these bytes. macOS hands
    out file names decomposed (``u`` + U+0308) while Graph and a keyboard hand out the composed
    ``ü``; both spell «Bürgerheim», both look identical in every list, and ``object_id_for_key``
    hashes the string — so an import that read names off a Mac filesystem and one that read them
    off SharePoint minted two uuid5 for one building (25 of the 38 duplicate Einsatzobjekte that
    deployment carried). Composing lives HERE and not inside ``object_id_for_key``, which is also
    the CLI's and the admin UI's: composing in there would silently re-key every object whose
    stored id was derived from a decomposed name — the fix and the damage in one commit.
    """

    #: The string :func:`object_id_for_key` hashes — the name part, NFC-composed.
    key: str
    #: The object's name: the part after the separator, or the whole folder name without one.
    name: str
    #: The part before the separator, or None for a folder that carries no address.
    address: str | None

    @property
    def object_id(self) -> uuid.UUID:
        return object_id_for_key(self.key)


def folder_identity(folder: str) -> FolderIdentity:
    """Split «Adresse - Name» into the identity an Einsatzobjekt is stored under.

    A folder WITHOUT the separator («Grosspläne», «dorfmatt») is all name and no address, and is
    keyed on the whole string — which is what the convention has always done with it, so nothing
    about such a folder changes.
    """
    composed = " ".join(unicodedata.normalize("NFC", folder).split())
    address, sep, name = composed.partition(FOLDER_SEP)
    if not sep or not address.strip() or not name.strip():
        return FolderIdentity(key=composed, name=composed, address=None)
    return FolderIdentity(key=name.strip(), name=name.strip(), address=address.strip())


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


async def _plan_counts(db: AsyncSession) -> dict[uuid.UUID | None, int]:
    """Plan PDFs per object id, in one query."""
    # .tuples() so the rows are typed as (object_id, count) pairs rather than opaque Rows —
    # dict() over them then needs no annotation and no cast.
    return dict(
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


async def _show() -> list[dict[str, Any]]:
    async with async_session_maker() as db:
        objs = list((await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars())
        counts = await _plan_counts(db)
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


# --- maintenance: duplicate merge + junk removal -----------------------------------------
#
# Every place a deployment writes an Einsatzobjekt's id down — what a merge has to re-point,
# and what it deliberately does not:
#
#   reference_datasets.object_id   the plans (FK). Their PRIMARY KEY encodes the object too
#                                  (``plan:<object>:<module>``), so a moved plan is re-keyed,
#                                  not just re-pointed: leaving the old key would make the next
#                                  `load`/pull mint a second row for the same sheet.
#   objects.source_key             UNIQUE — the key the scheduled pull matches on. Inherited by
#                                  the survivor when it has none and the loser goes away.
#   deployment_config
#     .plan_scales_json            the STATION calibration + georeference, keyed per sheet as
#                                  ``object:<object>:plan:<module>`` (api/plan_scales). Losing
#                                  this is losing every landmark pair an FU ever tapped.
#   incidents.map_workspace_json   ``pickedObjectId`` — the Einsatzobjekt an editor picked by
#                                  hand, which also decides what a forwarded Rapport link may
#                                  read (auth/incident_link._surfaced_object_ids).
#   incident_events.payload_json   hash-chained AUDIT records; journal_entries.row_json is the
#   journal_entries.row_json       append-only Verlauf. Both are HISTORY: they are counted and
#                                  named, never rewritten — a merge that edits the audit trail
#                                  breaks the chain it exists to protect, and «this plan hung
#                                  off the other spelling that night» is a true statement.
#   object storage                 plan blobs are addressed by ``storage_key``, which carries no
#                                  object id, so a re-pointed plan keeps its bytes. Nothing here
#                                  ever deletes a blob: an orphan costs disk, a deleted PDF costs
#                                  a crew its plan.


async def objects_without_coordinates(db: AsyncSession) -> list[ObjectSite]:
    """Einsatzobjekte that carry plans but no coordinates — the plans nobody can reach.

    The app auto-surfaces an Einsatzobjekt at an incident by DISTANCE (``src/lib/useObjectPlans``
    over ``GET /api/incidents/{id}/objects``), so an object with no lat/lng appears at no
    Einsatz whatever, however many sheets hang off it. That is the second half of the
    two-conventions defect: 150 objects minted from a folder name, none of them geocoded, ~334
    freshly synced plans reachable by nobody — and nothing said so anywhere. Read live by the
    SharePoint status card and printed by :func:`_repair_sharepoint_keys`, whose dry run is
    therefore also the way to check afterwards that the repair worked.
    """
    with_plans = select(ReferenceDataset.object_id).where(ReferenceDataset.object_id.is_not(None))
    stmt = (
        select(ObjectSite)
        .where(ObjectSite.lat.is_(None) | ObjectSite.lng.is_(None))
        .where(ObjectSite.id.in_(with_plans))
        .order_by(ObjectSite.name)
    )
    return list((await db.execute(stmt)).scalars())


def _name_key(name: str) -> str:
    """The string :func:`object_id_for_key` would hash for this name — NFC-composed first.

    Two folder names that look identical on screen hash to two different ids when one spells «ü»
    as ``u`` + U+0308 and the other as U+00FC: that is the 195-objects-for-157 split on the FWO
    deployment, minted by an import that read the names off a Mac filesystem. Composing before
    normalising is what puts both spellings in one group here.
    """
    return " ".join(unicodedata.normalize("NFC", name).split()).casefold()


def _spelling(name: str) -> str:
    """A name as the diff prints it: with its Unicode form and non-ASCII codepoints when it has
    any — the whole difficulty of this merge is that the two spellings look the same."""
    marks = " ".join(f"U+{ord(c):04X}" for c in name if ord(c) > 127)
    if not marks:
        return repr(name)
    # `ascii()`, not `repr()`: printed as themselves the two spellings are the same picture, and
    # the operator is being asked to delete one of them.
    if name == unicodedata.normalize("NFC", name):
        form = "NFC"
    elif name == unicodedata.normalize("NFD", name):
        form = "NFD"
    else:
        form = "mixed"
    return f"{name!a} {form} [{marks}]"


def _retarget_json(value: object, loser: uuid.UUID, survivor: uuid.UUID) -> tuple[object, int]:
    """Rewrite every string in a JSON document that ADDRESSES the loser, keys included.

    One rule, because every id-shaped string a deployment stores is the object's uuid verbatim or
    a key built around it (``plan:<id>:<module>``, ``object:<id>:plan:<module>``,
    ``/api/objects/<id>``): a string containing the loser's uuid means the loser. Where a rewrite
    would collide with a key the document already has, the EXISTING entry wins — the survivor's
    own calibration is never overwritten by the twin's.
    """
    if isinstance(value, str):
        new = value.replace(str(loser), str(survivor))
        return new, int(new != value)
    if isinstance(value, list):
        hits = 0
        out_list: list[object] = []
        for item in value:
            new_item, n = _retarget_json(item, loser, survivor)
            out_list.append(new_item)
            hits += n
        return out_list, hits
    if isinstance(value, dict):
        hits = 0
        out_dict: dict[str, object] = {}
        for key, item in value.items():
            new_key = str(key).replace(str(loser), str(survivor))
            new_item, n = _retarget_json(item, loser, survivor)
            hits += n + int(new_key != key)
            if new_key != key and new_key in value:
                continue  # the survivor already has this key; its entry stays
            out_dict[new_key] = new_item
        return out_dict, hits
    return value, 0


def _same_bytes(a: ReferenceDataset, b: ReferenceDataset) -> Literal["same", "differs", "unknown"]:
    """Whether two plan rows hold the same PDF — the question that decides «drop the duplicate»
    from «two sheets, ask a human». Unknown (an unreadable blob) counts as a conflict upstream."""
    if a.storage_key and a.storage_key == b.storage_key:
        return "same"
    if a.source_digest and b.source_digest:
        return "same" if a.source_digest == b.source_digest else "differs"
    if not a.storage_key or not b.storage_key:
        return "unknown"
    try:
        digests = [hashlib.sha256(storage.get_bytes(k)).hexdigest() for k in (a.storage_key, b.storage_key)]
    except OSError:
        return "unknown"
    return "same" if digests[0] == digests[1] else "differs"


def _when(ds: ReferenceDataset) -> str:
    """A plan row's write date as the report prints it — the operator's way of telling the two
    copies of a sheet apart at a glance."""
    return ds.updated_at.strftime("%d.%m.%Y %H:%M") if ds.updated_at else "undated"


def _stamp(ds: ReferenceDataset) -> tuple[float, int]:
    """How recent a plan row is: when it was last written, then its version counter.

    ⚠️ A naive `updated_at` is read as UTC rather than compared raw — SQLite hands back naive
    datetimes where Postgres hands back aware ones, and comparing the two raises.
    """
    at = ds.updated_at
    if at is None:
        return (0.0, ds.current_version or 0)
    return ((at if at.tzinfo else at.replace(tzinfo=UTC)).timestamp(), ds.current_version or 0)


@dataclass
class SlotDecision:
    """What happens to one of the loser's plan rows."""

    module: str
    dataset_id: str
    target_id: str  # the key it moves to — decided here, so the apply invents nothing
    #: `replace` only exists where the two rows are the same sheet under two conventions
    #: (`repair-sharepoint-keys`): the survivor's row goes and the loser's takes its key.
    action: Literal["move", "drop", "conflict", "replace"]
    why: str
    #: The survivor row `replace` deletes — carried so the apply re-reads nothing.
    replaces: str | None = None


@dataclass
class MergePair:
    """One survivor ← loser merge, fully decided before anything is written."""

    survivor: ObjectSite
    loser: ObjectSite
    survivor_plans: int
    loser_plans: int
    slots: list[SlotDecision] = field(default_factory=list)
    scales_moved: list[str] = field(default_factory=list)
    scales_kept: list[str] = field(default_factory=list)  # the survivor already had that sheet
    incidents: list[uuid.UUID] = field(default_factory=list)
    events: int = 0  # audit rows naming the loser — reported, never rewritten
    journal: int = 0
    source_key: str | None = None  # the loser's, inherited when the row goes away

    @property
    def conflicts(self) -> list[SlotDecision]:
        return [s for s in self.slots if s.action == "conflict"]

    @property
    def deletable(self) -> bool:
        """The loser row goes only once nothing of its own is left on it."""
        return not self.conflicts


async def _incidents_naming(db: AsyncSession, oid: uuid.UUID) -> list[uuid.UUID]:
    """Incidents whose stored workspace names this object (``pickedObjectId``, and whatever else a
    later workspace shape keys by object). Matched as text: the document is the client's shape and
    the id can sit at any depth in it."""
    stmt = select(Incident.id).where(cast(Incident.map_workspace_json, Text).contains(str(oid)))
    return list((await db.execute(stmt)).scalars())


async def _history_naming(db: AsyncSession, oid: uuid.UUID) -> tuple[int, int]:
    """(audit events, journal rows) that name this object — counted so the report can say so, and
    never rewritten: both are records of what was true at the time, one of them hash-chained."""
    events = (
        select(func.count()).select_from(IncidentEvent).where(cast(IncidentEvent.payload_json, Text).contains(str(oid)))
    )
    journal = select(func.count()).select_from(JournalEntry).where(cast(JournalEntry.row_json, Text).contains(str(oid)))
    return int((await db.execute(events)).scalar_one()), int((await db.execute(journal)).scalar_one())


async def _plan_merge(
    db: AsyncSession,
    survivor: ObjectSite,
    loser: ObjectSite,
    *,
    counts: dict[uuid.UUID | None, int],
    slots: dict[str, ReferenceDataset],
    scales: dict[str, object],
    newest_wins: bool = False,
) -> MergePair:
    """Decide (and only decide) how the loser folds into the survivor.

    ``slots`` is the survivor's module → plan map, carried across the whole group and updated as
    moves are decided, so a third twin sees what the second one already handed over — in a dry
    run exactly as in a real one.

    ``newest_wins`` decides the one case the two callers disagree on: a slot BOTH rows hold with
    different bytes. For a duplicate name that is a genuine conflict — two sheets somebody drew,
    and picking one is a decision a person makes. For the two-conventions repair it is the same
    sheet pulled twice, so the more recently written row is simply the current one and the other
    is a superseded copy (that is the whole defect: the pull kept updating the copy nobody could
    see, so the SharePoint side is normally the newer).
    """
    pair = MergePair(
        survivor=survivor,
        loser=loser,
        survivor_plans=counts.get(survivor.id, 0),
        loser_plans=counts.get(loser.id, 0),
        source_key=loser.source_key if survivor.source_key is None else None,
    )
    taken_ids = set(
        (await db.execute(select(ReferenceDataset.id).where(ReferenceDataset.object_id == survivor.id))).scalars()
    )
    mine = list(
        (
            await db.execute(
                select(ReferenceDataset).where(ReferenceDataset.object_id == loser.id).order_by(ReferenceDataset.id)
            )
        ).scalars()
    )
    for ds in mine:
        module = ds.module or ""
        shown = module or "(no module)"
        # The dataset key is re-derived by swapping the id inside it, never rebuilt from parts:
        # a row whose key is not the usual `plan:<object>:<module>` still ends up addressed to
        # the survivor instead of to a string this function invented.
        target_id = ds.id.replace(str(loser.id), str(survivor.id))
        held = slots.get(module) if module else None
        if held is None and target_id not in taken_ids:
            pair.slots.append(SlotDecision(shown, ds.id, target_id, "move", target_id))
            if module:
                slots[module] = ds
            taken_ids.add(target_id)
            continue
        if held is None:
            pair.slots.append(
                SlotDecision(shown, ds.id, target_id, "conflict", f"{target_id} already exists on the survivor")
            )
            continue
        verdict = _same_bytes(held, ds)
        if verdict == "same":
            pair.slots.append(SlotDecision(shown, ds.id, target_id, "drop", "identical bytes on the survivor"))
        elif not newest_wins:
            why = (
                "the survivor's sheet holds different bytes"
                if verdict == "differs"
                else "the two sheets could not be compared (blob unreadable)"
            )
            pair.slots.append(SlotDecision(shown, ds.id, target_id, "conflict", why))
        elif _stamp(ds) > _stamp(held):
            pair.slots.append(
                SlotDecision(
                    shown,
                    ds.id,
                    held.id,
                    "replace",
                    f"v{ds.current_version} ({_when(ds)}, {ds.source_type}) is newer than the survivor's "
                    f"v{held.current_version} ({_when(held)}, {held.source_type})",
                    replaces=held.id,
                )
            )
            slots[module] = ds
        else:
            pair.slots.append(
                SlotDecision(
                    shown,
                    ds.id,
                    target_id,
                    "drop",
                    f"the survivor's v{held.current_version} ({_when(held)}) is the newer sheet",
                )
            )

    _, pair.scales_moved, pair.scales_kept = _retarget_scales(scales, loser.id, survivor.id)
    pair.incidents = await _incidents_naming(db, loser.id)
    pair.events, pair.journal = await _history_naming(db, loser.id)
    return pair


#: The sections of ``plan_scales_json`` that are keyed per SHEET (``object:<id>:plan:<module>``).
#: Mirrors api/plan_scales.PlanScales — a section added there and forgotten here is a station
#: calibration that survives the merge pointing at a deleted object.
SHEET_SECTIONS = ("byPlan", "georefByPlan", "measuredArByPlan")


def _scale_keys_for(doc: dict[str, object], oid: uuid.UUID) -> list[str]:
    """The station calibration/georeference keys that belong to one object."""
    prefix = f"object:{oid}:plan:"
    found: list[str] = []
    for section_name in SHEET_SECTIONS:
        section = doc.get(section_name)
        if isinstance(section, dict):
            found += [f"{section_name}/{k}" for k in section if str(k).startswith(prefix)]
    return found


def _retarget_scales(
    doc: dict[str, object], loser: uuid.UUID, survivor: uuid.UUID
) -> tuple[dict[str, object], list[str], list[str]]:
    """Move the station's per-sheet calibration and georeference onto the survivor's ids.

    Returns the new document plus the keys moved and the keys kept (the survivor already had that
    sheet — its own pairs stay, the twin's are reported and dropped rather than guessed at).
    """
    old_prefix, new_prefix = f"object:{loser}:plan:", f"object:{survivor}:plan:"
    moved: list[str] = []
    kept: list[str] = []
    out = dict(doc)
    for section_name in SHEET_SECTIONS:
        section = doc.get(section_name)
        if not isinstance(section, dict):
            continue  # a malformed document is served entry-wise too (api/plan_scales)
        rebuilt: dict[str, object] = {}
        for key, value in section.items():
            if not str(key).startswith(old_prefix):
                rebuilt[str(key)] = value
                continue
            target = new_prefix + str(key)[len(old_prefix) :]
            if target in section:
                kept.append(f"{section_name}/{target}")
                continue
            rebuilt[target] = value
            moved.append(f"{section_name}/{target}")
        out[section_name] = rebuilt
    return out, moved, kept


def _print_pair(pair: MergePair) -> None:
    """The diff for one survivor ← loser. Everything that moves, everything that does not."""
    print(f"  keep   {pair.survivor.id}  {_spelling(pair.survivor.name)}  ({pair.survivor_plans} plan(s))")
    print(f"  merge  {pair.loser.id}  {_spelling(pair.loser.name)}  ({pair.loser_plans} plan(s))")
    for slot in pair.slots:
        mark = {"move": "→", "drop": "·", "conflict": "!", "replace": "→"}[slot.action]
        label = {
            "move": "moves",
            "drop": "dropped",
            "conflict": "CONFLICT",
            "replace": "replaces the survivor's sheet",
        }[slot.action]
        print(f"       {mark} plan {slot.module}: {label} — {slot.why}")
    if pair.scales_moved or pair.scales_kept:
        print(
            f"       → plan-scales: {len(pair.scales_moved)} sheet calibration/georeference key(s) move"
            + (f", {len(pair.scales_kept)} kept (the survivor already has that sheet)" if pair.scales_kept else "")
        )
    if pair.incidents:
        print(f"       → incidents: {len(pair.incidents)} workspace(s) re-pointed (pickedObjectId)")
    if pair.events or pair.journal:
        print(
            f"       · history: {pair.events} audit event(s), {pair.journal} journal row(s) name the old id "
            "— left untouched (the audit chain is the record of what was true then)"
        )
    if pair.deletable:
        if pair.source_key:
            print(f"       → source_key {pair.source_key!r} passes to the survivor")
        print(f"       → object row {pair.loser.id} deleted")
    else:
        print(f"       ! object row {pair.loser.id} KEPT — {len(pair.conflicts)} conflict(s) still hang off it")


def _pick_survivor(group: list[ObjectSite], counts: dict[uuid.UUID | None, int]) -> tuple[ObjectSite, uuid.UUID | None]:
    """The row the others fold into, and the NFC-key id it still has to be re-keyed to (or None).

    The uuid5 of the NFC-composed name is the id every future import mints — the SharePoint pull
    matches and creates objects with exactly it (``sharepoint_sync._object_for``). A row carrying
    it is the obvious survivor. When NO row carries it (both spellings were keyed by something
    other than the bare name — 27 of 79 groups on the FWO deployment) the richest row wins (most
    plans, then most recently updated, then lowest id, so two runs agree) and the caller re-keys
    it afterwards: leaving it under its own id would let the next sync mint a THIRD row.
    """
    try:
        canonical = object_id_for_key(_name_key(group[0].name))
    except ValueError:  # a blank name hashes to nothing; the richest row still wins, un-re-keyed
        canonical = None
    for o in group:
        if o.id == canonical:
            return o, None
    richest = sorted(
        group,
        key=lambda o: (-counts.get(o.id, 0), -(o.updated_at.timestamp() if o.updated_at else 0.0), str(o.id)),
    )[0]
    return richest, canonical


@dataclass
class Rekey:
    """The survivor's own move onto the NFC-key id, decided before anything is written."""

    row: ObjectSite
    target: uuid.UUID
    name: str  # the NFC-composed spelling the re-keyed row carries
    #: The address the re-keyed row carries. The repair splits one out of «Adresse - Name»; the
    #: duplicate merge keeps whatever the row had.
    address: str | None = None
    #: Coordinates geocoded for a row that had none — set by the repair, never overwriting a
    #: pair the station already has.
    coords: tuple[float, float] | None = None
    datasets: list[tuple[str, str]] = field(default_factory=list)  # (old key, new key)
    scales_moved: list[str] = field(default_factory=list)
    incidents: list[uuid.UUID] = field(default_factory=list)
    events: int = 0
    journal: int = 0
    blocked: str | None = None  # set when something already sits on the target id


async def _plan_rekey(
    db: AsyncSession,
    row: ObjectSite,
    target: uuid.UUID,
    *,
    also: list[uuid.UUID],
    moved_datasets: list[str],
    scales: dict[str, object],
    name: str | None = None,
    address: str | None = None,
    coords: tuple[float, float] | None = None,
) -> Rekey:
    """Decide the survivor's re-key onto ``target`` — the same move a loser makes, one row over.

    ``also`` are the ids folded into this survivor a moment ago: in a dry run their workspaces
    still name the loser, so the incidents that need rewriting are the union. ``moved_datasets``
    are the plan keys that same fold hands over, which a dry run cannot yet read back from the DB.

    Anything already sitting on the target id blocks the re-key rather than being merged into
    blind: the group scan is one transaction, so this can only be a row keyed by a different name.
    """
    plan = Rekey(
        row=row,
        target=target,
        name=name if name is not None else unicodedata.normalize("NFC", row.name),
        address=address if address is not None else row.address,
        coords=coords,
    )
    if (await db.execute(select(ObjectSite.id).where(ObjectSite.id == target))).scalar_one_or_none() is not None:
        plan.blocked = f"an object already carries {target} — merge that one first"
        return plan
    own = set(
        (await db.execute(select(ReferenceDataset.id).where(ReferenceDataset.object_id == row.id))).scalars()
    ) | set(moved_datasets)
    plan.datasets = sorted((did, did.replace(str(row.id), str(target))) for did in own)
    taken = (
        set(
            (
                await db.execute(
                    select(ReferenceDataset.id).where(ReferenceDataset.id.in_([n for _, n in plan.datasets]))
                )
            ).scalars()
        )
        - own
    )
    if taken:
        plan.blocked = f"{len(taken)} plan key(s) already exist under {target}, e.g. {sorted(taken)[0]}"
        return plan
    _, plan.scales_moved, kept = _retarget_scales(scales, row.id, target)
    if kept:
        plan.blocked = f"{len(kept)} calibration key(s) already exist under {target}"
        return plan
    for oid in [row.id, *also]:
        plan.incidents += [i for i in await _incidents_naming(db, oid) if i not in plan.incidents]
    plan.events, plan.journal = await _history_naming(db, row.id)
    return plan


def _print_rekey(plan: Rekey) -> None:
    if plan.blocked:
        print(f"  ! rekey {plan.row.id} → {plan.target} REFUSED: {plan.blocked}")
        return
    bits = [f"{len(plan.datasets)} plan(s)"]
    if plan.name != plan.row.name or plan.address != plan.row.address:
        bits.append(f"name «{plan.name}», address «{plan.address or '—'}»")
    if plan.coords:
        bits.append(f"geocoded to {plan.coords[0]:.5f}, {plan.coords[1]:.5f}")
    if plan.scales_moved:
        bits.append(f"{len(plan.scales_moved)} calibration key(s)")
    if plan.incidents:
        bits.append(f"{len(plan.incidents)} workspace(s)")
    if plan.events or plan.journal:
        bits.append(f"{plan.events + plan.journal} history row(s) named, left untouched")
    print(f"  rekey  {plan.row.id} → {plan.target}  ({', '.join(bits)})")


async def _apply_rekey(db: AsyncSession, plan: Rekey) -> None:
    """Move the survivor itself onto the NFC-key id. Only under ``--apply``, same transaction.

    The row is re-created rather than updated in place: the plans reference ``objects.id`` and the
    FK has no ON UPDATE CASCADE, so a parent key cannot change while children point at it. Same
    order as a loser fold — new row, everything moved onto it, old row last.
    """
    old = plan.row
    source_key = old.source_key
    lat, lng = (old.lat, old.lng) if old.lat is not None and old.lng is not None else (plan.coords or (None, None))
    fresh = ObjectSite(
        id=plan.target,
        name=plan.name,
        address=plan.address,
        lat=lat,
        lng=lng,
        source_note=old.source_note,
    )
    db.add(fresh)
    await db.flush()
    for old_id, new_id in plan.datasets:
        await db.execute(
            update(ReferenceDataset)
            .where(ReferenceDataset.id == old_id)
            .values(id=new_id, object_id=plan.target)
            .execution_options(synchronize_session=False)
        )
    for incident_id in plan.incidents:
        row = (await db.execute(select(Incident).where(Incident.id == incident_id))).scalar_one_or_none()
        if row is None or not isinstance(row.map_workspace_json, dict):
            continue
        new_doc, hits = _retarget_json(row.map_workspace_json, old.id, plan.target)
        if hits and isinstance(new_doc, dict):
            row.map_workspace_json = new_doc
    if source_key is not None:
        old.source_key = None  # UNIQUE — free it before the re-keyed row takes it
        await db.flush()
        fresh.source_key = source_key
    await db.execute(delete(ObjectSite).where(ObjectSite.id == old.id).execution_options(synchronize_session=False))


async def _apply_pair(db: AsyncSession, pair: MergePair) -> None:
    """Carry out one decided merge. Called only under ``--apply``, inside the one transaction."""
    for slot in pair.slots:
        if slot.action == "replace":
            # The superseded row goes FIRST — its id is the key the newer row is about to take.
            # Its blob stays in the store, like every other row this module retires.
            await db.execute(
                delete(ReferenceDataset)
                .where(ReferenceDataset.id == slot.replaces)
                .execution_options(synchronize_session=False)
            )
            await db.execute(
                update(ReferenceDataset)
                .where(ReferenceDataset.id == slot.dataset_id)
                .values(id=slot.target_id, object_id=pair.survivor.id)
                .execution_options(synchronize_session=False)
            )
        elif slot.action == "move":
            # Re-KEYED, not just re-pointed: the primary key encodes the object, and a row left
            # under the old key is a row the next `load` or pull would mint a second time.
            await db.execute(
                update(ReferenceDataset)
                .where(ReferenceDataset.id == slot.dataset_id)
                .values(id=slot.target_id, object_id=pair.survivor.id)
                .execution_options(synchronize_session=False)
            )
        elif slot.action == "drop":
            # The bytes stay in the store: the row is redundant, the blob may not be.
            await db.execute(
                delete(ReferenceDataset)
                .where(ReferenceDataset.id == slot.dataset_id)
                .execution_options(synchronize_session=False)
            )
    for incident_id in pair.incidents:
        row = (await db.execute(select(Incident).where(Incident.id == incident_id))).scalar_one_or_none()
        if row is None or not isinstance(row.map_workspace_json, dict):
            continue
        new_doc, hits = _retarget_json(row.map_workspace_json, pair.loser.id, pair.survivor.id)
        if hits and isinstance(new_doc, dict):
            row.map_workspace_json = new_doc  # reassigned, not mutated: JSONB change detection
    if pair.deletable:
        if pair.source_key:
            pair.loser.source_key = None  # source_key is UNIQUE — free it before the survivor takes it
            await db.flush()
            pair.survivor.source_key = pair.source_key
        await db.execute(
            delete(ObjectSite).where(ObjectSite.id == pair.loser.id).execution_options(synchronize_session=False)
        )


async def _merge_duplicates(*, apply: bool) -> int:
    """Fold objects whose names are the same name into one row — REPORT ONLY unless ``apply``.

    Duplicates are grouped by the string :func:`object_id_for_key` hashes (NFC-composed, whitespace
    collapsed, case folded), so an NFD/NFC twin pair and a byte-identical pair are the same case
    here. A plan slot the survivor already holds is never overwritten: identical bytes let the
    duplicate row go, anything else is reported as a conflict and the loser row stays whole.

    A group that folds completely also ends up ON the NFC-key id: where no row carried it, the
    survivor is re-keyed onto it once the losers are in (:func:`_apply_rekey`). That id is what
    the SharePoint pull and every future import mint for this name, so a merge that skipped it
    would be undone by the next sync — a third row under the same name. A group kept back by a
    conflict is NOT re-keyed: half a merge on a new id is worse than none.

    Under ``--apply`` the whole run is ONE transaction: either every group folds or none does.

    ⚠️ Writes ``plan_scales_json`` directly, outside the If-Match guard a human write gets
    (api/plan_scales). Run it in a maintenance window, not while an Einsatz is being drawn on.
    """
    async with async_session_maker() as db:
        rows = list((await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars())
        counts = await _plan_counts(db)
        groups: dict[str, list[ObjectSite]] = {}
        for row in rows:
            groups.setdefault(_name_key(row.name), []).append(row)
        duplicates = {k: v for k, v in sorted(groups.items()) if len(v) > 1}
        if not duplicates:
            print(f"No duplicate object names among {len(rows)} object(s). Nothing to merge.")
            return 0

        station = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        scales: dict[str, object] = dict(station.plan_scales_json) if station and station.plan_scales_json else {}
        pairs: list[MergePair] = []
        rekeys: list[Rekey] = []
        unfinished = 0  # groups whose conflicts keep the survivor on its old, non-NFC id
        for group in duplicates.values():
            survivor, rekey_to = _pick_survivor(group, counts)
            note = (
                "the survivor carries the NFC-key id"
                if rekey_to is None
                else f"no row carries the NFC-key id — the richest is re-keyed to {rekey_to}"
            )
            print(f"\n«{unicodedata.normalize('NFC', survivor.name)}» — {len(group)} rows ({note})")
            slots: dict[str, ReferenceDataset] = {
                ds.module: ds
                for ds in (
                    await db.execute(select(ReferenceDataset).where(ReferenceDataset.object_id == survivor.id))
                ).scalars()
                if ds.module
            }
            folded: list[MergePair] = []
            for loser in [o for o in group if o.id != survivor.id]:
                pair = await _plan_merge(db, survivor, loser, counts=counts, slots=slots, scales=scales)
                _print_pair(pair)
                scales, _, _ = _retarget_scales(scales, loser.id, survivor.id)
                folded.append(pair)
                pairs.append(pair)
                if apply:
                    await _apply_pair(db, pair)
            if rekey_to is None:
                continue
            if not all(p.deletable for p in folded):
                # Half a merge re-keyed is worse than none: the conflicting twin would stay behind
                # under a spelling the pull no longer resolves to anything.
                print(
                    f"       ! rekey {survivor.id} → {rekey_to} NOT done — this group did not fold; "
                    "a later import under the NFC spelling would mint a THIRD row"
                )
                unfinished += 1
                continue
            if apply:
                await db.flush()  # the folds above must be readable by the scan below
            rekey = await _plan_rekey(
                db,
                survivor,
                rekey_to,
                also=[p.loser.id for p in folded],
                moved_datasets=[s.target_id for p in folded for s in p.slots if s.action == "move"],
                scales=scales,
            )
            _print_rekey(rekey)
            rekeys.append(rekey)
            if rekey.blocked is None:
                scales, _, _ = _retarget_scales(scales, survivor.id, rekey_to)
                if apply:
                    await _apply_rekey(db, rekey)

        moved = sum(1 for p in pairs for s in p.slots if s.action == "move")
        dropped = sum(1 for p in pairs for s in p.slots if s.action == "drop")
        conflicts = sum(len(p.conflicts) for p in pairs)
        deletions = sum(1 for p in pairs if p.deletable)
        rekeyed = sum(1 for r in rekeys if r.blocked is None)
        refused = len(rekeys) - rekeyed
        summary = (
            f"{len(pairs)} merge(s) in {len(duplicates)} name group(s): {deletions} object row(s) deleted, "
            f"{len(pairs) - deletions} kept for conflicts, {moved} plan(s) re-pointed, "
            f"{dropped} duplicate plan row(s) dropped, {conflicts} conflict(s), "
            f"{rekeyed} survivor(s) re-keyed to the NFC id"
            + (f", {refused} re-key(s) refused" if refused else "")
            + (f", {unfinished} re-key(s) left undone by conflicts" if unfinished else "")
        )
        if not apply:
            print(f"\nOK (dry-run): would be {summary}. Nothing written. Repeat with --apply to perform it.")
            return 0
        if station is not None and scales != (station.plan_scales_json or {}):
            station.plan_scales_json = scales
        await db.commit()
        incomplete = bool(conflicts or refused)
        print(f"\n{'INCOMPLETE' if incomplete else 'OK'}: {summary}.")
        if conflicts:
            print("       The conflicting sheets are still on their old object — decide those by hand.")
        if refused:
            print("       A refused re-key leaves that survivor on its old id — the next sync would mint a third.")
        return 1 if incomplete else 0


# --- maintenance: the two object-key conventions -----------------------------------------


def _whole_folder_keyed(row: ObjectSite) -> FolderIdentity | None:
    """The folder identity of an object keyed on the WHOLE «Adresse - Name» string, or None.

    Exact rather than heuristic, because it decides what gets merged: the row's id IS the uuid5
    of its own entire name, and that name carries the address separator. An object the importer
    wrote is keyed on the NAME half and never matches; one typed in the browser is keyed on
    whatever the operator typed, which is not a folder name with an address in front of it.
    """
    identity = folder_identity(row.name)
    if identity.address is None:
        return None
    try:
        return identity if row.id == object_id_for_key(_name_key(row.name)) else None
    except ValueError:  # a blank name hashes to nothing
        return None


@dataclass
class Repair:
    """One bare SharePoint object's repair, fully decided before anything is written."""

    row: ObjectSite
    identity: FolderIdentity
    target: uuid.UUID
    twin: ObjectSite | None = None  # the older, richer object under the corrected key
    pair: MergePair | None = None
    rekey: Rekey | None = None
    address_filled: str | None = None  # an empty survivor address taken from the folder name
    coords: tuple[float, float] | None = None  # geocoded for a survivor that had none

    @property
    def survivor(self) -> ObjectSite:
        return self.twin or self.row

    @property
    def done(self) -> bool:
        """Whether this repair ends with the object reachable under the corrected key."""
        if self.pair is not None and not self.pair.deletable:
            return False
        return self.rekey is None or self.rekey.blocked is None


async def _lookup_coordinates(address: str) -> tuple[float, float] | None:
    """Best-effort geocode for the repair. Never raises: a repair that cannot reach swisstopo
    still merges and re-keys, and the census at the end says which objects still have none."""
    try:
        return await geocode(address)
    except Exception as e:  # noqa: BLE001 — best-effort by contract
        print(f"  ? geocoding {address!r} failed ({type(e).__name__}: {e}) — left without coordinates", file=sys.stderr)
        return None


async def _coordinate_census(db: AsyncSession, resolved: set[uuid.UUID]) -> int:
    """Print the Einsatzobjekte that carry plans and no coordinates, and count them.

    ⚠️ This is the point of the whole repair, not a footnote to it: an object without
    coordinates is surfaced at no incident (:func:`objects_without_coordinates`), so a run that
    merged everything perfectly and geocoded nothing has fixed half the defect. ``resolved`` are
    the ids a dry run WOULD take off this list; under ``--apply`` it is empty, because by then
    the list is read back from what was actually written — which is what makes a second
    ``repair-sharepoint-keys`` (dry-run, read-only) the way to verify the first.
    """
    blind = [o for o in await objects_without_coordinates(db) if o.id not in resolved]
    total = int((await db.execute(select(func.count()).select_from(ObjectSite))).scalar_one())
    if not blind:
        print(f"\n{total} Einsatzobjekt(e) stored; every one that carries plans has coordinates.")
        return 0
    print(f"\n{total} Einsatzobjekt(e) stored, {len(blind)} of them carry plans and NO coordinates —")
    print("their plans surface at no incident until somebody geocodes them (/admin › Objektpläne):")
    for o in blind:
        print(f"  · {o.id}  «{unicodedata.normalize('NFC', o.name)}» — address {o.address or '(none)'}")
    return len(blind)


async def _repair_sharepoint_keys(*, apply: bool, do_geocode: bool) -> int:
    """Fold the SharePoint pull's whole-folder-name objects onto the address-split convention.

    THE DEFECT (production, 11.09.2026). A plans folder is named «Adresse - Name». The importer
    has always keyed an Einsatzobjekt on the NAME half and stored the address separately; the
    SharePoint connector hashed the WHOLE folder string instead. So every folder minted a
    SECOND, address-less, coordinate-less object beside the one the station already had, the
    pull kept updating that copy — «Im Buech 15» was at v2 on one object while the Einsatz
    showed v1 on the other — and because an object with no coordinates is surfaced at no
    incident at all, ~334 freshly synced plans were reachable by nobody.

    WHAT THIS DOES, per object the connector minted under the old convention
    (:func:`_whole_folder_keyed`, an exact id test — nothing typed by hand is touched):

    * **With an older twin** — found under the corrected key, or by the twin's own
      ``address + ' - ' + name`` — the bare object folds INTO it, because the older row is the
      one carrying the address, the coordinates, the station's georeference and whatever an FU
      picked in an Einsatz. Plans move slot by slot and the NEWER sheet wins each slot
      (``newest_wins``): the pull's v2 replaces the v1 nobody could open, an identical copy is
      dropped, and the survivor's own newer sheet stays. The bare row's empty address and
      coordinates never overwrite the survivor's real ones — but an EMPTY survivor address is
      filled from the folder name, because that address is the other way an object surfaces
      (api/objects · objects_near_incident matches it against the incident's).
    * **Without one** — 68 of the 150 on this deployment — the object is re-keyed onto the
      corrected id and its name is split into address + name, so the next sync finds it.
    * **Either way**, a survivor that ends up with an address and no coordinates is geocoded
      (best-effort, ``--no-geocode`` to skip), and everything still without any is listed.

    Its own subcommand rather than a flag on ``merge-duplicates``: that one folds rows whose
    NAMES are the same name, this one folds rows whose names deliberately differ because two
    conventions read one folder — and at 3am «merge the duplicates» and «repair what SharePoint
    keyed wrongly» are two different questions with two different answers.

    REPORT ONLY unless ``apply``, and under ``--apply`` the whole run is ONE transaction.

    ⚠️ Writes ``plan_scales_json`` directly, outside the If-Match guard a human write gets
    (api/plan_scales). Run it in a maintenance window, not while an Einsatz is being drawn on.
    """
    async with async_session_maker() as db:
        rows = list((await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars())
        counts = await _plan_counts(db)
        station = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        scales: dict[str, object] = dict(station.plan_scales_json) if station and station.plan_scales_json else {}
        by_id = {r.id: r for r in rows}
        # The twin an id lookup misses: the older row was keyed by something else (a decomposed
        # spelling, a hand-typed key), but it IS this building — it says so in its own two fields.
        by_fields: dict[tuple[str, str], ObjectSite] = {}
        for stored in rows:
            if stored.address and stored.name:
                by_fields.setdefault((_name_key(stored.address), _name_key(stored.name)), stored)

        bare = [(r, i) for r in rows if (i := _whole_folder_keyed(r)) is not None]
        if not bare:
            print(f"No object is keyed on a whole «Adresse - Name» folder name among {len(rows)} object(s).")
            await _coordinate_census(db, set())
            return 0

        repairs: list[Repair] = []
        resolved: set[uuid.UUID] = set()
        for row, identity in bare:
            twin = by_id.get(identity.object_id)
            if twin is None:
                twin = by_fields.get((_name_key(identity.address or ""), _name_key(identity.name)))
            if twin is not None and twin.id == row.id:
                twin = None  # itself is not a twin
            rep = Repair(row=row, identity=identity, target=identity.object_id, twin=twin)
            repairs.append(rep)
            found = (
                "the object the importer created is below"  # `_print_pair` names it as `keep`
                if twin is not None
                else "no older twin — this one is re-keyed alone"
            )
            print(f"\n«{unicodedata.normalize('NFC', row.name)}» — keyed on the whole folder name ({found})")

            if twin is not None:
                slots: dict[str, ReferenceDataset] = {
                    ds.module: ds
                    for ds in (
                        await db.execute(select(ReferenceDataset).where(ReferenceDataset.object_id == twin.id))
                    ).scalars()
                    if ds.module
                }
                pair = await _plan_merge(db, twin, row, counts=counts, slots=slots, scales=scales, newest_wins=True)
                rep.pair = pair
                _print_pair(pair)
                scales, _, _ = _retarget_scales(scales, row.id, twin.id)
                if apply:
                    await _apply_pair(db, pair)
                if not pair.deletable:
                    print("       ! left as it is — the bare object still holds a sheet the survivor also has")
                    continue
                resolved.add(row.id)  # its plans are the survivor's now

            survivor = rep.survivor
            address = (survivor.address or "").strip() or identity.address
            if not (survivor.address or "").strip() and identity.address:
                rep.address_filled = identity.address
            if do_geocode and address and (survivor.lat is None or survivor.lng is None):
                rep.coords = await _lookup_coordinates(address)
                if rep.coords:
                    resolved.add(survivor.id)
            if survivor.id != rep.target:
                if apply:
                    await db.flush()  # the fold above must be readable by the scan below
                rep.rekey = await _plan_rekey(
                    db,
                    survivor,
                    rep.target,
                    also=[row.id] if rep.pair else [],
                    moved_datasets=[
                        s.target_id for s in (rep.pair.slots if rep.pair else []) if s.action in ("move", "replace")
                    ],
                    scales=scales,
                    name=identity.name if survivor is row else unicodedata.normalize("NFC", survivor.name),
                    address=address,
                    coords=rep.coords,
                )
                _print_rekey(rep.rekey)
                if rep.rekey.blocked is None:
                    scales, _, _ = _retarget_scales(scales, survivor.id, rep.target)
                    resolved.add(survivor.id)
                    if apply:
                        await _apply_rekey(db, rep.rekey)
                continue
            # Already on the corrected id: only the two fields can still be wrong.
            if rep.address_filled:
                print(f"       → address «{rep.address_filled}» filled in from the folder name")
            if rep.coords:
                print(f"       → geocoded to {rep.coords[0]:.5f}, {rep.coords[1]:.5f}")
            if apply:
                if rep.address_filled:
                    survivor.address = rep.address_filled
                if rep.coords:
                    survivor.lat, survivor.lng = rep.coords
            print("       · the survivor already carries the key the corrected sync derives — no re-key")

        merged = sum(1 for r in repairs if r.pair is not None and r.pair.deletable)
        rekeyed = sum(1 for r in repairs if r.rekey is not None and r.rekey.blocked is None)
        replaced = sum(1 for r in repairs if r.pair for s in r.pair.slots if s.action == "replace")
        moved = sum(1 for r in repairs if r.pair for s in r.pair.slots if s.action == "move")
        geocoded = sum(1 for r in repairs if r.coords)
        stuck = [r for r in repairs if not r.done]
        summary = (
            f"{len(repairs)} object(s) keyed on a whole folder name: {merged} merged into an older twin "
            f"({moved} plan(s) moved, {replaced} superseded sheet(s) replaced), {rekeyed} re-keyed onto the "
            f"corrected key, {geocoded} geocoded" + (f", {len(stuck)} left untouched" if stuck else "")
        )
        if not apply:
            print(f"\nOK (dry-run): would be {summary}. Nothing written. Repeat with --apply to perform it.")
            await _coordinate_census(db, resolved)
            return 1 if stuck else 0
        if station is not None and scales != (station.plan_scales_json or {}):
            station.plan_scales_json = scales
        await db.commit()
        print(f"\n{'INCOMPLETE' if stuck else 'OK'}: {summary}.")
        for unfinished in stuck:
            print(f"       ! {unfinished.row.id} «{unfinished.row.name}» — decide this one by hand")
        # Read back from what was WRITTEN: the same census a second, read-only dry run prints.
        # It does not decide the exit code — a coordinate nobody can geocode is a person's job,
        # not an unfinished repair.
        await _coordinate_census(db, set())
        return 1 if stuck else 0


async def _remove_empty(*, apply: bool, names: list[str]) -> int:
    """Delete objects that carry no plans and that nothing points at — REPORT ONLY unless ``apply``.

    The «Grosspläne» case: a category folder that an import read as an Einsatzobjekt. With no plans
    under it, it falls out here on its own; if it did pick up plans, name it with ``--name`` and it
    goes with them. Either way an object that an incident, a calibration or the audit trail names
    is REFUSED — a station that used the thing is not a station that can lose it silently.
    """
    wanted = {_name_key(n) for n in names}
    async with async_session_maker() as db:
        rows = list((await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars())
        counts = await _plan_counts(db)
        station = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        scales: dict[str, object] = dict(station.plan_scales_json) if station and station.plan_scales_json else {}
        named = {_name_key(r.name) for r in rows}
        for missing in sorted(wanted - named):
            print(f"  ? --name {missing!r}: no object stored under that name")

        removed: list[ObjectSite] = []
        refused: list[tuple[ObjectSite, str]] = []
        for row in rows:
            explicit = _name_key(row.name) in wanted
            plans = counts.get(row.id, 0)
            if plans and not explicit:
                continue
            holds = len(_scale_keys_for(scales, row.id))
            incidents = len(await _incidents_naming(db, row.id))
            events, journal = await _history_naming(db, row.id)
            if holds or incidents or events or journal:
                refused.append(
                    (
                        row,
                        f"{holds} calibration key(s), {incidents} incident(s), "
                        f"{events + journal} history row(s) name it",
                    )
                )
                continue
            removed.append(row)
            print(f"  - {row.id}  {_spelling(row.name)}  ({plans} plan(s){', named explicitly' if explicit else ''})")
            if apply:
                await db.execute(
                    delete(ReferenceDataset)
                    .where(ReferenceDataset.object_id == row.id)
                    .execution_options(synchronize_session=False)
                )
                await db.execute(
                    delete(ObjectSite).where(ObjectSite.id == row.id).execution_options(synchronize_session=False)
                )
        for row, why in refused:
            print(f"  ! {row.id}  {_spelling(row.name)} — NOT removed: {why}", file=sys.stderr)

        if not removed and not refused:
            print(f"No empty objects among {len(rows)} object(s). Nothing to remove.")
            return 0
        plans_gone = sum(counts.get(r.id, 0) for r in removed)
        summary = f"{len(removed)} object(s) with {plans_gone} plan(s) deleted, {len(refused)} refused"
        if not apply:
            print(f"\nOK (dry-run): would be {summary}. Nothing written. Repeat with --apply to perform it.")
            return 0
        await db.commit()
        print(f"\nOK: {summary}.")
        return 0


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
    p_merge = sub.add_parser(
        "merge-duplicates",
        help="fold objects whose names are the same name (NFD/NFC twins, exact duplicates) into one",
    )
    p_merge.add_argument("--apply", action="store_true", help="perform the merge (default: report only, no writes)")
    p_repair = sub.add_parser(
        "repair-sharepoint-keys",
        help="fold objects the SharePoint pull keyed on a whole «Adresse - Name» folder name onto the "
        "convention the importer uses, and report every object without coordinates",
    )
    p_repair.add_argument("--apply", action="store_true", help="perform the repair (default: report only, no writes)")
    p_repair.add_argument(
        "--no-geocode",
        action="store_true",
        help="do not look addresses up at swisstopo (the dry run geocodes too, so its report says "
        "which coordinates the objects would get)",
    )
    p_empty = sub.add_parser("remove-empty", help="delete objects with no plans and no references")
    p_empty.add_argument("--apply", action="store_true", help="perform the deletion (default: report only, no writes)")
    p_empty.add_argument(
        "--name",
        action="append",
        default=[],
        metavar="NAME",
        help="also remove the object stored under this name, plans and all (repeatable) — for a "
        "category folder an import read as an Einsatzobjekt, e.g. 'Grosspläne'",
    )

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
    if args.cmd == "merge-duplicates":
        return await _merge_duplicates(apply=args.apply)
    if args.cmd == "repair-sharepoint-keys":
        return await _repair_sharepoint_keys(apply=args.apply, do_geocode=not args.no_geocode)
    if args.cmd == "remove-empty":
        return await _remove_empty(apply=args.apply, names=args.name)
    # show
    rows = await _show()
    print(json.dumps(rows, indent=2, ensure_ascii=False) if rows else "No objects stored.")
    return 0


def main() -> None:
    sys.exit(asyncio.run(_amain(sys.argv[1:])))


if __name__ == "__main__":
    main()

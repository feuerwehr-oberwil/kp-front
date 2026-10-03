"""Objektbesuche — the domain: documents, revisions, photos, readiness, the change feed.

The contract is docs/object-visits.md; this module is what the three routers
(``api/object_visits`` field, ``api/integrations`` organizer, ``api/object_visits_admin``) call.
Nothing here knows about HTTP beyond :class:`ObjectVisitError`, which carries the status, the
``code`` and the German ``detail`` a refusal answers with.

**What a write does, in one transaction.** ``apply_put`` locks the visit row, answers a replayed
``opId`` with the stored first answer, checks the base revision and the document, writes an
immutable revision row, computes readiness against the stored photos, enqueues delivery when a
revision is ready, and bumps the change-feed counter LAST. ``store_attachment`` does the same for
a photo: it writes the bytes under a fresh key first (backup originals are immutable, AGENTS.md),
then locks the visit, records the row, flips every waiting revision that is now complete and
enqueues delivery — all before the commit.

⚠️ Lock order, everywhere: visit row → delivery rows → the feed counter. The delivery worker's
finish path takes them in the same order (``object_visit_delivery``).

⚠️ ``backend/app/visits.py`` / ``api/visits.py`` / ``admin_visits.py`` are web analytics and
unrelated. The domain here is ``object_visits`` / ``ov``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import unicodedata
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from . import storage
from .checklist_templates import visit_items
from .config import settings
from .models import (
    DeploymentConfig,
    ObjectRef,
    ObjectSite,
    ObjectVisit,
    ObjectVisitAttachment,
    ObjectVisitDelivery,
    ObjectVisitRevision,
    ObjectVisitSeq,
    ReferenceDataset,
    VisitList,
)
from .schemas import ObjectVisitDestination, ObjectVisitsConfig, load_stored_config

logger = logging.getLogger("kpfront.objectvisits")

SCHEMA = "kp-front.object-visit/1"

#: Client-minted ids: visit (ov), photo (ova), proposal (ovp), write operation (ovo).
ID_RE = re.compile(r"^[a-z]{1,4}[0-9a-z-]{6,64}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
#: An integration source name (``fwo-schlue``, ``firegis``) — a path segment, kept plain.
SOURCE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

LIFECYCLES = ("draft", "completed", "discarded")
_TRANSITIONS = {
    "draft": {"draft", "completed", "discarded"},
    "completed": {"completed"},
    "discarded": set(),
}

PHOTO_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024

MAX_PHOTOS = 200
MAX_PROPOSALS = 100
MAX_NOTES = 20_000
MAX_CAPTION = 300
MAX_TEXT = 2_000
MAX_ANSWERS = 500
MAX_WITH = 20
MAX_CONFLICTS = 200
MAX_WORK_REF = 300
MAX_EXTERNAL_ID = 300

#: How a SharePoint pull or the private importer wrote a plan-library folder into `source_note`.
_FOLDER_NOTE = re.compile(r"^[^:/]{1,60}:\s*Einsatzpl(?:ä|ae)ne/(?P<folder>[^/]+?)/?\s*$")


class ObjectVisitError(Exception):
    """A refusal with a machine-readable ``code`` and a German ``detail``.

    Answered by the app-level handler (main.py) as ``{"code", "detail", **extra}`` — the
    contract's top-level shape (``409 {code: "revision_conflict", revision, visit}``), with
    ``detail`` kept so every client that reads ``detail`` keeps working.
    """

    def __init__(self, status: int, code: str, detail: str, **extra: Any) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail
        self.extra = extra

    def body(self) -> dict[str, Any]:
        return {"code": self.code, "detail": self.detail, **self.extra}


def invalid(detail: str) -> ObjectVisitError:
    return ObjectVisitError(422, "invalid", detail)


def not_found(detail: str = "Objektbesuch nicht gefunden") -> ObjectVisitError:
    return ObjectVisitError(404, "not_found", detail)


@dataclass(frozen=True)
class Actor:
    """Who wrote — a person (id + display name) or nobody (the admin session, an organizer)."""

    id: uuid.UUID | None
    name: str | None


# --- config ---------------------------------------------------------------------------


async def ov_config(db: AsyncSession) -> ObjectVisitsConfig:
    """The module's section of the stored config document. A broken document reads as «off»."""
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    raw = row.config_json if (row and row.config_json) else {}
    try:
        return load_stored_config(raw).objectVisits
    except Exception:  # noqa: BLE001 — a bad stored row must not 500 the module
        logger.warning("deployment config failed validation — Objektbesuche read as off", exc_info=True)
        return ObjectVisitsConfig()


async def station_name(db: AsyncSession) -> str:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    identity = ((row.config_json if row else None) or {}).get("identity") or {}
    name = identity.get("appName") if isinstance(identity, dict) else None
    return str(name).strip() if isinstance(name, str) and name.strip() else settings.project_name


def visit_url(visit_id: str) -> str:
    base = (settings.public_url or "").strip().rstrip("/")
    return f"{base}/besuche/{visit_id}"


# --- objects: folders and refs -----------------------------------------------------------


def folder_from_source(source_note: str | None, name: str | None, address: str | None) -> str | None:
    """The plan-library folder an object's provenance names, or None.

    «OneDrive: Einsatzpläne/<folder>» (the private importer) and «SchlüHü hub: Einsatzplaene/<folder>»
    name it outright; an object the SharePoint pull created («SharePoint») came FROM a folder
    «<Adresse> - <Name>», which `admin_objects.folder_identity` split — inverted here.
    """
    note = (source_note or "").strip()
    match = _FOLDER_NOTE.match(note)
    if match:
        return match.group("folder").strip() or None
    if note == "SharePoint" and name:
        clean_name = " ".join(name.split())
        clean_address = " ".join((address or "").split())
        return f"{clean_address} - {clean_name}" if clean_address else clean_name
    return None


def object_folder(obj: ObjectSite) -> str:
    """``{object.folder}``: the filing folder, else the derived one, else «Adresse - Name», else the name."""
    if obj.filing_folder and obj.filing_folder.strip():
        return obj.filing_folder.strip()
    derived = folder_from_source(obj.source_note, obj.name, obj.address)
    if derived:
        return derived
    name = " ".join((obj.name or "").split())
    address = " ".join((obj.address or "").split())
    return f"{address} - {name}" if address and name else name or address or str(obj.id)


def folder_key(folder: str | None) -> str:
    """Compare folder names the way a person reads them: composed, case- and space-insensitive."""
    return " ".join(unicodedata.normalize("NFC", folder or "").split()).casefold()


async def refs_by_object(db: AsyncSession) -> dict[uuid.UUID, list[dict[str, str]]]:
    rows = (await db.execute(select(ObjectRef).order_by(ObjectRef.id))).scalars().all()
    out: dict[uuid.UUID, list[dict[str, str]]] = {}
    for r in rows:
        out.setdefault(r.object_id, []).append({"source": r.source, "id": r.external_id})
    return out


async def resolve_refs(db: AsyncSession, refs: list[dict[str, str]]) -> tuple[list[str], list[dict[str, str]]]:
    """(resolved object ids in order, the refs nothing here knows yet)."""
    rows = (await db.execute(select(ObjectRef.source, ObjectRef.external_id, ObjectRef.object_id))).all()
    known = {(r.source, r.external_id): str(r.object_id) for r in rows}
    ids: list[str] = []
    unresolved: list[dict[str, str]] = []
    for ref in refs:
        oid = known.get((ref.get("source", ""), ref.get("id", "")))
        if oid is None:
            unresolved.append({"source": ref.get("source", ""), "id": ref.get("id", "")})
        elif oid not in ids:
            ids.append(oid)
    return ids, unresolved


async def attach_refs(db: AsyncSession, object_id: uuid.UUID, refs: list[tuple[str, str]]) -> None:
    """Point each ``(source, external_id)`` at ``object_id`` — added, or moved from the object it
    named before (the manifest is the authority on its own ids). Never removes a ref."""
    for source, external_id in refs:
        row = (
            await db.execute(select(ObjectRef).where(ObjectRef.source == source, ObjectRef.external_id == external_id))
        ).scalar_one_or_none()
        if row is None:
            db.add(ObjectRef(object_id=object_id, source=source, external_id=external_id))
        elif row.object_id != object_id:
            row.object_id = object_id
    await db.flush()


async def object_ids_with_plans(db: AsyncSession) -> set[uuid.UUID]:
    rows = (
        await db.execute(select(ReferenceDataset.object_id).where(ReferenceDataset.object_id.is_not(None)).distinct())
    ).scalars()
    return {oid for oid in rows if oid is not None}


def is_integration_only(obj: ObjectSite, with_plans: set[uuid.UUID]) -> bool:
    """An object an organizer created (``source_note`` «Integration: …») that carries no plan —
    a key box, a hydrant. It belongs to the Objektbesuche catalogue, not to an Einsatz's plan rail."""
    return (obj.source_note or "").startswith("Integration:") and obj.id not in with_plans


# --- the document ------------------------------------------------------------------------


def _canonical(doc: Any) -> str:
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _text(value: Any, limit: int, what: str, *, required: bool = False) -> str | None:
    if value is None:
        if required:
            raise invalid(f"{what} fehlt")
        return None
    if not isinstance(value, str):
        raise invalid(f"{what} muss Text sein")
    if len(value) > limit:
        raise invalid(f"{what} ist zu lang (höchstens {limit} Zeichen)")
    if required and not value.strip():
        raise invalid(f"{what} fehlt")
    return value


_UNSTORABLE = re.compile("[\x00\ud800-\udfff]")


def unstorable(value: Any, _depth: int = 0) -> bool:
    """True if any string in ``value`` (keys included) holds a NUL or a lone surrogate.

    Postgres refuses both in ``text`` and ``jsonb`` — the write would 500 — and SQLite does not,
    so only production would find out. Refused up front with a 422 instead.
    """
    if _depth > 64:
        return True
    if isinstance(value, str):
        return _UNSTORABLE.search(value) is not None
    if isinstance(value, dict):
        return any(unstorable(k, _depth + 1) or unstorable(v, _depth + 1) for k, v in value.items())
    if isinstance(value, list):
        return any(unstorable(v, _depth + 1) for v in value)
    return False


def refuse_unstorable(*values: Any) -> None:
    if any(unstorable(v) for v in values):
        raise invalid("Text enthält ein Steuerzeichen (NUL) oder ein ungültiges Unicode-Zeichen")


def count_findings(doc: dict[str, Any]) -> int:
    answers = doc.get("answers") or {}
    return sum(1 for a in answers.values() if isinstance(a, dict) and a.get("v") == "defect")


def photo_ids(doc: dict[str, Any]) -> list[str]:
    return [p["id"] for p in doc.get("photos") or [] if isinstance(p, dict) and isinstance(p.get("id"), str)]


async def validate_doc(db: AsyncSession, visit_id: str, doc: Any, current: ObjectVisit | None) -> uuid.UUID | None:
    """Refuse (422) what the contract refuses; return the visit's object id."""
    if not isinstance(doc, dict):
        raise invalid("Das Dokument muss ein JSON-Objekt sein")
    refuse_unstorable(doc)
    if doc.get("schema") != SCHEMA:
        raise invalid(f"Unbekanntes Schema (erwartet {SCHEMA})")
    if doc.get("id") != visit_id:
        raise invalid("Die id im Dokument passt nicht zur Adresse")

    obj = doc.get("object")
    if not isinstance(obj, dict) or not isinstance(obj.get("id"), str):
        raise invalid("Objekt fehlt")
    try:
        object_id = uuid.UUID(obj["id"])
    except ValueError as e:
        raise invalid("Objekt-id ist ungültig") from e
    unchanged = current is not None and (current.doc.get("object") or {}).get("id") == obj["id"]
    exists = await db.get(ObjectSite, object_id) is not None
    if not unchanged and not exists:
        raise invalid("Objekt unbekannt")
    _text(obj.get("name"), 300, "Objektname")
    _text(obj.get("address"), 300, "Objektadresse")

    _text(doc.get("workRef"), MAX_WORK_REF, "workRef")
    visited = doc.get("visitedAt")
    if _parse_time(visited) is None:
        raise invalid("visitedAt muss ein Zeitpunkt (ISO 8601) sein")
    companions = doc.get("with")
    if companions is not None:
        if not isinstance(companions, list) or len(companions) > MAX_WITH:
            raise invalid(f"with: höchstens {MAX_WITH} Namen")
        for c in companions:
            _text(c, 120, "Begleitperson", required=True)

    lifecycle = doc.get("lifecycle")
    if lifecycle not in LIFECYCLES:
        raise invalid("lifecycle muss draft, completed oder discarded sein")
    if current is not None and lifecycle not in _TRANSITIONS[current.lifecycle]:
        if current.lifecycle == "discarded":
            raise ObjectVisitError(422, "lifecycle", "Ein verworfener Besuch kann nicht mehr geändert werden")
        raise ObjectVisitError(
            422, "lifecycle", "Ein abgeschlossener Besuch wird korrigiert, nicht wieder geöffnet (bleibt «completed»)"
        )

    checklist = doc.get("checklist")
    if checklist is not None and (
        not isinstance(checklist, dict) or not isinstance(checklist.get("id"), str) or not visit_items(checklist)
    ):
        raise invalid("checklist muss eine Besuchs-Checkliste (mit phases/items) oder null sein")
    if (
        current is not None
        and current.lifecycle != "draft"
        and _canonical(checklist) != _canonical(current.doc.get("checklist"))
    ):
        raise invalid("Die Checkliste kann nur in einem Entwurf gewechselt werden")

    answers = doc.get("answers")
    if answers is None:
        answers = {}
    if not isinstance(answers, dict) or len(answers) > MAX_ANSWERS:
        raise invalid("answers muss ein Objekt sein")
    for key, answer in answers.items():
        if not isinstance(key, str) or not key or len(key) > 80:
            raise invalid("answers: ungültige Punkt-id")
        if not isinstance(answer, dict) or "v" not in answer:
            raise invalid(f"answers.{key}: Antwort {{v}} fehlt")
        value = answer["v"]
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            raise invalid(f"answers.{key}: Wert muss Text oder Zahl sein")
        if isinstance(value, float) and not math.isfinite(value):
            raise invalid(f"answers.{key}: Zahl ungültig")
        if isinstance(value, str) and len(value) > MAX_TEXT:
            raise invalid(f"answers.{key}: zu lang")
        _text(answer.get("note"), MAX_TEXT, f"answers.{key}.note")

    _text(doc.get("notes"), MAX_NOTES, "Bemerkungen")

    photos = doc.get("photos") or []
    if not isinstance(photos, list) or len(photos) > MAX_PHOTOS:
        raise invalid(f"Höchstens {MAX_PHOTOS} Fotos pro Besuch")
    seen: set[str] = set()
    for p in photos:
        if not isinstance(p, dict) or not isinstance(p.get("id"), str) or not ID_RE.match(p["id"]):
            raise invalid("Foto ohne gültige id")
        if p["id"] in seen:
            raise invalid(f"Foto {p['id']} kommt doppelt vor")
        seen.add(p["id"])
        _text(p.get("caption"), MAX_CAPTION, "Bildlegende")
        _text(p.get("item"), 80, "Foto-Checklistenpunkt")
        if p.get("sha256") is not None and (not isinstance(p["sha256"], str) or not _SHA256_RE.match(p["sha256"])):
            raise invalid(f"Foto {p['id']}: sha256 ungültig")
        if p.get("type") is not None and p["type"] not in PHOTO_TYPES:
            raise invalid(f"Foto {p['id']}: Typ muss JPEG, PNG oder WebP sein")
        size = p.get("size")
        if size is not None and (isinstance(size, bool) or not isinstance(size, int) or size < 0):
            raise invalid(f"Foto {p['id']}: size ungültig")

    proposals = doc.get("proposals") or []
    if not isinstance(proposals, list) or len(proposals) > MAX_PROPOSALS:
        raise invalid(f"Höchstens {MAX_PROPOSALS} Korrekturvorschläge pro Besuch")
    seen = set()
    for p in proposals:
        if not isinstance(p, dict) or not isinstance(p.get("id"), str) or not ID_RE.match(p["id"]):
            raise invalid("Korrekturvorschlag ohne gültige id")
        if p["id"] in seen:
            raise invalid(f"Korrekturvorschlag {p['id']} kommt doppelt vor")
        seen.add(p["id"])
        _text(p.get("field"), 64, "Korrekturvorschlag: Feld", required=True)
        _text(p.get("label"), 120, "Korrekturvorschlag: Bezeichnung")
        for key in ("current", "proposed", "reason"):
            _text(p.get(key), MAX_TEXT, f"Korrekturvorschlag: {key}")
        if p.get("base") is not None and not isinstance(p["base"], dict):
            raise invalid("Korrekturvorschlag: base muss ein Objekt sein")

    conflicts = doc.get("conflicts")
    if conflicts is not None and (not isinstance(conflicts, list) or len(conflicts) > MAX_CONFLICTS):
        raise invalid("conflicts muss eine Liste sein")
    if exists:
        return object_id
    # The object the visit was recorded at is gone (deleted, merged, re-keyed). The document keeps
    # its snapshot; the link stays where an admin tool moved it, else it is cleared — never a
    # dangling foreign key that fails every later save.
    return current.object_id if current is not None else None


# --- locking, the feed counter --------------------------------------------------------------


def _is_sqlite(db: AsyncSession) -> bool:
    return (db.bind.dialect.name if db.bind is not None else "postgresql") == "sqlite"


async def lock_visit(db: AsyncSession, visit_id: str) -> ObjectVisit | None:
    """The visit row, re-read and locked FOR UPDATE (a no-op lock on SQLite, which serialises
    writers at the file)."""
    stmt = select(ObjectVisit).where(ObjectVisit.id == visit_id).execution_options(populate_existing=True)
    if not _is_sqlite(db):
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


async def bump_seq(db: AsyncSession, visit: ObjectVisit) -> int:
    """Give ``visit`` the next feed number. Call LAST in the transaction (lock order)."""
    if _is_sqlite(db):
        from sqlalchemy.dialects.sqlite import insert as dialect_insert
    else:
        from sqlalchemy.dialects.postgresql import insert as dialect_insert  # type: ignore[assignment]
    upsert = (
        dialect_insert(ObjectVisitSeq)
        .values(id=1, value=1)
        .on_conflict_do_update(index_elements=[ObjectVisitSeq.id], set_={"value": ObjectVisitSeq.value + 1})
        .returning(ObjectVisitSeq.value)
    )
    value = int((await db.execute(upsert)).scalar_one())
    visit.seq = value
    return value


async def bump_seq_many(db: AsyncSession, visits: list[ObjectVisit]) -> None:
    """``bump_seq`` for several visits with ONE counter update (taken last, as always). Each visit
    still gets its own number — equal numbers would let a feed page cut a tie in half."""
    if not visits:
        return
    if _is_sqlite(db):
        from sqlalchemy.dialects.sqlite import insert as dialect_insert
    else:
        from sqlalchemy.dialects.postgresql import insert as dialect_insert  # type: ignore[assignment]
    n = len(visits)
    upsert = (
        dialect_insert(ObjectVisitSeq)
        .values(id=1, value=n)
        .on_conflict_do_update(index_elements=[ObjectVisitSeq.id], set_={"value": ObjectVisitSeq.value + n})
        .returning(ObjectVisitSeq.value)
    )
    top = int((await db.execute(upsert)).scalar_one())
    for offset, visit in enumerate(sorted(visits, key=lambda v: v.id)):
        visit.seq = top - n + 1 + offset


# --- reading ---------------------------------------------------------------------------------


async def stored_attachments(db: AsyncSession, visit_id: str) -> dict[str, ObjectVisitAttachment]:
    rows = (
        (await db.execute(select(ObjectVisitAttachment).where(ObjectVisitAttachment.visit_id == visit_id)))
        .scalars()
        .all()
    )
    return {r.att_id: r for r in rows}


def _who(user_id: uuid.UUID | None, name: str | None) -> dict[str, str | None]:
    return {"id": str(user_id) if user_id else None, "name": name}


def _iso(at: datetime | None) -> str | None:
    if at is None:
        return None
    return (at if at.tzinfo else at.replace(tzinfo=UTC)).isoformat()


async def deliveries_for(db: AsyncSession, visit_id: str) -> list[dict[str, Any]]:
    rows = (
        (
            await db.execute(
                select(ObjectVisitDelivery)
                .where(ObjectVisitDelivery.visit_id == visit_id)
                .order_by(ObjectVisitDelivery.destination)
            )
        )
        .scalars()
        .all()
    )
    out: list[dict[str, Any]] = []
    for d in rows:
        if d.state == "delivered" and d.delivered_revision == 0:
            continue  # a row that never owed anything (e.g. drafts under `completed` timing)
        item: dict[str, Any] = {
            "destination": d.destination,
            "state": d.state,
            "revision": d.delivered_revision,
            "at": _iso(d.updated_at),
        }
        if d.last_error and d.state in ("failed", "pending"):
            item["error"] = d.last_error
        out.append(item)
    return out


async def serialize_visit(db: AsyncSession, visit: ObjectVisit) -> dict[str, Any]:
    """The document plus the server's fields (docs/object-visits.md «Server-added on read»)."""
    stored = await stored_attachments(db, visit.id)
    missing = [pid for pid in photo_ids(visit.doc) if pid not in stored]
    return {
        **visit.doc,
        "revision": visit.revision,
        "ready": visit.ready,
        "missing": missing,
        "createdBy": _who(visit.created_by, visit.created_by_name),
        "createdAt": _iso(visit.created_at),
        "updatedAt": _iso(visit.updated_at),
        "updatedBy": _who(visit.updated_by, visit.updated_by_name),
        "findings": visit.findings,
        "url": visit_url(visit.id),
        "deliveries": await deliveries_for(db, visit.id),
    }


def summary(visit: ObjectVisit) -> dict[str, Any]:
    obj = visit.doc.get("object") or {}
    return {
        "id": visit.id,
        "objectId": str(visit.object_id) if visit.object_id else obj.get("id"),
        "objectName": obj.get("name"),
        "workRef": visit.work_ref,
        "lifecycle": visit.lifecycle,
        "revision": visit.revision,
        "ready": visit.ready,
        "visitedAt": visit.doc.get("visitedAt"),
        "updatedAt": _iso(visit.updated_at),
        "by": _who(visit.created_by, visit.created_by_name),
        "findings": visit.findings,
    }


async def get_visit(db: AsyncSession, visit_id: str) -> ObjectVisit:
    visit = await db.get(ObjectVisit, visit_id) if ID_RE.match(visit_id) else None
    if visit is None:
        raise not_found()
    return visit


async def list_visits(
    db: AsyncSession,
    *,
    object_id: str | None = None,
    work_ref: str | None = None,
    created_by: uuid.UUID | None = None,
    lifecycle: str | None = None,
    limit: int = 100,
) -> list[ObjectVisit]:
    stmt = select(ObjectVisit)
    if object_id:
        try:
            stmt = stmt.where(ObjectVisit.object_id == uuid.UUID(object_id))
        except ValueError as e:
            raise invalid("object muss eine Objekt-id sein") from e
    if work_ref:
        stmt = stmt.where(ObjectVisit.work_ref == work_ref)
    if created_by is not None:
        stmt = stmt.where(ObjectVisit.created_by == created_by)
    if lifecycle:
        if lifecycle not in LIFECYCLES:
            raise invalid("lifecycle muss draft, completed oder discarded sein")
        stmt = stmt.where(ObjectVisit.lifecycle == lifecycle)
    stmt = stmt.order_by(
        ObjectVisit.visited_at.is_(None), ObjectVisit.visited_at.desc(), ObjectVisit.updated_at.desc()
    ).limit(max(1, min(limit, 500)))
    return list((await db.execute(stmt)).scalars().all())


# --- writing a visit -------------------------------------------------------------------------


def _check_op_id(op_id: Any) -> str:
    if not isinstance(op_id, str) or not ID_RE.match(op_id):
        raise invalid("opId fehlt oder ist ungültig")
    return op_id


async def _replayed(db: AsyncSession, visit_id: str, op_id: str) -> dict[str, Any] | None:
    row = (
        await db.execute(
            select(ObjectVisitRevision.response).where(
                ObjectVisitRevision.visit_id == visit_id, ObjectVisitRevision.op_id == op_id
            )
        )
    ).scalar_one_or_none()
    return row


async def apply_put(
    db: AsyncSession, visit_id: str, body: Any, actor: Actor, *, now: datetime | None = None
) -> dict[str, Any]:
    """``PUT /api/object-visits/{id}`` — accept a revision, or replay, or refuse. See module doc."""
    now = now or datetime.now(UTC)
    if not ID_RE.match(visit_id):
        raise invalid("Ungültige Besuchs-id")
    if not isinstance(body, dict):
        raise invalid("Erwartet {opId, baseRevision, doc}")
    op_id = _check_op_id(body.get("opId"))
    base = body.get("baseRevision")
    if base is not None and (isinstance(base, bool) or not isinstance(base, int) or base < 0):
        raise invalid("baseRevision muss eine Zahl oder null sein")
    doc = body.get("doc")

    visit = await lock_visit(db, visit_id)
    if visit is not None:
        replay = await _replayed(db, visit_id, op_id)
        if replay is not None:
            return replay
        # A create for a visit that exists, or a stale base: the client merges and resends.
        if base is None or base != visit.revision:
            raise ObjectVisitError(
                409,
                "revision_conflict",
                "Der Besuch wurde zwischenzeitlich geändert",
                revision=visit.revision,
                visit=await serialize_visit(db, visit),
            )

    object_id = await validate_doc(db, visit_id, doc, visit)
    if not isinstance(doc, dict):  # validate_doc refused it already; this narrows the type
        raise invalid("Das Dokument muss ein JSON-Objekt sein")

    if visit is not None and _canonical(doc) == _canonical(visit.doc):
        stored = await stored_attachments(db, visit_id)
        return {
            "revision": visit.revision,
            "ready": visit.ready,
            "missing": [p for p in photo_ids(doc) if p not in stored],
            "visit": await serialize_visit(db, visit),
        }

    created = visit is None
    if created:
        # ⚠️ A base the server does not know (a visit it has never held, e.g. after a restore) is
        # accepted as the create it has to be: refusing it would strand the only copy on a device.
        visit = ObjectVisit(
            id=visit_id,
            revision=0,
            created_by=actor.id,
            created_by_name=actor.name,
            created_at=now,
            seq=0,
            ready=False,
            findings=0,
            lifecycle="draft",
            doc={},
        )
        try:
            async with db.begin_nested():
                db.add(visit)
                await db.flush()
        except Exception as e:  # IntegrityError: another request created it a moment ago
            from sqlalchemy.exc import IntegrityError

            if not isinstance(e, IntegrityError):
                raise
            visit = await lock_visit(db, visit_id)
            if visit is None:
                raise
            replay = await _replayed(db, visit_id, op_id)
            if replay is not None:
                return replay
            raise ObjectVisitError(
                409,
                "revision_conflict",
                "Der Besuch wurde zwischenzeitlich geändert",
                revision=visit.revision,
                visit=await serialize_visit(db, visit),
            ) from e

    if visit is None:  # unreachable — narrows the type for what follows
        raise not_found()
    stored = await stored_attachments(db, visit_id)
    missing = [p for p in photo_ids(doc) if p not in stored]
    ready = not missing
    revision = visit.revision + 1
    visit.revision = revision
    visit.doc = doc
    visit.lifecycle = str(doc["lifecycle"])
    visit.object_id = object_id
    visit.work_ref = doc.get("workRef") or None
    visit.visited_at = _parse_time(doc.get("visitedAt"))
    visit.findings = count_findings(doc)
    visit.ready = ready
    visit.updated_at = now
    visit.updated_by = actor.id
    visit.updated_by_name = actor.name
    rev = ObjectVisitRevision(
        visit_id=visit_id,
        revision=revision,
        op_id=op_id,
        lifecycle=visit.lifecycle,
        doc=doc,
        ready=ready,
        response={},
        accepted_at=now,
        accepted_by=actor.id,
        accepted_by_name=actor.name,
    )
    db.add(rev)
    await db.flush()
    if ready:
        await enqueue_deliveries(db, visit, now=now)
    await bump_seq(db, visit)
    await db.flush()
    response = {"revision": revision, "ready": ready, "missing": missing, "visit": await serialize_visit(db, visit)}
    rev.response = response
    await db.flush()
    logger.info(
        "object visit %s r%d accepted (%s, ready=%s, missing=%d)",
        visit_id,
        revision,
        visit.lifecycle,
        ready,
        len(missing),
    )
    return response


# --- photos ------------------------------------------------------------------------------------


def _matches_type(content_type: str, head: bytes) -> bool:
    if content_type == "image/webp":
        return len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if content_type == "image/jpeg":
        return head.startswith(b"\xff\xd8\xff")
    if content_type == "image/png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    return False


async def store_attachment(
    db: AsyncSession,
    visit_id: str,
    att_id: str,
    *,
    content_type: str | None,
    declared_sha256: str | None,
    chunks: AsyncIterator[bytes],
    actor: Actor,
    now: datetime | None = None,
) -> tuple[int, dict[str, Any]]:
    """Store one photo; (201 new | 200 already there). See module doc for what else it does."""
    now = now or datetime.now(UTC)
    if not ID_RE.match(att_id):
        raise invalid("Ungültige Foto-id")
    digest_claim = (declared_sha256 or "").strip().lower()
    if not _SHA256_RE.match(digest_claim):
        raise invalid("X-Content-SHA256 fehlt oder ist kein SHA-256 (hex)")
    ctype = (content_type or "").split(";", 1)[0].strip().lower()
    if ctype not in PHOTO_TYPES:
        raise invalid("Foto muss JPEG, PNG oder WebP sein")
    visit = await db.get(ObjectVisit, visit_id) if ID_RE.match(visit_id) else None
    if visit is None:
        raise ObjectVisitError(404, "visit_not_found", "Besuch unbekannt — zuerst den Besuch senden")

    existing = (await stored_attachments(db, visit_id)).get(att_id)
    if existing is not None:
        if existing.sha256 == digest_claim:
            return 200, {"id": att_id, "sha256": existing.sha256, "size": existing.size}
        raise ObjectVisitError(409, "attachment_conflict", "Unter dieser Foto-id liegt bereits ein anderes Bild")

    # The original goes to a FRESH key before any SQL row names it (backup originals are
    # immutable); a refusal below removes it again, a rollback through created_in_transaction.
    key = storage.new_key(f"object-visits/{visit_id}", PHOTO_TYPES[ctype])
    hasher = hashlib.sha256()
    head = bytearray()

    async def _hashed() -> AsyncIterator[bytes]:
        async for chunk in chunks:
            if len(head) < 16:
                head.extend(chunk[: 16 - len(head)])
            hasher.update(chunk)
            yield chunk

    try:
        size = await storage.put_astream(key, _hashed(), max_bytes=MAX_ATTACHMENT_BYTES)
    except storage.TooLargeError:
        raise invalid(f"Foto ist zu gross (höchstens {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB)") from None
    refusal: ObjectVisitError | None = None
    if size == 0:
        refusal = invalid("Leerer Inhalt")
    elif hasher.hexdigest() != digest_claim:
        refusal = invalid("Inhalt passt nicht zu X-Content-SHA256")
    elif not _matches_type(ctype, bytes(head)):
        refusal = invalid(f"Dateiinhalt entspricht nicht dem Typ {ctype}")
    if refusal is not None:
        storage.delete(key)
        raise refusal
    storage.created_in_transaction(db, key)

    visit = await lock_visit(db, visit_id)
    if visit is None:  # deleted while the bytes streamed
        raise ObjectVisitError(404, "visit_not_found", "Besuch unbekannt — zuerst den Besuch senden")
    again = (await stored_attachments(db, visit_id)).get(att_id)
    if again is not None:
        # A concurrent upload of the same photo won the race: this copy is surplus.
        storage.delete(key)
        if again.sha256 == digest_claim:
            return 200, {"id": att_id, "sha256": again.sha256, "size": again.size}
        raise ObjectVisitError(409, "attachment_conflict", "Unter dieser Foto-id liegt bereits ein anderes Bild")
    db.add(
        ObjectVisitAttachment(
            visit_id=visit_id,
            att_id=att_id,
            sha256=digest_claim,
            size=size,
            content_type=ctype,
            storage_key=key,
            created_by=actor.id,
            created_at=now,
        )
    )
    await db.flush()
    if await refresh_readiness(db, visit, now=now):
        await enqueue_deliveries(db, visit, now=now)
        await bump_seq(db, visit)
    await db.flush()
    return 201, {"id": att_id, "sha256": digest_claim, "size": size}


async def refresh_readiness(db: AsyncSession, visit: ObjectVisit, *, now: datetime) -> bool:
    """Mark every waiting revision whose photos are now all stored. True if anything flipped."""
    waiting = (
        (
            await db.execute(
                select(ObjectVisitRevision).where(
                    ObjectVisitRevision.visit_id == visit.id, ObjectVisitRevision.ready.is_(False)
                )
            )
        )
        .scalars()
        .all()
    )
    if not waiting:
        return False
    stored = set(await stored_attachments(db, visit.id))
    flipped = False
    for rev in waiting:
        if all(pid in stored for pid in photo_ids(rev.doc)):
            rev.ready = True
            flipped = True
            if rev.revision == visit.revision:
                visit.ready = True
                visit.updated_at = now
    if flipped:
        await db.flush()  # the enqueue that follows reads the flags back with a query
    return flipped


# --- delivery enqueue ---------------------------------------------------------------------


def eligible(timing: str, lifecycle: str, ready: bool, delivered_before: bool) -> bool:
    """Is a revision one a destination with this ``timing`` files? (docs/object-visits.md)"""
    if not ready:
        return False
    if timing == "every-sync":
        return True
    return lifecycle == "completed" or (lifecycle == "discarded" and delivered_before)


async def enqueue_deliveries(
    db: AsyncSession,
    visit: ObjectVisit,
    *,
    now: datetime,
    destinations: list[ObjectVisitDestination] | None = None,
) -> bool:
    """Raise ``wanted_revision`` on each destination's outbox row (creating it) to the newest
    eligible ready revision. Inside the writer's transaction — that is the contract's «in the same
    transaction». A destination that is disabled gets its row PAUSED, not skipped."""
    if destinations is None:
        destinations = (await ov_config(db)).destinations
    if not destinations:
        return False
    revs = (
        await db.execute(
            select(ObjectVisitRevision.revision, ObjectVisitRevision.lifecycle, ObjectVisitRevision.ready).where(
                ObjectVisitRevision.visit_id == visit.id
            )
        )
    ).all()
    rows = {
        d.destination: d
        for d in (
            await db.execute(select(ObjectVisitDelivery).where(ObjectVisitDelivery.visit_id == visit.id))
        ).scalars()
    }
    changed = False
    for dest in destinations:
        row = rows.get(dest.id)
        delivered = row.delivered_revision if row else 0
        wanted = max(
            (
                r.revision
                for r in revs
                if r.revision > delivered and eligible(dest.timing, r.lifecycle, r.ready, delivered > 0)
            ),
            default=0,
        )
        if wanted == 0:
            continue
        if row is None:
            db.add(
                ObjectVisitDelivery(
                    id=uuid.uuid4(),
                    destination=dest.id,
                    visit_id=visit.id,
                    wanted_revision=wanted,
                    delivered_revision=0,
                    state="pending" if dest.enabled else "paused",
                    attempts=0,
                    next_attempt_at=now,
                    remote_items={},
                    created_at=now,
                    updated_at=now,
                )
            )
            changed = True
        elif wanted > row.wanted_revision:
            row.wanted_revision = wanted
            if row.state == "delivered":
                row.state = "pending" if dest.enabled else "paused"
                row.next_attempt_at = now
            row.updated_at = now
            changed = True
    if changed:
        await db.flush()
    return changed


# --- catalogue -------------------------------------------------------------------------------


async def visit_templates(db: AsyncSession) -> list[dict[str, Any]]:
    """Every ``checklists:<id>`` template of kind ``visit``, parsed. Incident templates are not here."""
    rows = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id.like("checklists:%")))).scalars().all()
    out: list[dict[str, Any]] = []
    for ds in rows:
        if ":" in ds.id[len("checklists:") :] or not ds.storage_key:
            continue
        try:
            tpl = json.loads(await storage.aget_bytes(ds.storage_key))
        except (OSError, ValueError):
            logger.warning("checklist template %s is unreadable — left out of the catalogue", ds.id)
            continue
        if isinstance(tpl, dict) and tpl.get("kind") == "visit":
            out.append(tpl)
    out.sort(key=lambda t: (t.get("order") if isinstance(t.get("order"), int) else 1_000_000, str(t.get("title"))))
    return out


async def visit_lists(db: AsyncSession) -> list[dict[str, Any]]:
    rows = (await db.execute(select(VisitList).order_by(VisitList.ref))).scalars().all()
    out: list[dict[str, Any]] = []
    for vl in rows:
        ids, unresolved = await resolve_refs(db, list(vl.items or []))
        out.append(
            {
                "ref": vl.ref,
                "title": vl.title,
                "note": vl.note,
                "closesAt": _iso(vl.closes_at),
                "objectIds": ids,
                "unresolved": unresolved,
            }
        )
    return out


async def catalogue(db: AsyncSession, *, can_capture: bool) -> dict[str, Any]:
    """``GET /catalogue``: every object (with or without plans), the visit templates, the lists."""
    cfg = await ov_config(db)
    objects = (await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars().all()
    with_plans = await object_ids_with_plans(db)
    refs = await refs_by_object(db)
    last: dict[uuid.UUID, dict[str, Any]] = {}
    visits = (
        await db.execute(
            select(
                ObjectVisit.id, ObjectVisit.object_id, ObjectVisit.visited_at, ObjectVisit.lifecycle, ObjectVisit.doc
            )
            .where(ObjectVisit.lifecycle != "discarded", ObjectVisit.object_id.is_not(None))
            .order_by(ObjectVisit.visited_at)
        )
    ).all()
    for v in visits:
        if v.object_id is not None:
            last[v.object_id] = {"id": v.id, "visitedAt": (v.doc or {}).get("visitedAt"), "lifecycle": v.lifecycle}
    return {
        "generatedAt": datetime.now(UTC).isoformat(),
        "canCapture": can_capture,
        "objects": [
            {
                "id": str(o.id),
                "name": o.name,
                "address": o.address,
                "lat": float(o.lat) if o.lat is not None else None,
                "lng": float(o.lng) if o.lng is not None else None,
                "folder": object_folder(o),
                "refs": refs.get(o.id, []),
                "hasPlans": o.id in with_plans,
                "lastVisit": last.get(o.id),
            }
            for o in objects
        ],
        "templates": await visit_templates(db),
        "lists": await visit_lists(db),
        "proposalFields": [f.model_dump() for f in cfg.proposalFields],
    }


# --- the organizer's change feed ---------------------------------------------------------------


async def feed(db: AsyncSession, *, after: int, limit: int) -> dict[str, Any]:
    limit = max(1, min(limit, 500))
    visits = (
        (await db.execute(select(ObjectVisit).where(ObjectVisit.seq > after).order_by(ObjectVisit.seq).limit(limit)))
        .scalars()
        .all()
    )
    refs = await refs_by_object(db)
    items: list[dict[str, Any]] = []
    for v in visits:
        obj = v.doc.get("object") or {}
        items.append(
            {
                "seq": v.seq,
                "id": v.id,
                "objectId": str(v.object_id) if v.object_id else obj.get("id"),
                "objectRefs": refs.get(v.object_id, []) if v.object_id else list(obj.get("refs") or []),
                "objectName": obj.get("name"),
                "workRef": v.work_ref,
                "revision": v.revision,
                "lifecycle": v.lifecycle,
                "ready": v.ready,
                "visitedAt": v.doc.get("visitedAt"),
                "updatedAt": _iso(v.updated_at),
                "by": _who(v.created_by, v.created_by_name),
                "findings": v.findings,
                "proposals": list(v.doc.get("proposals") or []),
                "deliveries": await deliveries_for(db, v.id),
                "url": visit_url(v.id),
            }
        )
    return {"items": items, "nextAfter": items[-1]["seq"] if items else after}


# --- organizer writes ----------------------------------------------------------------------------


async def upsert_integration_object(
    db: AsyncSession, source: str, external_id: str, body: dict[str, Any]
) -> dict[str, Any]:
    """``PUT /api/integrations/objects/{source}/{externalId}`` — see docs/object-visits.md."""
    refuse_unstorable(external_id, body)
    if not SOURCE_RE.match(source):
        raise invalid("source: Kleinbuchstaben, Ziffern, '.', '_' oder '-'")
    if not external_id or len(external_id) > MAX_EXTERNAL_ID:
        raise invalid(f"externalId fehlt oder ist länger als {MAX_EXTERNAL_ID} Zeichen")
    name = _text(body.get("name"), 300, "name", required=True) or ""
    address = _text(body.get("address"), 300, "address")
    folder = _text(body.get("folder"), 300, "folder")
    lat, lng = body.get("lat"), body.get("lng")
    for label, value, bound in (("lat", lat, 90), ("lng", lng, 180)):
        if value is not None and (
            isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
        ):
            raise invalid(f"{label} muss eine Zahl sein")
        if value is not None and abs(value) > bound:
            raise invalid(f"{label} liegt ausserhalb von WGS84")
    if (lat is None) != (lng is None):
        raise invalid("lat und lng nur zusammen")

    with_plans = await object_ids_with_plans(db)
    ref = (
        await db.execute(select(ObjectRef).where(ObjectRef.source == source, ObjectRef.external_id == external_id))
    ).scalar_one_or_none()
    obj: ObjectSite | None = await db.get(ObjectSite, ref.object_id) if ref is not None else None
    created = False
    if obj is None and folder and folder.strip():
        wanted = folder_key(folder)
        for candidate in (await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars():
            if folder_key(object_folder(candidate)) == wanted:
                obj = candidate
                break
    if obj is None:
        obj = ObjectSite(
            id=uuid.uuid4(),
            name=name.strip(),
            address=(address or "").strip() or None,
            lat=lat,
            lng=lng,
            filing_folder=(folder or "").strip() or None,
            source_note=f"Integration: {source}",
        )
        db.add(obj)
        created = True
    else:
        # Fill what the object lacks; never rename one that carries plans — those names are
        # what an Einsatz's plan rail shows, and they belong to the plan pipeline.
        if folder and folder.strip() and not (obj.filing_folder or "").strip():
            obj.filing_folder = folder.strip()
        if lat is not None and obj.lat is None:
            obj.lat, obj.lng = lat, lng
        if is_integration_only(obj, with_plans) and obj.source_note == f"Integration: {source}":
            obj.name = name.strip()
            obj.address = (address or "").strip() or obj.address
    await db.flush()
    if ref is None:
        db.add(ObjectRef(object_id=obj.id, source=source, external_id=external_id))
    elif ref.object_id != obj.id:
        ref.object_id = obj.id
    await db.flush()
    return {"objectId": str(obj.id), "created": created}


async def put_visit_list(db: AsyncSession, ref: str, body: dict[str, Any]) -> dict[str, Any]:
    refuse_unstorable(ref, body)
    if not ref or len(ref) > 200 or any(not c.isprintable() for c in ref):
        raise invalid("ref fehlt oder ist ungültig")
    title = _text(body.get("title"), 200, "title", required=True) or ""
    note = _text(body.get("note"), MAX_TEXT, "note")
    closes = body.get("closesAt")
    closes_at = _parse_time(closes) if closes is not None else None
    if closes is not None and closes_at is None:
        raise invalid("closesAt muss ein Zeitpunkt (ISO 8601) sein")
    items = body.get("objects")
    if not isinstance(items, list) or len(items) > 500:
        raise invalid("objects: eine Liste von höchstens 500 {source, id}")
    clean: list[dict[str, str]] = []
    for item in items:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("source"), str)
            or not isinstance(item.get("id"), str)
            or not SOURCE_RE.match(item["source"])
            or not item["id"]
            or len(item["id"]) > MAX_EXTERNAL_ID
        ):
            raise invalid("objects: jeder Eintrag braucht {source, id}")
        clean.append({"source": item["source"], "id": item["id"]})
    row = await db.get(VisitList, ref)
    if row is None:
        row = VisitList(ref=ref, title=title, items=clean)
        db.add(row)
    row.title = title.strip()
    row.note = note
    row.closes_at = closes_at
    row.items = clean
    row.updated_at = datetime.now(UTC)
    await db.flush()
    ids, unresolved = await resolve_refs(db, clean)
    return {"ref": ref, "objectIds": ids, "unresolved": unresolved}


async def delete_visit_list(db: AsyncSession, ref: str) -> dict[str, Any]:
    refuse_unstorable(ref)
    row = await db.get(VisitList, ref)
    if row is not None:
        await db.delete(row)
        await db.flush()
    return {"ref": ref, "deleted": row is not None}


async def visit_count(db: AsyncSession) -> int:
    return int((await db.execute(select(func.count()).select_from(ObjectVisit))).scalar_one())


async def mark_deliveries(db: AsyncSession, *, destination: str, visit_id: str | None, now: datetime) -> int:
    """«Erneut versuchen»: failed → pending with attempts reset (and, for one visit, enqueue
    anything not yet in the outbox — e.g. a destination added after the visit was filed).

    Lock order: all visits first (sorted), then their delivery rows, the counter once at the end.
    """
    stmt = select(ObjectVisitDelivery.visit_id).where(
        ObjectVisitDelivery.destination == destination, ObjectVisitDelivery.state == "failed"
    )
    if visit_id:
        stmt = stmt.where(ObjectVisitDelivery.visit_id == visit_id)
    targets = set((await db.execute(stmt)).scalars().all())
    if visit_id:
        targets.add(visit_id)
    cfg = await ov_config(db)
    dests = [d for d in cfg.destinations if d.id == destination]
    visits = [v for v in [await lock_visit(db, vid) for vid in sorted(targets)] if v is not None]
    touched: list[ObjectVisit] = []
    for visit in visits:
        result = await db.execute(
            update(ObjectVisitDelivery)
            .where(
                ObjectVisitDelivery.destination == destination,
                ObjectVisitDelivery.visit_id == visit.id,
                ObjectVisitDelivery.state == "failed",
            )
            .values(
                state="pending",
                attempts=0,
                next_attempt_at=now,
                last_error=None,
                failed_fingerprint=None,
                updated_at=now,
            )
            .returning(ObjectVisitDelivery.id)
        )
        changed = result.one_or_none() is not None
        if dests and await enqueue_deliveries(db, visit, now=now, destinations=dests):
            changed = True
        if changed:
            touched.append(visit)
    await bump_seq_many(db, touched)
    await db.flush()
    return len(touched)


# --- reports ---------------------------------------------------------------------------------


async def revision_row(db: AsyncSession, visit_id: str, revision: int) -> ObjectVisitRevision:
    row = await db.get(ObjectVisitRevision, (visit_id, revision))
    if row is None:
        raise not_found("Revision nicht gefunden")
    return row


async def photo_bytes(
    db: AsyncSession, visit_id: str, doc: dict[str, Any], cache: dict[str, bytes | None] | None = None
) -> dict[str, bytes | None]:
    """Stored bytes for every photo a document lists — None where nothing is stored (yet).

    With ``cache`` (a delivery pass), each original is read and DOWNSCALED once and the small
    copy reused for every further report of that pass."""
    import anyio

    from .object_visit_report import downscale_photo

    stored = await stored_attachments(db, visit_id)
    out: dict[str, bytes | None] = {}
    for pid in photo_ids(doc):
        if cache is not None and pid in cache:
            out[pid] = cache[pid]
            continue
        att = stored.get(pid)
        data: bytes | None = None
        if att is not None:
            try:
                data = await storage.aget_bytes(att.storage_key)
            except OSError:
                logger.warning("object visit %s: photo %s is missing from storage", visit_id, pid)
        if cache is not None and data is not None:
            data = await anyio.to_thread.run_sync(downscale_photo, data) or data
            cache[pid] = data
        out[pid] = data
    return out


async def render_report(
    db: AsyncSession,
    visit: ObjectVisit,
    revision: int | None = None,
    *,
    cache: dict[str, bytes | None] | None = None,
) -> bytes:
    """The report PDF of ``revision`` (default: the latest)."""
    import anyio

    from .object_visit_report import render_visit_pdf

    n = revision if revision is not None else visit.revision
    row = await revision_row(db, visit.id, n)
    photos = await photo_bytes(db, visit.id, row.doc, cache)
    station = await station_name(db)
    return await anyio.to_thread.run_sync(
        lambda: render_visit_pdf(
            row.doc,
            revision=n,
            stand=row.accepted_at,
            station=station,
            url=visit_url(visit.id),
            created_by=visit.created_by_name,
            photos=photos,
        )
    )

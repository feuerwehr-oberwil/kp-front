"""Objektbesuche — the field API, ``/api/object-visits`` (docs/object-visits.md «Field API»).

Who may come in:

* an ACCOUNT session reads (``editor``, ``el``, ``viewer``); it writes when its role is in
  ``objectVisits.captureRoles`` (default editor + el);
* the deployment-ADMIN session reads everything, and reads it even while the module is off;
* an incident-LINK session (alarm, view, Atemschutz, terminal) is refused with 403 on every
  route — a visit is station business, not an Einsatz's. (The app-level link allowlist refuses
  it too; this dependency says so explicitly so the rule does not hang off a list.)

Module off ⇒ 404 ``{code: "object_visits_disabled"}`` for everyone but the admin session.
"""

from __future__ import annotations

import asyncio
import io
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import APIRouter, Body, Cookie, Depends, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from .. import object_visits as ov
from .. import storage
from ..auth.dependencies import _admin_session_valid, get_current_user
from ..auth.incident_link import link_page_owns_session, read_link_session
from ..database import get_db
from ..models import ObjectVisit, User

router = APIRouter(prefix="/object-visits", tags=["object-visits"])

_LINK_REFUSED = ov.ObjectVisitError(403, "link_session", "Objektbesuche sind über einen Einsatz-Link nicht erreichbar")
_DISABLED = ov.ObjectVisitError(
    404, "object_visits_disabled", "Objektbesuche sind auf dieser Station nicht eingeschaltet"
)


@dataclass(frozen=True)
class Reader:
    """Who is reading: an account (``user``) or the admin session (``user`` None)."""

    user: User | None
    can_capture: bool

    @property
    def is_admin(self) -> bool:
        return self.user is None

    @property
    def actor(self) -> ov.Actor:
        if self.user is None:
            return ov.Actor(None, None)
        return ov.Actor(self.user.id, self.user.display_name or self.user.username)


def _is_link(user: User | None) -> bool:
    return bool(getattr(user, "link_kind", None)) or bool(getattr(user, "link_scoped", False))


async def get_reader(
    request: Request,
    access_token: Annotated[str | None, Cookie()] = None,
    admin_session: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> Reader:
    if link_page_owns_session(request):
        raise _LINK_REFUSED
    user: User | None = None
    if access_token:
        try:
            user = await get_current_user(request, access_token, db)
        except HTTPException:
            user = None
    if user is not None and _is_link(user):
        raise _LINK_REFUSED
    cfg = await ov.ov_config(db)
    if user is not None:
        if not cfg.enabled:
            raise _DISABLED
        return Reader(user=user, can_capture=user.role in cfg.captureRoles)
    if await _admin_session_valid(admin_session):
        return Reader(user=None, can_capture=False)
    # A link session, or the Erfassungs-Poster's capture token: a credential, but never one
    # that reaches a visit — 403, not the 401 that would invite a login.
    if read_link_session(request) is not None or request.headers.get("x-capture-token"):
        raise _LINK_REFUSED
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Nicht angemeldet")


async def get_writer(reader: Annotated[Reader, Depends(get_reader)]) -> Reader:
    if reader.user is None or not reader.can_capture:
        raise ov.ObjectVisitError(403, "forbidden", "Diese Rolle darf keine Objektbesuche erfassen")
    return reader


CurrentReader = Annotated[Reader, Depends(get_reader)]
CurrentWriter = Annotated[Reader, Depends(get_writer)]


# --- shared read helpers (the organizer router uses them too) --------------------------------


async def attachment_response(db: AsyncSession, visit_id: str, att_id: str, thumb: bool) -> FileResponse:
    from .media import _render_thumb

    stored = (await ov.stored_attachments(db, visit_id)).get(att_id)
    if stored is None or not storage.exists(stored.storage_key):
        raise ov.not_found("Foto nicht gefunden")
    headers = {"Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"}
    if not thumb:
        return FileResponse(storage.local_path(stored.storage_key), media_type=stored.content_type, headers=headers)
    key = f"{stored.storage_key}.thumb.jpg"
    if not storage.exists(key):
        try:
            await asyncio.to_thread(_render_thumb, storage.local_path(stored.storage_key), key)
        except Exception:  # noqa: BLE001 — a derived file; the original is the fallback
            return FileResponse(storage.local_path(stored.storage_key), media_type=stored.content_type, headers=headers)
    return FileResponse(storage.local_path(key), media_type="image/jpeg", headers=headers)


async def report_response(db: AsyncSession, visit: ObjectVisit, revision: int | None) -> StreamingResponse:
    pdf = await ov.render_report(db, visit, revision)
    n = revision if revision is not None else visit.revision
    return StreamingResponse(
        io.BytesIO(pdf),
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="objektbesuch-{visit.id}-r{n}.pdf"'},
    )


# --- routes ------------------------------------------------------------------------------------


@router.get("/catalogue")
async def get_catalogue(reader: CurrentReader, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Everything the field app caches for offline use: objects, visit templates, work lists."""
    return await ov.catalogue(db, can_capture=reader.can_capture)


@router.get("")
async def list_visits(
    reader: CurrentReader,
    object: str | None = None,
    workRef: str | None = None,  # noqa: N803 — the contract's query parameter name
    mine: bool = False,
    lifecycle: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    visits = await ov.list_visits(
        db,
        object_id=object,
        work_ref=workRef,
        created_by=reader.user.id if (mine and reader.user is not None) else None,
        lifecycle=lifecycle,
        limit=limit,
    )
    return [ov.summary(v) for v in visits]


@router.get("/{visit_id}")
async def get_visit(visit_id: str, _reader: CurrentReader, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    return await ov.serialize_visit(db, await ov.get_visit(db, visit_id))


@router.put("/{visit_id}")
async def put_visit(
    visit_id: str,
    writer: CurrentWriter,
    body: Annotated[dict[str, Any], Body()],
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """``{opId, baseRevision, doc}`` → ``{revision, ready, missing, visit}``; see the contract
    for the 409 (stale base) and the idempotent replay of a known ``opId``."""
    return await ov.apply_put(db, visit_id, body, writer.actor)


@router.put("/{visit_id}/attachments/{att_id}", status_code=201)
async def put_attachment(
    visit_id: str,
    att_id: str,
    request: Request,
    writer: CurrentWriter,
    content_type: Annotated[str | None, Header()] = None,
    x_content_sha256: Annotated[str | None, Header()] = None,
    db: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """Raw photo bytes. 201 new · 200 the same bytes were already stored · 409 another body."""
    code, payload = await ov.store_attachment(
        db,
        visit_id,
        att_id,
        content_type=content_type,
        declared_sha256=x_content_sha256,
        chunks=request.stream(),
        actor=writer.actor,
    )
    return JSONResponse(payload, status_code=code)


@router.get("/{visit_id}/attachments/{att_id}")
async def get_attachment(
    visit_id: str,
    att_id: str,
    _reader: CurrentReader,
    thumb: bool = False,
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    await ov.get_visit(db, visit_id)
    return await attachment_response(db, visit_id, att_id, thumb)


@router.get("/{visit_id}/revisions")
async def list_revisions(visit_id: str, _reader: CurrentReader, db: AsyncSession = Depends(get_db)) -> list[dict]:
    from sqlalchemy import select

    from ..models import ObjectVisitRevision

    await ov.get_visit(db, visit_id)
    rows = (
        await db.execute(
            select(
                ObjectVisitRevision.revision,
                ObjectVisitRevision.lifecycle,
                ObjectVisitRevision.accepted_at,
                ObjectVisitRevision.accepted_by,
                ObjectVisitRevision.accepted_by_name,
                ObjectVisitRevision.ready,
            )
            .where(ObjectVisitRevision.visit_id == visit_id)
            .order_by(ObjectVisitRevision.revision)
        )
    ).all()
    return [
        {
            "revision": r.revision,
            "lifecycle": r.lifecycle,
            "acceptedAt": r.accepted_at.isoformat() if r.accepted_at else None,
            "acceptedBy": {"id": str(r.accepted_by) if r.accepted_by else None, "name": r.accepted_by_name},
            "ready": r.ready,
        }
        for r in rows
    ]


@router.get("/{visit_id}/revisions/{revision}")
async def get_revision(
    visit_id: str, revision: int, _reader: CurrentReader, db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    await ov.get_visit(db, visit_id)
    row = await ov.revision_row(db, visit_id, revision)
    return {
        **row.doc,
        "revision": row.revision,
        "ready": row.ready,
        "acceptedAt": row.accepted_at.isoformat() if row.accepted_at else None,
        "acceptedBy": {"id": str(row.accepted_by) if row.accepted_by else None, "name": row.accepted_by_name},
    }


@router.get("/{visit_id}/report.pdf")
async def get_report(
    visit_id: str,
    _reader: CurrentReader,
    revision: int | None = Query(default=None, ge=1),
    db: AsyncSession = Depends(get_db),
) -> Response:
    return await report_response(db, await ov.get_visit(db, visit_id), revision)

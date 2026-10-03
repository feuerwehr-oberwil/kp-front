"""Objektbesuche — the organizer API, ``/api/integrations`` (docs/object-visits.md).

An outside organizer (fwo-admin, fwo-stats) authenticates with ``Authorization: Bearer <key>``,
the credential ``object_visits_integration_key`` an admin sets in /admin. Unset ⇒ 403, wrong or
missing ⇒ 401, compared in constant time (``auth/secret_token.SecretGate``). A browser session
does not stand in for the key — and the key opens nothing on the field routes.

It may: read the catalogue, upsert objects by its own ids, push read-only work lists, poll the
change feed, and read a visit, its report and its photos. It never writes a visit.

⚠️ Path parameters that carry an organizer's id use the ``:path`` converter: a list ref like
``fwo-admin:fu-2026/B4`` contains a «/», and Starlette decodes ``%2F`` before routing.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, Header, Query
from fastapi.responses import FileResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession

from .. import object_visits as ov
from .. import storage
from .. import visit_programmes as programmes
from ..auth.secret_token import SecretGate
from ..credentials import get as credential
from ..credentials import load as load_credentials
from ..database import get_db
from ..models import PlanRevision
from .object_visits import attachment_response, report_response

router = APIRouter(prefix="/integrations", tags=["integrations"])

_GATE = SecretGate(
    disabled_detail="Organizer-Zugang ist nicht eingerichtet (kein Schlüssel gesetzt)",
    invalid_detail="Organizer-Schlüssel fehlt oder ist falsch",
)


async def require_organizer(
    authorization: Annotated[str | None, Header()] = None, db: AsyncSession = Depends(get_db)
) -> None:
    await load_credentials(db)
    token = None
    if authorization and authorization[:7].lower() == "bearer ":
        token = authorization[7:].strip()
    _GATE.check(credential("object_visits_integration_key") or None, token)
    if not (await ov.ov_config(db)).enabled:
        raise ov.ObjectVisitError(
            404, "object_visits_disabled", "Objektbesuche sind auf dieser Station nicht eingeschaltet"
        )


Organizer = Annotated[None, Depends(require_organizer)]


@router.get("/visit-programmes/{ref}")
async def get_programme(ref: str, _org: Organizer, db: AsyncSession = Depends(get_db)) -> dict:
    return await programmes.read(db, ref)


@router.put("/visit-programmes/{ref}/routes")
async def put_programme_routes(
    ref: str, body: programmes.RoutesUpdate, _org: Organizer, db: AsyncSession = Depends(get_db)
) -> dict:
    return await programmes.save_routes(db, ref, body)


@router.put("/visit-programmes/{ref}/years/{year}")
async def publish_programme(
    ref: str, year: int, body: programmes.Publish, _org: Organizer, db: AsyncSession = Depends(get_db)
) -> dict:
    return await programmes.publish(db, ref, year, body)


@router.get("/object-visits/catalogue")
async def organizer_catalogue(_org: Organizer, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    return await ov.catalogue(db, can_capture=False)


@router.get("/object-visits/changes")
async def organizer_changes(
    _org: Organizer,
    after: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """One item per visit at its latest state, ordered by ``seq``. Poll with ``after=nextAfter``."""
    return await ov.feed(db, after=after, limit=limit)


@router.get("/object-visits/{visit_id}")
async def organizer_visit(visit_id: str, _org: Organizer, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    return await ov.serialize_visit(db, await ov.get_visit(db, visit_id))


@router.get("/object-visits/{visit_id}/report.pdf")
async def organizer_report(
    visit_id: str,
    _org: Organizer,
    revision: int | None = Query(default=None, ge=1),
    db: AsyncSession = Depends(get_db),
) -> Response:
    return await report_response(db, await ov.get_visit(db, visit_id), revision)


@router.get("/object-visits/{visit_id}/attachments/{att_id}")
async def organizer_attachment(
    visit_id: str, att_id: str, _org: Organizer, thumb: bool = False, db: AsyncSession = Depends(get_db)
) -> FileResponse:
    await ov.get_visit(db, visit_id)
    return await attachment_response(db, visit_id, att_id, thumb)


@router.get("/objects/by-ref/{source}/{external_id:path}")
async def organizer_object_by_ref(
    source: str, external_id: str, _org: Organizer, db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    """Resolve the organizer's own id to this deployment's object: ``{objectId, name, address,
    lat, lng, folder, refs, hasPlans}`` (404 when no such ref)."""
    return await ov.object_summary(db, await ov.object_by_ref(db, source, external_id))


@router.get("/objects/{object_id}/plans")
async def organizer_object_plans(
    object_id: uuid.UUID, _org: Organizer, db: AsyncSession = Depends(get_db)
) -> list[dict[str, Any]]:
    """The object's current plans, one per Modul-Slot (read-only): ``[{module, title, revision,
    contentType, size}]``. ``revision`` is the plan's current version — pass it back as
    ``?revision=`` to get exactly those bytes later."""
    return [
        {
            "module": ds.module,
            "title": ds.title,
            "revision": ds.current_version,
            "contentType": ds.content_type or "application/pdf",
            "size": ds.size_bytes,
        }
        for ds in await ov.object_plans(db, object_id)
    ]


@router.get("/objects/{object_id}/plans/{module}")
async def organizer_object_plan(
    object_id: uuid.UUID,
    module: str,
    _org: Organizer,
    revision: int | None = Query(default=None, ge=1),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    """The plan's bytes — current, or the pinned ``revision`` (the same store the field reads)."""
    ds = next((d for d in await ov.object_plans(db, object_id) if d.module == module), None)
    if ds is None or not ds.storage_key:
        raise ov.not_found("Plan nicht gefunden")
    key, ctype, version = ds.storage_key, ds.content_type or "application/pdf", ds.current_version
    if revision is not None and revision != ds.current_version:
        pinned = await db.get(PlanRevision, (ds.id, revision))
        if pinned is None:
            raise ov.not_found("Planversion nicht gefunden")
        key, ctype, version = pinned.storage_key, pinned.content_type or "application/pdf", revision
    if not storage.exists(key):
        raise ov.not_found("Plan nicht gefunden")
    return FileResponse(
        storage.local_path(key),
        media_type=ctype,
        filename=f"{module}-v{version}.pdf",
        content_disposition_type="inline",
        headers={"X-Plan-Revision": str(version), "X-Content-Type-Options": "nosniff"},
    )


@router.delete("/objects/{source}/{external_id:path}")
async def organizer_delete_object(
    source: str, external_id: str, _org: Organizer, db: AsyncSession = Depends(get_db)
) -> dict[str, str]:
    """Remove the organizer's ref: ``{removed: "ref" | "object" | "none"}`` (idempotent)."""
    await programmes.require_unused_ref(db, source, external_id)
    return await ov.delete_integration_object(db, source, external_id)


@router.put("/objects/{source}/{external_id:path}")
async def organizer_put_object(
    source: str,
    external_id: str,
    _org: Organizer,
    body: Annotated[dict[str, Any], Body()],
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Resolve-or-create an object by the organizer's id: ``{objectId, created}``."""
    return await ov.upsert_integration_object(db, source, external_id, body)


@router.put("/visit-lists/{ref:path}")
async def organizer_put_list(
    ref: str, _org: Organizer, body: Annotated[dict[str, Any], Body()], db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    await programmes.require_unmanaged(db, ref)
    return await ov.put_visit_list(db, ref, body)


@router.delete("/visit-lists/{ref:path}")
async def organizer_delete_list(ref: str, _org: Organizer, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    await programmes.require_unmanaged(db, ref)
    return await ov.delete_visit_list(db, ref)

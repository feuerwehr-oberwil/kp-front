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

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, Header, Query
from fastapi.responses import FileResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession

from .. import object_visits as ov
from ..auth.secret_token import SecretGate
from ..credentials import get as credential
from ..credentials import load as load_credentials
from ..database import get_db
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
    return await ov.put_visit_list(db, ref, body)


@router.delete("/visit-lists/{ref:path}")
async def organizer_delete_list(ref: str, _org: Organizer, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    return await ov.delete_visit_list(db, ref)

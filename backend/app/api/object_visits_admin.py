"""Objektbesuche — the admin API, ``/api/admin/object-visits`` (admin session only).

The station's view over every visit and the delivery outbox: what is filed where, what failed
and why, «Erneut versuchen», a connection test for a destination, and a ZIP export for a station
that has no destination at all.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import zipfile
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, Query
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from .. import object_visits as ov
from .. import storage
from ..auth.dependencies import CurrentAdmin
from ..credentials import load as load_credentials
from ..database import get_db
from ..models import ObjectVisit, ObjectVisitDelivery, ObjectVisitRevision

logger = logging.getLogger("kpfront.objectvisits")

router = APIRouter(prefix="/admin/object-visits", tags=["admin-object-visits"])


def _iso(at: datetime | None) -> str | None:
    return at.isoformat() if at else None


@router.get("")
async def admin_list(
    _admin: CurrentAdmin,
    object: str | None = None,
    workRef: str | None = None,  # noqa: N803 — the contract's query parameter name
    lifecycle: str | None = None,
    limit: int = Query(default=200, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    visits = await ov.list_visits(db, object_id=object, work_ref=workRef, lifecycle=lifecycle, limit=limit)
    return [ov.summary(v) for v in visits]


@router.get("/deliveries")
async def admin_deliveries(
    _admin: CurrentAdmin,
    state: str | None = None,
    destination: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    stmt = select(ObjectVisitDelivery, ObjectVisit.doc).join(
        ObjectVisit, ObjectVisit.id == ObjectVisitDelivery.visit_id
    )
    if state:
        stmt = stmt.where(ObjectVisitDelivery.state == state)
    if destination:
        stmt = stmt.where(ObjectVisitDelivery.destination == destination)
    rows = (await db.execute(stmt.order_by(ObjectVisitDelivery.updated_at.desc()).limit(1000))).all()
    return [
        {
            "destination": d.destination,
            "visitId": d.visit_id,
            "objectName": (doc.get("object") or {}).get("name"),
            "wantedRevision": d.wanted_revision,
            "deliveredRevision": d.delivered_revision,
            "state": d.state,
            "attempts": d.attempts,
            "nextAttemptAt": _iso(d.next_attempt_at),
            "lastError": d.last_error,
            "updatedAt": _iso(d.updated_at),
        }
        for d, doc in rows
    ]


@router.post("/deliveries/retry")
async def admin_retry(
    _admin: CurrentAdmin, body: Annotated[dict[str, Any], Body()], db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    """«Erneut versuchen»: ``failed`` → ``pending``, attempts reset. With ``visitId`` it also
    enqueues that visit if the destination does not have it yet."""
    destination = body.get("destination")
    visit_id = body.get("visitId")
    if not isinstance(destination, str) or not destination:
        raise ov.invalid("destination fehlt")
    if visit_id is not None and (not isinstance(visit_id, str) or not ov.ID_RE.match(visit_id)):
        raise ov.invalid("visitId ist ungültig")
    count = await ov.mark_deliveries(db, destination=destination, visit_id=visit_id, now=datetime.now(UTC))
    return {"retried": count}


@router.post("/destinations/{destination_id}/test")
async def admin_test_destination(
    destination_id: str, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    """Upload one small ``_kp-front-test.txt`` into the destination root; Graph's answer back."""
    from ..object_visit_delivery import test_destination
    from ..object_visit_sharepoint import export_credentials

    await load_credentials(db)
    cfg = await ov.ov_config(db)
    dest = next((d for d in cfg.destinations if d.id == destination_id), None)
    if dest is None:
        raise ov.not_found("Ablageziel nicht gefunden")
    if export_credentials() is None:
        return {"ok": False, "status": None, "detail": "Zugangsdaten «SharePoint-Ablage» fehlen"}
    return await test_destination(dest)


@router.get("/export.zip")
async def admin_export(
    _admin: CurrentAdmin,
    object: str | None = None,
    workRef: str | None = None,  # noqa: N803
    lifecycle: str | None = None,
    limit: int = Query(default=500, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    """Visits as JSON + report PDF + photo originals, one folder per visit — the station's own
    copy where no destination is configured."""
    visits = await ov.list_visits(db, object_id=object, work_ref=workRef, lifecycle=lifecycle, limit=limit)
    fd, path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    try:
        # Written entry by entry into a temporary file — one report or one photo in memory at a
        # time, never the whole export. A visit that cannot be exported (a report that will not
        # render, a photo the volume lost) gets a FEHLER.txt and the export goes on.
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            for visit in visits:
                folder = ov_folder_name(visit)
                try:
                    await _export_visit(db, zf, folder, visit)
                except Exception as e:  # noqa: BLE001 — one broken visit must not cost the station its export
                    logger.warning("export: object visit %s skipped (%s)", visit.id, e)
                    await asyncio.to_thread(
                        zf.writestr, f"{folder}/FEHLER.txt", f"Dieser Besuch konnte nicht exportiert werden: {e}\n"
                    )
    except BaseException:
        os.unlink(path)
        raise
    return FileResponse(
        path,
        media_type="application/zip",
        filename=f"objektbesuche-{datetime.now(UTC):%Y%m%d}.zip",
        background=BackgroundTask(os.unlink, path),
    )


async def _export_visit(db: AsyncSession, zf: zipfile.ZipFile, folder: str, visit: ObjectVisit) -> None:
    payload = json.dumps(await ov.serialize_visit(db, visit), ensure_ascii=False, indent=2).encode()
    await asyncio.to_thread(zf.writestr, f"{folder}/Objektbesuch.json", payload)
    pdf = await ov.render_report(db, visit)
    await asyncio.to_thread(zf.writestr, f"{folder}/Objektbesuch.pdf", pdf)
    del pdf
    stored = await ov.stored_attachments(db, visit.id)
    for n, photo in enumerate(visit.doc.get("photos") or [], start=1):
        if not isinstance(photo, dict) or not isinstance(photo.get("id"), str) or photo["id"] not in stored:
            continue
        att = stored[photo["id"]]
        ext = ov.PHOTO_TYPES.get(att.content_type, ".jpg")
        caption = ov_safe(photo.get("caption") or "Foto")[:60]
        name = f"{folder}/Fotos/{n:02d} {caption} ({photo['id'][-4:]}){ext}"
        await asyncio.to_thread(zf.write, storage.local_path(att.storage_key), name)
    revisions = (
        (await db.execute(select(ObjectVisitRevision.revision).where(ObjectVisitRevision.visit_id == visit.id)))
        .scalars()
        .all()
    )
    await asyncio.to_thread(zf.writestr, f"{folder}/revisionen.json", json.dumps(sorted(revisions)))


def ov_safe(text: str) -> str:
    from ..object_visit_sharepoint import sanitize_segment

    return sanitize_segment(text)


def ov_folder_name(visit: ObjectVisit) -> str:
    obj = visit.doc.get("object") or {}
    date = (visit.doc.get("visitedAt") or "")[:10] or "ohne-datum"
    return ov_safe(f"{date} {obj.get('name') or 'Objekt'} ({visit.id[-4:]})")

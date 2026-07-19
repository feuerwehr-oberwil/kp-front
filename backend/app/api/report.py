"""Einsatzrapport PDF endpoint.

The client POSTs a JSON `payload` (Form field) with the rapport DATA — including the Kroki
scene and plan references; the server renders the map itself (app/kroki.py, raster tiles +
the shared symbol pack) and the plan pages (pdfium), and loads journal photos straight from
its own media store. Legacy clients may still upload captured figure PNGs (one-release
compat window). Any authenticated user may generate a report (read-only output), so this
uses CurrentUser, not CurrentEditor.
"""

import re
import uuid

import anyio
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import storage
from ..auth.dependencies import CurrentUser
from ..database import get_db
from ..models import Incident, Media, ReferenceDataset
from ..report_pdf import ReportPayload, compose_report_pdf

router = APIRouter(tags=["report"])

_MAX_FIGURES = 40
_MAX_FIGURE_BYTES = 12 * 1024 * 1024  # 12 MB per captured page — generous for a full-res map PNG
_ALLOWED_FIGURE_TYPES = {"image/png", "image/jpeg", "image/webp"}

_MEDIA_URL = re.compile(r"^/api/media/([0-9a-fA-F-]{36})$")
_REFERENCE_URL = re.compile(r"^/api/reference/([^/?#]+)$")


async def resolve_report_assets(db: AsyncSession, data: ReportPayload,
                                figs: dict[str, bytes]) -> dict[str, bytes]:
    """Load the server-owned assets the composer needs: journal photos from the media
    store (keyed `photo:<url>` into `figs`) and plan PDFs from the reference store
    (returned as url→bytes). Missing/foreign assets are skipped — the rapport ships
    without that picture rather than failing."""
    for row in data.journal:
        if not row.photoUrl or f"photo:{row.photoUrl}" in figs:
            continue
        m = _MEDIA_URL.match(row.photoUrl)
        if not m:
            continue
        media = (await db.execute(select(Media).where(Media.id == uuid.UUID(m.group(1))))).scalar_one_or_none()
        if media is None or not media.storage_key:
            continue
        try:
            with open(storage.local_path(media.storage_key), "rb") as fh:
                figs[f"photo:{row.photoUrl}"] = fh.read()
        except OSError:
            continue

    plan_pdfs: dict[str, bytes] = {}
    for pp in data.planPages:
        if not pp.url:
            continue
        m = _REFERENCE_URL.match(pp.url)
        if not m:
            continue
        ds = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == m.group(1)))).scalar_one_or_none()
        if ds is None or not ds.storage_key or ds.kind != "pdf":
            continue
        try:
            with open(storage.local_path(ds.storage_key), "rb") as fh:
                plan_pdfs[pp.url] = fh.read()
        except OSError:
            continue
    return plan_pdfs


async def compose_report_from_payload(db: AsyncSession, payload: str,
                                      figs: dict[str, bytes] | None = None) -> tuple[bytes, ReportPayload]:
    """Validate the JSON `payload` and compose the Rapport-PDF — the one path shared by
    the download endpoints (editor + capture) and the print-relay enqueue endpoints."""
    try:
        data = ReportPayload.model_validate_json(payload)
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=f"Ungültige Rapport-Daten: {e.errors(include_url=False)[:5]}") from e
    figs = figs if figs is not None else {}
    plan_pdfs = await resolve_report_assets(db, data, figs)
    try:
        # composition does real work now (tile fetch + rasterising) — off the event loop
        pdf = await anyio.to_thread.run_sync(compose_report_pdf, data, figs, plan_pdfs)
    except Exception as e:  # composition is best-effort — never 500 silently
        raise HTTPException(status_code=500, detail="Rapport-PDF konnte nicht erstellt werden.") from e
    return pdf, data


def report_filename(title: str) -> str:
    safe = "".join(c for c in title if c.isalnum() or c in " -_").strip().replace(" ", "_")[:60] or "Einsatzrapport"
    return f"Einsatzrapport_{safe}.pdf"


@router.post("/incidents/{incident_id}/report/pdf")
async def report_pdf(
    incident_id: uuid.UUID,
    _user: CurrentUser,
    payload: str = Form(...),
    figures: list[UploadFile] = File(default=[]),
    db: AsyncSession = Depends(get_db),
) -> Response:
    inc = (await db.execute(select(Incident).where(Incident.id == incident_id))).scalar_one_or_none()
    if inc is None:
        raise HTTPException(status_code=404, detail="Einsatz nicht gefunden")

    # Legacy figures are keyed by the multipart filename (krokiKey / plan.key / photoKey).
    figs: dict[str, bytes] = {}
    for f in figures[:_MAX_FIGURES]:
        if not f.filename or (f.content_type or "") not in _ALLOWED_FIGURE_TYPES:
            continue
        blob = await f.read()
        if 0 < len(blob) <= _MAX_FIGURE_BYTES:
            figs[f.filename] = blob

    pdf, _ = await compose_report_from_payload(db, payload, figs)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{report_filename(inc.title)}"'},
    )

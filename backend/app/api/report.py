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
from urllib.parse import unquote

import anyio
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import storage
from ..auth.dependencies import CurrentUser
from ..database import get_db
from ..models import DeploymentConfig as DeploymentConfigRow
from ..models import DiveraEmergency, Media, ReferenceDataset
from ..report_pdf import ReportPayload, compose_report_pdf
from ..schichtplan_pdf import compose_schichtplan_pdf
from ..zeitplan_pdf import ZeitplanPayload, compose_zeitplan_pdf
from .incidents import get_incident_or_404

router = APIRouter(tags=["report"])

_MAX_FIGURES = 40
_MAX_FIGURE_BYTES = 12 * 1024 * 1024  # 12 MB per captured page — generous for a full-res map PNG
_ALLOWED_FIGURE_TYPES = {"image/png", "image/jpeg", "image/webp"}

_MEDIA_URL = re.compile(r"^/api/media/([0-9a-fA-F-]{36})$")
#: ⚠️ The query string is OPTIONAL, and ignored. Plan URLs carry the dataset's version
#: (`?v=3`) so that re-uploading a Modul-PDF produces a NEW url and every cache — the service
#: worker's, pdf.js' document cache, the rendered-bitmap cache — misses instead of serving the
#: sheet somebody replaced. Anchored without it, this pattern matched none of those urls and
#: the plan page dropped out of the printed rapport in silence, exactly like the logo below.
_REFERENCE_URL = re.compile(r"^/api/reference/([^/?#]+)(?:\?[^#]*)?$")
#: ⚠️ `.+`, not `[^/]+`: the storage key IS a path («branding/<uuid>.png»), which is why the
#: route itself declares `{key:path}`. A slash-free pattern here matched nothing, so the logo
#: was skipped in silence — stored, served, configured, and absent from the sheet.
_BRANDING_URL = re.compile(r"^/api/branding/file/(.+)$")

#: The station's logo on the printed rapport, under the composer's `logo` figure key. Resolved
#: HERE rather than uploaded by the client: the deployment config is the server's own record of
#: which brigade this is, and a client-supplied logo would let a poster token print any picture
#: it liked at the top of a document that gets signed.
_LOGO_KEY = "logo"


async def _resolve_logo(db: AsyncSession, figs: dict[str, bytes]) -> None:
    row = (await db.execute(select(DeploymentConfigRow))).scalars().first()
    assets = ((row.config_json if row else None) or {}).get("identity", {}).get("assets", {})
    # the rapport's own letterhead wins; the app brandmark is the fallback, so a station that
    # only ever uploaded one logo still gets a sensible sheet
    url = assets.get("reportLogo") or assets.get("logo")
    if not isinstance(url, str):
        return
    m = _BRANDING_URL.match(url)
    if not m:
        return
    key = m.group(1)
    # same guard the public route applies — this key comes from our own config, but a resolver
    # that reads whatever a path says is one config edit away from being an arbitrary-file read
    if not key.startswith("branding/") or ".." in key:
        return
    try:
        figs[_LOGO_KEY] = await storage.aget_bytes(key)
    except OSError:
        return  # the rapport prints without it — a missing logo is never worth failing over


async def _resolve_logo_bytes(db: AsyncSession) -> bytes | None:
    """The same resolution `_resolve_logo` does for the rapport's figs dict, for the
    Schichtplan/Verfügbarkeiten composers — they take the logo as a plain argument rather than
    through the figs-dict convention the rapport's asset pipeline uses (they have no other
    server-resolved assets to share that dict with)."""
    figs: dict[str, bytes] = {}
    await _resolve_logo(db, figs)
    return figs.get(_LOGO_KEY)


async def resolve_report_assets(db: AsyncSession, data: ReportPayload, figs: dict[str, bytes]) -> dict[str, bytes]:
    """Load the server-owned assets the composer needs: journal photos from the media
    store (keyed `photo:<url>` into `figs`) and plan PDFs from the reference store
    (returned as url→bytes). Missing/foreign assets are skipped — the rapport ships
    without that picture rather than failing."""
    await _resolve_logo(db, figs)

    for row in data.journal:
        # a row may carry several pictures; the legacy single `photoUrl` is just the one-element case
        for url in row.photoUrls or ([row.photoUrl] if row.photoUrl else []):
            if f"photo:{url}" in figs:
                continue
            m = _MEDIA_URL.match(url)
            if not m:
                continue
            media = (await db.execute(select(Media).where(Media.id == uuid.UUID(m.group(1))))).scalar_one_or_none()
            if media is None or not media.storage_key:
                continue
            try:
                figs[f"photo:{url}"] = await storage.aget_bytes(media.storage_key)
            except OSError:
                continue

    # Beilagen resolve exactly like a journal photo — same media store, same `photo:<url>` key,
    # so the composer needs one lookup path and a missing file drops that plate rather than the
    # whole rapport.
    for att in data.attachments:
        if not att.url or f"photo:{att.url}" in figs:
            continue
        m = _MEDIA_URL.match(att.url)
        if not m:
            continue
        media = (await db.execute(select(Media).where(Media.id == uuid.UUID(m.group(1))))).scalar_one_or_none()
        if media is None or not media.storage_key:
            continue
        try:
            figs[f"photo:{att.url}"] = await storage.aget_bytes(media.storage_key)
        except OSError:
            continue

    plan_pdfs: dict[str, bytes] = {}
    for pp in data.planPages:
        if not pp.url:
            continue
        m = _REFERENCE_URL.match(pp.url)
        if not m:
            continue
        # ⚠️ unquote: the client percent-encodes the dataset id (referenceUrl uses
        # encodeURIComponent), and every real plan id carries colons («plan:<obj>:<module>»)
        # — so the raw match is `plan%3A…` and the DB lookup found nothing. The serving route
        # never noticed because FastAPI decodes its path params; this resolver reads the raw
        # URL string, so it has to decode itself or every annotated Objektplan page drops out
        # of the printed rapport in silence.
        ds_id = unquote(m.group(1))
        ds = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == ds_id))).scalar_one_or_none()
        if ds is None or not ds.storage_key or ds.kind != "pdf":
            continue
        try:
            plan_pdfs[pp.url] = await storage.aget_bytes(ds.storage_key)
        except OSError:
            continue
    return plan_pdfs


async def _alarm_ref(db: AsyncSession, incident_id: str) -> str | None:
    """The alerting system's own reference for this incident's alarm — the number WinFAP and
    the cantonal statistics join on, and the same one ``api.stats`` exports as ``alarm_ref``.

    Resolved HERE rather than sent by the client: the pool row is the authority, and a rapport
    printed from a stale tab must not put a different number on paper from the one the exporter
    sends. Earliest arrival wins, exactly as ``stats._alarm_refs`` does it — an incident can
    absorb a second pool alarm (split dispatch), and the first alarm is the one whose slip was
    printed. Best-effort: a rapport never fails to compose over a missing reference.
    """
    try:
        iid = uuid.UUID(incident_id)
    except (ValueError, AttributeError):
        return None
    return (
        await db.execute(
            select(DiveraEmergency.divera_number)
            .where(DiveraEmergency.taken_incident_id == iid)
            .where(DiveraEmergency.divera_number.is_not(None))
            .order_by(DiveraEmergency.received_at.asc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def compose_report_from_payload(
    db: AsyncSession, payload: str, figs: dict[str, bytes] | None = None
) -> tuple[bytes, ReportPayload]:
    """Validate the JSON `payload` and compose the Rapport-PDF — the one path shared by
    the download endpoints (editor + capture) and the print-relay enqueue endpoints."""
    try:
        data = ReportPayload.model_validate_json(payload)
    except ValidationError as e:
        raise HTTPException(
            status_code=422, detail=f"Ungültige Rapport-Daten: {e.errors(include_url=False)[:5]}"
        ) from e
    figs = figs if figs is not None else {}
    data.incident.alarmRef = await _alarm_ref(db, data.incident.id)
    plan_pdfs = await resolve_report_assets(db, data, figs)
    try:
        # composition does real work now (tile fetch + rasterising) — off the event loop
        pdf = await anyio.to_thread.run_sync(compose_report_pdf, data, figs, plan_pdfs)
    except Exception as e:  # composition is best-effort — never 500 silently
        raise HTTPException(status_code=500, detail="Rapport-PDF konnte nicht erstellt werden.") from e
    return pdf, data


async def warm_report_from_payload(payload: str) -> None:
    """Best-effort tile-cache prewarm (fired when the rapport modal opens). Validates the
    payload and warms the Kroki base tiles off the event loop so a later compose skips the
    slow network round-trips. Swallows everything — a warm miss just means the real render
    pays the cost, exactly as before."""
    try:
        data = ReportPayload.model_validate_json(payload)
    except ValidationError:
        return
    from ..report_pdf import warm_report_tiles

    await anyio.to_thread.run_sync(warm_report_tiles, data)


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
    inc = await get_incident_or_404(db, incident_id)

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


def zeitplan_filename(title: str, sheet: str = "verfuegbarkeiten") -> str:
    """Named after the SHEET, not after the endpoint. The two must differ: they answer different
    questions, and two downloads landing on one name means the second silently replaces the first
    in a Downloads folder somebody is about to print from."""
    safe = "".join(c for c in title if c.isalnum() or c in " -_").strip().replace(" ", "_")[:60] or "Einsatz"
    stem = "Schichtplan" if sheet == "schichtplan" else "Verfuegbarkeiten"
    return f"{stem}_{safe}.pdf"


def compose_zeitplan_from_payload(payload: str, logo: bytes | None = None) -> tuple[bytes, ZeitplanPayload]:
    """Parse + render one of the two Schichtenplanung sheets. Its own path: no map tiles, no plan
    PDFs, no media — either sheet is names and times, so neither needs the rapport's full asset
    resolution. The one server-resolved asset both DO want, for the same reason the rapport does
    (a Führungsformular that leaves the building should say whose it is), is the station logo —
    resolved by the caller (`_resolve_logo_bytes`) and handed in here, never re-resolved per sheet.

    The two composers are separate modules and neither carries a switch: they are different
    questions with different shapes (Wer × Zeit over continuous time vs Wer × Schicht over discrete
    time). All that is shared is the wire payload, so the surface can ask which sheet it wants.
    """
    try:
        data = ZeitplanPayload.model_validate_json(payload)
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=e.errors(include_url=False)) from e
    compose = compose_schichtplan_pdf if data.sheet == "schichtplan" else compose_zeitplan_pdf
    return compose(data, logo), data


@router.post("/incidents/{incident_id}/zeitplan/pdf")
async def zeitplan_pdf(
    incident_id: uuid.UUID,
    _user: CurrentUser,
    payload: str = Form(...),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """The Schichtenplanung as the printable «Zeitplan» Führungsformular (A4 quer).

    Read-only output like the rapport, so CurrentUser rather than CurrentEditor: a viewer
    coming to relieve the shift may print the sheet they are walking into.
    """
    inc = await get_incident_or_404(db, incident_id)
    logo = await _resolve_logo_bytes(db)
    pdf, data = await anyio.to_thread.run_sync(compose_zeitplan_from_payload, payload, logo)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{zeitplan_filename(inc.title, data.sheet)}"'},
    )

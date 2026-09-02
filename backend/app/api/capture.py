"""Station capture surface (`/api/capture/*`) — the Erfassungs-Poster's backend.

The laminated poster in the Magazin carries one long-lived, admin-rotatable secret. Whoever
scans it can record attendance, material, and notes without a login — the trust model is
possession of the poster inside the fire station, the same as the clipboard it replaces.
Reachable incidents (decided 2026-07-11): everything not yet archived and without a
completed Rapport — the backlog the station still owes paperwork for — plus anything opened
within `alarms.captureWindowHours` (default 12) regardless of report state. Deliberately
narrow: list those incidents, read roster, read/save the ATTENDANCE PART of the workspace,
append journal rows, and upload a Rapport-Beilage (photo). No create/delete/meta/admin, nothing
when no secret is set (fail-closed).

The workspace endpoints are key-scoped (`CAPTURE_WORKSPACE_KEYS`). They used to hand out and
overwrite the whole `map_workspace_json` blob, which meant a poster token could read and
rewrite the tactical map — while ALARM-INTEGRATIONS.md promised "attendance/material/
journal/Einsatzende – no map, no admin, no history". The token goes to people outside the
command post, so the narrow reading is the right one and the code now matches the promise:
reads are projected down to the capture keys, and writes are merged over the server's copy
so a capture save cannot drop or alter anything it cannot see.
"""

import mimetypes
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Request, UploadFile, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import personnel as personnel_svc
from .. import storage
from ..alarms import get_alarms_config
from ..api.media import _ALLOWED_PHOTO, MAX_UPLOAD_BYTES
from ..api.media import _CHUNK as _MEDIA_CHUNK
from ..auth.capture_limiter import capture_limiter
from ..auth.dependencies import CurrentAdmin
from ..auth.secret_token import SecretGate
from ..database import get_db
from ..deployment_config import config_row
from ..models import DeploymentConfig, Incident, Media, Personnel
from ..schemas import (
    IncidentMeta,
    JournalAppendIn,
    JournalEntryOut,
    JournalPage,
    PersonnelOut,
    WorkspaceOut,
    WorkspacePut,
)

# The only workspace keys the Erfassungs-Poster may see or change. Everything else in the
# blob — entities, drawings, board, building, planScale, timeline, trupps, shifts, bands,
# cameraViews, checklists, layerState, settings — is the tactical picture and stays with the
# logged-in editors.
#
# Derived from what src/capture/CaptureApp.tsx actually touches: it reads ws.attendance,
# ws.mittel and ws.reportMeta and nothing else, and its save actions (cycleAttendance,
# restoreAttendance, setTimes, setAttendanceNote, setMittel, setMeta) write only those three.
# If the capture UI ever needs another key, widening this set is a deliberate decision with a
# doc change attached — which is exactly the review step that was missing before.
#
# Widened 2026-08-06 by `attachments` (Rapport-Beilagen): the poster is where the paperwork is
# done, and a photographed Ausweis or a damage close-up belongs to the same rapport the poster
# already fills in. It is REPORT material, not the tactical picture — no map, no history — so it
# is the same class of thing as attendance and Mittel. The photo bytes go through the capture
# media route below, which is as narrow as this list (photo only, one incident, rate-limited).
CAPTURE_WORKSPACE_KEYS = frozenset({"attendance", "mittel", "reportMeta", "attachments"})


def _capture_view(workspace: dict | None) -> dict | None:
    """Project a stored workspace down to the keys the poster is allowed to see.

    ``None`` stays ``None``: "this incident has no workspace yet" and "it has one, but
    nothing in it concerns you" are different answers, and the form already distinguishes
    them.
    """
    if workspace is None:
        return None
    return {k: v for k, v in workspace.items() if k in CAPTURE_WORKSPACE_KEYS}


def _merge_capture_keys(stored: dict | None, submitted: dict | None) -> dict:
    """Server's workspace with only the capture keys replaced by the client's.

    Merging rather than overwriting is what makes the read restriction hold up: the poster
    never receives the map, so it could not send it back even in good faith, and a naive
    write of what it holds would erase it.
    """
    merged = dict(stored or {})
    for key in CAPTURE_WORKSPACE_KEYS:
        # A key absent from the payload means "no change", not "delete" — the poster form
        # only ever sends back the sections it loaded.
        if submitted and key in submitted:
            merged[key] = submitted[key]
    return merged


def _client_ip(request: Request) -> str:
    # Behind the platform proxy (Railway) the real client arrives in X-Forwarded-For and
    # the direct peer is the proxy; first hop wins. Direct connections fall back to the peer.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def _rate_limit(request: Request) -> None:
    """Per-IP token bucket over the whole capture surface (see capture_limiter for sizing:
    a fast legit operator never trips it, only scripted abuse of the poster token does)."""
    wait = capture_limiter.check(_client_ip(request))
    if wait:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Zu viele Anfragen — bitte kurz warten.",
            headers={"Retry-After": str(wait)},
        )


router = APIRouter(prefix="/capture", tags=["capture"], dependencies=[Depends(_rate_limit)])


# --- admin: the poster secret ---------------------------------------------------------
# Gated by the deployment admin (ADMIN_SECRET session), NOT the editor role: whoever can
# print the poster grants station-wide capture access, which is deployment administration.


@router.get("/secret")
async def get_capture_secret(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    row = await config_row(db)
    return {"configured": bool(row.capture_secret), "token": row.capture_secret}


@router.post("/secret/rotate")
async def rotate_capture_secret(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    """Mint a fresh poster secret — every previously printed poster stops working at once."""
    row = await config_row(db)
    row.capture_secret = secrets.token_urlsafe(18)
    await db.flush()
    return {"configured": True, "token": row.capture_secret}


@router.delete("/secret")
async def disable_capture(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    row = await config_row(db)
    row.capture_secret = None
    await db.flush()
    return {"configured": False}


# --- station capture (poster token) ----------------------------------------------------


#: ``?t=`` as well as the header: the poster is a QR code, and what it encodes is a URL.
#: Fail-closed — no poster secret configured means the whole capture surface is off.
_POSTER = SecretGate(
    query_param="t",
    disabled_detail="Erfassung deaktiviert (kein Erfassungs-Token gesetzt)",
    invalid_detail="Ungültiger Erfassungs-Token",
)


async def _check_token(
    request: Request,
    x_capture_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> None:
    """The poster gate, as a dependency — every route below carries it.

    Reads the row without creating one: a deployment that never minted a poster secret answers
    403 and must not gain a config row from being probed.
    """
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    _POSTER.check_request(row.capture_secret if row else None, request, x_capture_token)


async def _capture_incidents(db: AsyncSession) -> list[Incident]:
    """Reachable incidents, newest first: unarchived without a completed Rapport (any age —
    the open backlog), plus anything inside the capture window regardless of report state.
    Rapport + Archiv is what makes an incident disappear from the poster."""
    cfg = await get_alarms_config(db)
    cutoff = datetime.now(UTC) - timedelta(hours=cfg.captureWindowHours)
    rows = (
        await db.execute(
            select(Incident)
            .where(
                Incident.is_archived.is_(False),
                or_(Incident.report_done_at.is_(None), Incident.started_at >= cutoff),
            )
            .order_by(Incident.started_at.desc())
        )
    ).scalars()
    return list(rows)


async def _get_in_window(db: AsyncSession, incident_id: uuid.UUID) -> Incident:
    for inc in await _capture_incidents(db):
        if inc.id == incident_id:
            return inc
    # Rapportiert+out-of-window, archived, or unknown — one answer for all three (no probing).
    raise HTTPException(status_code=404, detail="Einsatz nicht (mehr) erfassbar")


async def _reachable_incident(
    incident_id: uuid.UUID,
    _token: None = Depends(_check_token),
    db: AsyncSession = Depends(get_db),
) -> Incident:
    """The incident this path names, if the poster may reach it at all — the second half of
    the gate, for every route that addresses one.

    ⚠️ Order is part of the answer: the token is checked FIRST (it is a sub-dependency, so
    FastAPI solves it before this runs), which is why a wrong token on an unknown incident is
    still a 401 and never a 404 that would confirm what does not exist.
    """
    return await _get_in_window(db, incident_id)


@router.get("/incidents", response_model=list[IncidentMeta], dependencies=[Depends(_check_token)])
async def list_capture_incidents(db: AsyncSession = Depends(get_db)) -> list[Incident]:
    return await _capture_incidents(db)


@router.get("/roster", response_model=list[PersonnelOut], dependencies=[Depends(_check_token)])
async def capture_roster(db: AsyncSession = Depends(get_db)):
    """Active Mannschaft for the attendance checklist and the Einsatzleiter/Rückmeldung pickers."""
    rows = list((await db.execute(select(Personnel).where(Personnel.is_active.is_(True)))).scalars())
    # Same names, same order, same sort as the KP tablet's roster — the two lists are read
    # side by side (phone ticks off, tablet checks) and must not disagree on either.
    order = await personnel_svc.load_roster_name_order(db)
    out = []
    for p in rows:
        served = PersonnelOut.model_validate(p)
        served.display_name = personnel_svc.person_display_name(p, order)
        out.append(served)
    out.sort(key=lambda person: personnel_svc.name_sort_key(person.display_name))
    return out


async def _bump_capture_usage(db: AsyncSession, incident_id: uuid.UUID) -> None:
    """Count one successful capture write (workspace PUT / journal append) — the KP tablet
    surfaces it as «QR: N Einträge · zuletzt HH:MM», so operators know the QR self-reporting
    is in use and nobody needs paper sheets. updated_at is pinned to itself: the write that
    changed content already bumped it; the counter alone is bookkeeping."""
    from sqlalchemy import func, update

    await db.execute(
        update(Incident)
        .where(Incident.id == incident_id)
        .values(
            capture_writes=Incident.capture_writes + 1,
            capture_last_at=func.now(),
            updated_at=Incident.updated_at,
        )
    )


@router.get("/incidents/{incident_id}/status")
async def capture_incident_status(inc: Incident = Depends(_reachable_incident)) -> dict:
    """Tiny cross-visibility poll for the open capture form: has the KP tablet opened this
    incident (the editor_opened_at latch)? The form polls ~45 s ONLY while false — once
    true it stays true (latched), so the common case costs zero polls after the initial
    list load (which already carries editor_opened_at)."""
    return {"kp_active": inc.editor_opened_at is not None}


@router.get("/incidents/{incident_id}/workspace", response_model=WorkspaceOut)
async def capture_get_workspace(inc: Incident = Depends(_reachable_incident)) -> WorkspaceOut:
    # Projected, not the whole blob — the tactical map is not the poster's business.
    return WorkspaceOut(workspace=_capture_view(inc.map_workspace_json), workspace_rev=inc.workspace_rev)


@router.put("/incidents/{incident_id}/workspace", response_model=WorkspaceOut)
async def capture_put_workspace(
    incident_id: uuid.UUID,
    body: WorkspacePut,
    inc: Incident = Depends(_reachable_incident),
    db: AsyncSession = Depends(get_db),
) -> WorkspaceOut:
    """Same optimistic-concurrency save as the editor endpoint (shared helper), so capture
    edits merge with a live KP tablet exactly like a second editor would — but only across
    CAPTURE_WORKSPACE_KEYS. Everything else is carried over from the server's own copy.

    The read-then-conditional-update is not a race: apply_workspace_put bumps the rev only if
    it still equals base_rev, so a tablet that saved in between makes this a 409 rather than
    a silent overwrite of the map with a stale snapshot.
    """
    from .incidents import apply_workspace_put

    scoped = WorkspacePut(
        workspace=_merge_capture_keys(inc.map_workspace_json, body.workspace),
        base_rev=body.base_rev,
    )
    saved = await apply_workspace_put(db, incident_id, scoped, user_id=None, source="capture")
    await _bump_capture_usage(db, incident_id)  # only after an ACCEPTED save (409 raises above)
    # Hand back the projection, not the merged blob the editor endpoint would return.
    return WorkspaceOut(workspace=_capture_view(saved.workspace), workspace_rev=saved.workspace_rev)


@router.get("/incidents/{incident_id}/verify")
async def capture_verify_chain(
    incident_id: uuid.UUID,
    _inc: Incident = Depends(_reachable_incident),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Read-only audit-chain check for the capture Rapport-PDF — same output as the
    editor endpoint, so the QR-generated PDF shows a real Prüfnachweis."""
    from .. import audit

    return await audit.verify_chain(db, incident_id)


@router.post("/incidents/{incident_id}/report/pdf")
async def capture_report_pdf(
    payload: str = Form(...),
    _inc: Incident = Depends(_reachable_incident),
    db: AsyncSession = Depends(get_db),
):
    """Data-only Rapport-PDF for the capture view (no kiosk cookie there — poster token
    auth). Same composer as the editor endpoint; journal photos resolve from the media
    store server-side (the poster token never carried the media cookie, so the old
    client-side photo fetch silently dropped them). Read-only output."""
    from fastapi.responses import Response

    from .report import compose_report_from_payload

    pdf, _ = await compose_report_from_payload(db, payload)
    return Response(content=pdf, media_type="application/pdf")


# --- station print relay (poster token; twins of the /api/print* editor routes) --------


@router.get("/print/status", dependencies=[Depends(_check_token)])
async def capture_print_status() -> dict:
    from .print_relay import print_status

    return print_status()


@router.post("/incidents/{incident_id}/report/print")
async def capture_report_print(
    payload: str = Form(...),
    inc: Incident = Depends(_reachable_incident),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Queue the data-only Rapport-PDF on the station printer — the phone needs no
    printer setup, possession of the poster token is the authority (same as the PDF)."""
    from .print_relay import enqueue_print_job

    job = await enqueue_print_job(db, inc, payload, kind="capture_report", requested_by=None)
    return {"job_id": str(job.id), "status": job.status}


@router.get("/print-jobs/{job_id}", dependencies=[Depends(_check_token)])
async def capture_print_job(job_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    """Poll a just-queued job's lifecycle (queued → printing → done/failed) for the live
    toast. Token holders may only read jobs of incidents still reachable through the poster."""
    from ..models import PrintJob
    from .print_relay import job_view

    job = (await db.execute(select(PrintJob).where(PrintJob.id == job_id))).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Druckauftrag nicht gefunden")
    await _get_in_window(db, job.incident_id)
    return job_view(job)


@router.delete("/print-jobs/{job_id}", dependencies=[Depends(_check_token)])
async def capture_print_cancel(job_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    """Rückgängig for a just-queued job. Token holders may only touch jobs of incidents
    still reachable through the poster (and never already-claimed ones)."""
    from ..models import PrintJob
    from .print_relay import cancel_print_job

    job = (await db.execute(select(PrintJob).where(PrintJob.id == job_id))).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Druckauftrag nicht gefunden")
    await _get_in_window(db, job.incident_id)
    return await cancel_print_job(db, job_id)


@router.post("/incidents/{incident_id}/media", status_code=201)
async def capture_upload_media(
    incident_id: uuid.UUID,
    file: UploadFile = File(...),
    _inc: Incident = Depends(_reachable_incident),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Upload one Rapport-Beilage (photo) from the poster.

    PHOTOS ONLY, and only for an incident this token may reach — the poster records paperwork,
    and a Beilage is paperwork. Everything else about the upload is the editor route's rules
    (`api/media`): the same content-type allowlist, the same size cap, the same storage. No
    `kind` parameter, because there is exactly one kind the poster may add: audio would be a
    recording of people, which is not what the clipboard by the door is for.

    The returned URL is what the caller writes into `attachments` on the workspace.
    """
    content_type = file.content_type or "application/octet-stream"
    if content_type not in _ALLOWED_PHOTO:
        raise HTTPException(
            status_code=415,
            detail=f"Dateityp {content_type!r} nicht erlaubt (erwartet: {', '.join(sorted(_ALLOWED_PHOTO))})",
        )
    ext = mimetypes.guess_extension(content_type) or ".jpg"
    key = storage.new_key(f"media/{incident_id}", ext)

    async def _chunks():
        chunk = await file.read(_MEDIA_CHUNK)
        while chunk:
            yield chunk
            chunk = await file.read(_MEDIA_CHUNK)

    try:
        await storage.put_astream(key, _chunks(), max_bytes=MAX_UPLOAD_BYTES)
    except storage.TooLargeError:
        raise HTTPException(
            status_code=413,
            detail=f"Datei zu gross (Maximum {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
        ) from None
    storage.created_in_transaction(db, key)

    # created_by stays NULL: a poster upload has no user behind it, and inventing one would put
    # a name on the record that nobody typed.
    media = Media(incident_id=incident_id, kind="photo", storage_key=key, content_type=content_type)
    db.add(media)
    await db.flush()
    return {"id": str(media.id), "url": f"/api/media/{media.id}", "kind": "photo"}


@router.get("/incidents/{incident_id}/journal", response_model=JournalPage)
async def capture_read_journal(
    incident_id: uuid.UUID,
    _inc: Incident = Depends(_reachable_incident),
    db: AsyncSession = Depends(get_db),
) -> JournalPage:
    """Read-only Verlauf for the capture view's data-only Rapport-PDF."""
    from sqlalchemy import select as sa_select

    from ..models import JournalEntry

    rows = (
        await db.execute(
            sa_select(JournalEntry).where(JournalEntry.incident_id == incident_id).order_by(JournalEntry.seq.asc())
        )
    ).scalars()
    entries = [JournalEntryOut(seq=r.seq, row=r.row_json) for r in rows]
    return JournalPage(entries=entries, latest_seq=entries[-1].seq if entries else 0)


@router.post("/incidents/{incident_id}/journal", response_model=JournalPage, status_code=201)
async def capture_append_journal(
    incident_id: uuid.UUID,
    body: JournalAppendIn,
    _inc: Incident = Depends(_reachable_incident),
    db: AsyncSession = Depends(get_db),
) -> JournalPage:
    from sqlalchemy import func as sa_func

    from ..models import JournalEntry
    from .journal import MAX_BATCH, append_rows

    if len(body.entries) > MAX_BATCH:
        raise HTTPException(status_code=422, detail=f"Batch zu gross (max. {MAX_BATCH})")
    accepted = await append_rows(db, incident_id, body.entries)
    if accepted:
        # journal rows from the capture surface count as QR usage too (idempotent replays
        # that appended nothing don't — the counter mirrors real record growth)
        await _bump_capture_usage(db, incident_id)
        latest = accepted[-1].seq
    else:
        latest = (
            await db.execute(select(sa_func.max(JournalEntry.seq)).where(JournalEntry.incident_id == incident_id))
        ).scalar_one() or 0
    return JournalPage(entries=accepted, latest_seq=latest)

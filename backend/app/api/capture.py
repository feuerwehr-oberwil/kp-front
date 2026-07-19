"""Station capture surface (`/api/capture/*`) — the Erfassungs-Poster's backend.

The laminated poster in the Magazin carries one long-lived, admin-rotatable secret. Whoever
scans it can record attendance, material, and notes without a login — the trust model is
possession of the poster inside the fire station, the same as the clipboard it replaces.
Reachable incidents (decided 2026-07-11): everything not yet archived and without a
completed Rapport — the backlog the station still owes paperwork for — plus anything opened
within `alarms.captureWindowHours` (default 12) regardless of report state. Deliberately
narrow: list those incidents, read roster, read/save the workspace, append journal rows.
No create/delete/meta/admin, nothing when no secret is set (fail-closed).
"""

import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Form, Header, HTTPException, Request, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..alarms import get_alarms_config
from ..auth.capture_limiter import capture_limiter
from ..auth.dependencies import CurrentAdmin
from ..database import get_db
from ..models import DeploymentConfig, Incident, Personnel
from ..schemas import IncidentMeta, JournalAppendIn, JournalPage, PersonnelOut, WorkspaceOut, WorkspacePut


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


async def _config_row(db: AsyncSession) -> DeploymentConfig:
    row = (
        await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db.add(row)
        await db.flush()
    return row


@router.get("/secret")
async def get_capture_secret(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    row = await _config_row(db)
    return {"configured": bool(row.capture_secret), "token": row.capture_secret}


@router.post("/secret/rotate")
async def rotate_capture_secret(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    """Mint a fresh poster secret — every previously printed poster stops working at once."""
    row = await _config_row(db)
    row.capture_secret = secrets.token_urlsafe(18)
    await db.flush()
    return {"configured": True, "token": row.capture_secret}


@router.delete("/secret")
async def disable_capture(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    row = await _config_row(db)
    row.capture_secret = None
    await db.flush()
    return {"configured": False}


# --- station capture (poster token) ----------------------------------------------------


async def _check_token(db: AsyncSession, request: Request, header_token: str | None) -> None:
    row = (
        await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()
    expected = row.capture_secret if row else None
    if not expected:
        # Fail CLOSED: no poster secret configured → the whole capture surface is off.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Erfassung deaktiviert (kein Erfassungs-Token gesetzt)",
        )
    provided = request.query_params.get("t") or header_token
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Ungültiger Erfassungs-Token")


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


@router.get("/incidents", response_model=list[IncidentMeta])
async def list_capture_incidents(
    request: Request,
    x_capture_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[Incident]:
    await _check_token(db, request, x_capture_token)
    return await _capture_incidents(db)


@router.get("/roster", response_model=list[PersonnelOut])
async def capture_roster(
    request: Request,
    x_capture_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Active Mannschaft for the attendance checklist + «Wer erfasst?» attribution picker."""
    await _check_token(db, request, x_capture_token)
    rows = (
        await db.execute(
            select(Personnel).where(Personnel.is_active.is_(True)).order_by(Personnel.display_name)
        )
    ).scalars()
    return list(rows)


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
async def capture_incident_status(
    incident_id: uuid.UUID,
    request: Request,
    x_capture_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Tiny cross-visibility poll for the open capture form: has the KP tablet opened this
    incident (the editor_opened_at latch)? The form polls ~45 s ONLY while false — once
    true it stays true (latched), so the common case costs zero polls after the initial
    list load (which already carries editor_opened_at)."""
    await _check_token(db, request, x_capture_token)
    inc = await _get_in_window(db, incident_id)
    return {"kp_active": inc.editor_opened_at is not None}


@router.get("/incidents/{incident_id}/workspace", response_model=WorkspaceOut)
async def capture_get_workspace(
    incident_id: uuid.UUID,
    request: Request,
    x_capture_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> WorkspaceOut:
    await _check_token(db, request, x_capture_token)
    inc = await _get_in_window(db, incident_id)
    return WorkspaceOut(workspace=inc.map_workspace_json, workspace_rev=inc.workspace_rev)


@router.put("/incidents/{incident_id}/workspace", response_model=WorkspaceOut)
async def capture_put_workspace(
    incident_id: uuid.UUID,
    body: WorkspacePut,
    request: Request,
    x_capture_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> WorkspaceOut:
    """Same optimistic-concurrency save as the editor endpoint (shared helper), so capture
    edits merge with a live KP tablet exactly like a second editor would."""
    await _check_token(db, request, x_capture_token)
    await _get_in_window(db, incident_id)
    from .incidents import apply_workspace_put

    saved = await apply_workspace_put(db, incident_id, body, user_id=None, source="capture")
    await _bump_capture_usage(db, incident_id)  # only after an ACCEPTED save (409 raises above)
    return saved


@router.get("/incidents/{incident_id}/verify")
async def capture_verify_chain(
    incident_id: uuid.UUID,
    request: Request,
    x_capture_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Read-only audit-chain check for the capture Rapport-PDF — same output as the
    editor endpoint, so the QR-generated PDF shows a real Prüfnachweis."""
    await _check_token(db, request, x_capture_token)
    await _get_in_window(db, incident_id)
    from .. import audit

    return await audit.verify_chain(db, incident_id)


@router.post("/incidents/{incident_id}/report/pdf")
async def capture_report_pdf(
    incident_id: uuid.UUID,
    request: Request,
    payload: str = Form(...),
    x_capture_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Data-only Rapport-PDF for the capture view (no kiosk cookie there — poster token
    auth). Same composer as the editor endpoint; journal photos resolve from the media
    store server-side (the poster token never carried the media cookie, so the old
    client-side photo fetch silently dropped them). Read-only output."""
    await _check_token(db, request, x_capture_token)
    await _get_in_window(db, incident_id)
    from fastapi.responses import Response

    from .report import compose_report_from_payload

    pdf, _ = await compose_report_from_payload(db, payload)
    return Response(content=pdf, media_type="application/pdf")


# --- station print relay (poster token; twins of the /api/print* editor routes) --------


@router.get("/print/status")
async def capture_print_status(
    request: Request,
    x_capture_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _check_token(db, request, x_capture_token)
    from .print_relay import print_status

    return print_status()


@router.post("/incidents/{incident_id}/report/print")
async def capture_report_print(
    incident_id: uuid.UUID,
    request: Request,
    payload: str = Form(...),
    x_capture_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Queue the data-only Rapport-PDF on the station printer — the phone needs no
    printer setup, possession of the poster token is the authority (same as the PDF)."""
    await _check_token(db, request, x_capture_token)
    inc = await _get_in_window(db, incident_id)
    from .print_relay import enqueue_print_job

    job = await enqueue_print_job(db, inc, payload, kind="capture_report", requested_by=None)
    return {"job_id": str(job.id), "status": job.status}


@router.delete("/print-jobs/{job_id}")
async def capture_print_cancel(
    job_id: uuid.UUID,
    request: Request,
    x_capture_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Rückgängig for a just-queued job. Token holders may only touch jobs of incidents
    still reachable through the poster (and never already-claimed ones)."""
    await _check_token(db, request, x_capture_token)
    from ..models import PrintJob
    from .print_relay import cancel_print_job

    job = (await db.execute(select(PrintJob).where(PrintJob.id == job_id))).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Druckauftrag nicht gefunden")
    await _get_in_window(db, job.incident_id)
    return await cancel_print_job(db, job_id)


@router.get("/incidents/{incident_id}/journal", response_model=JournalPage)
async def capture_read_journal(
    incident_id: uuid.UUID,
    request: Request,
    x_capture_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> JournalPage:
    """Read-only Verlauf for the capture view's data-only Rapport-PDF."""
    await _check_token(db, request, x_capture_token)
    await _get_in_window(db, incident_id)
    from sqlalchemy import select as sa_select

    from ..models import JournalEntry

    rows = (
        await db.execute(
            sa_select(JournalEntry)
            .where(JournalEntry.incident_id == incident_id)
            .order_by(JournalEntry.seq.asc())
        )
    ).scalars()
    entries = [{"seq": r.seq, "row": r.row_json} for r in rows]
    return JournalPage(entries=entries, latest_seq=entries[-1]["seq"] if entries else 0)


@router.post("/incidents/{incident_id}/journal", response_model=JournalPage, status_code=201)
async def capture_append_journal(
    incident_id: uuid.UUID,
    body: JournalAppendIn,
    request: Request,
    x_capture_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> JournalPage:
    await _check_token(db, request, x_capture_token)
    await _get_in_window(db, incident_id)
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
        latest = accepted[-1]["seq"]
    else:
        latest = (
            await db.execute(
                select(sa_func.max(JournalEntry.seq)).where(JournalEntry.incident_id == incident_id)
            )
        ).scalar_one() or 0
    return JournalPage(entries=accepted, latest_seq=latest)

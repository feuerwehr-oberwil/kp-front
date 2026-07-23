"""Station print relay (`/api/print/*`, `/api/print-agent/*`).

One tap «An Stationsdrucker» queues the server-composed Einsatzrapport-PDF; a tiny on-site
agent (`tools/print_agent.py`) polls the claim endpoint over plain HTTPS and prints via
CUPS. Pull-based on purpose: the backend never needs to reach the station LAN.

Fail-closed: without ``PRINT_AGENT_SECRET`` the agent endpoints answer 403, ``/print/status``
reports ``available: false``, and the client never shows the button. The agent secret grants
exactly claim/read queued PDFs + write job status — no incident data, no roster, no admin.

The agent heartbeat is in-memory (module global): prod runs a single uvicorn worker
(backend/start.sh), and a restart heals within one poll interval (~5 s).
"""

import asyncio
import secrets as pysecrets
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Form, Header, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentUser
from ..config import settings
from ..database import get_db
from ..models import Incident, PrintJob
from ..report_pdf import ReportPayload
from .report import compose_report_from_payload, report_filename, warm_report_from_payload

router = APIRouter(tags=["print-relay"])

# The agent's claim request LONG-POLLS: it hangs on the server for up to CLAIM_HANG_SEC,
# woken the instant a job is enqueued (`_job_ready`), instead of the agent re-polling every
# few seconds. Idle HTTP traffic drops ~10× and a freshly queued job is claimed near-
# instantly. CLAIM_RECHECK_SEC is the correctness backstop: enqueue sets the event *before*
# its own COMMIT, so a woken claim may briefly not see the row yet — it re-queries every
# RECHECK regardless, so a raced wake-up costs at most one recheck, never the full hang.
CLAIM_HANG_SEC = 25.0
CLAIM_RECHECK_SEC = 2.0

# Heartbeat marks on connect (start of each hang), so last_seen refreshes about once per
# hang; the online window must comfortably exceed the hang or the dot would flicker offline
# mid-hang. The agent's claim request timeout (KP_CLAIM_TIMEOUT_SEC, default 60) also exceeds
# the hang.
ONLINE_WINDOW_SEC = 45

# Set by enqueue, awaited by the long-polling claim. Module-global: prod runs one uvicorn
# worker; a move to multiple workers wants Postgres LISTEN/NOTIFY here instead (the SQLite
# test harness has no NOTIFY, which is why this stays an in-process Event for now).
_job_ready: asyncio.Event | None = None
_job_loop: asyncio.AbstractEventLoop | None = None


def _job_event() -> asyncio.Event:
    """The enqueue→claim wake-up, lazily bound to the running loop. Recreated only if the loop
    changes — which happens across the test harness's per-test loops; prod has one long-lived
    loop, so the single agent and every enqueue share one event."""
    global _job_ready, _job_loop
    loop = asyncio.get_running_loop()
    if _job_ready is None or _job_loop is not loop:
        _job_ready = asyncio.Event()
        _job_loop = loop
    return _job_ready


_last_seen: datetime | None = None


def relay_available() -> bool:
    return bool(settings.print_agent_secret)


def relay_online() -> bool:
    if _last_seen is None:
        return False
    return (datetime.now(UTC) - _last_seen).total_seconds() < ONLINE_WINDOW_SEC


def _mark_seen() -> None:
    global _last_seen
    _last_seen = datetime.now(UTC)


def _check_agent_secret(provided: str | None) -> None:
    expected = settings.print_agent_secret
    if not expected:
        # Fail CLOSED: no secret configured → the whole relay surface is off.
        raise HTTPException(status_code=403, detail="Druck-Relay deaktiviert (PRINT_AGENT_SECRET nicht gesetzt)")
    if not provided or not pysecrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Ungültiges Print-Agent-Secret")


def print_status() -> dict:
    return {"available": relay_available(), "online": relay_online()}


def relay_status() -> dict:
    """Read-only admin/system view of the relay connection (incl. the raw heartbeat)."""
    return {
        "configured": relay_available(),
        "online": relay_online(),
        "last_seen": _last_seen.isoformat() if _last_seen else None,
    }


# --- app-facing (kiosk cookie; capture twins live in capture.py) ----------------------


@router.get("/print/status")
async def get_print_status(_user: CurrentUser) -> dict:
    """Availability + heartbeat freshness for the «An Stationsdrucker» button."""
    return print_status()


def payload_wants_color(data: ReportPayload) -> bool:
    """Colour only when the Kroki actually renders — everything else (forms, journal,
    plans) prints monochrome at the agent."""
    return bool(data.options.kroki and data.kroki is not None)


async def enqueue_print_job(db: AsyncSession, inc: Incident, payload: str, *,
                            kind: str, requested_by: uuid.UUID | None) -> PrintJob:
    """Compose the Rapport-PDF (same path as the download endpoints) and queue it."""
    if not relay_available():
        raise HTTPException(status_code=403, detail="Stationsdrucker nicht konfiguriert")
    pdf, data = await compose_report_from_payload(db, payload)
    job = PrintJob(
        incident_id=inc.id,
        kind=kind,
        filename=report_filename(inc.title),
        pdf=pdf,
        status="queued",
        color=payload_wants_color(data),
        requested_by=requested_by,
    )
    db.add(job)
    await db.flush()
    # Wake a long-polling agent. Set before this request commits: the claim's re-check window
    # (CLAIM_RECHECK_SEC) covers the brief gap until the row is visible to its own session.
    _job_event().set()
    return job


async def cancel_print_job(db: AsyncSession, job_id: uuid.UUID) -> dict:
    """Cancel iff still queued — this backs the Rückgängig toast. Already claimed → 409."""
    job = (await db.execute(select(PrintJob).where(PrintJob.id == job_id))).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Druckauftrag nicht gefunden")
    if job.status != "queued":
        raise HTTPException(status_code=409, detail="Druckauftrag ist nicht mehr in der Warteschlange")
    job.status = "cancelled"
    job.finished_at = datetime.now(UTC)
    await db.flush()
    return {"job_id": str(job.id), "status": job.status}


def job_view(job: PrintJob) -> dict:
    """Lifecycle snapshot the client polls to drive the live «wird gedruckt … ✓» toast."""
    return {
        "id": str(job.id),
        "status": job.status,  # queued | printing | done | failed | cancelled
        "kind": job.kind,
        "filename": job.filename,
        "error": job.error,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "claimed_at": job.claimed_at.isoformat() if job.claimed_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


@router.post("/incidents/{incident_id}/report/print")
async def report_print(
    incident_id: uuid.UUID,
    user: CurrentUser,
    payload: str = Form(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    inc = (await db.execute(select(Incident).where(Incident.id == incident_id))).scalar_one_or_none()
    if inc is None:
        raise HTTPException(status_code=404, detail="Einsatz nicht gefunden")
    job = await enqueue_print_job(db, inc, payload, kind="report", requested_by=user.id)
    return {"job_id": str(job.id), "status": job.status}


@router.post("/incidents/{incident_id}/report/print/prewarm")
async def report_print_prewarm(
    incident_id: uuid.UUID,
    _user: CurrentUser,
    payload: str = Form(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Speculatively warm the map-tile cache when the rapport modal opens, so the real
    enqueue render is near-instant. Best-effort: no printer side effects, never fails hard."""
    if not relay_available():
        return {"ok": False}
    inc = (await db.execute(select(Incident).where(Incident.id == incident_id))).scalar_one_or_none()
    if inc is None:
        raise HTTPException(status_code=404, detail="Einsatz nicht gefunden")
    await warm_report_from_payload(payload)
    return {"ok": True}


@router.get("/print-jobs/{job_id}")
async def report_print_job(
    job_id: uuid.UUID,
    _user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    job = (await db.execute(select(PrintJob).where(PrintJob.id == job_id))).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Druckauftrag nicht gefunden")
    return job_view(job)


@router.delete("/print-jobs/{job_id}")
async def report_print_cancel(
    job_id: uuid.UUID,
    _user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await cancel_print_job(db, job_id)


# --- agent-facing (X-Print-Agent-Secret) ----------------------------------------------


class AgentJobStatus(BaseModel):
    status: str  # 'done' | 'failed'
    error: str | None = None


async def _try_claim(db: AsyncSession) -> dict | None:
    """Atomically claim the oldest queued job, or None when the queue is empty.
    Conditional UPDATE guards the claim (portable to the SQLite test harness, atomic on one
    row); the single agent makes real contention theoretical anyway."""
    for _ in range(3):
        job = (
            await db.execute(
                select(PrintJob).where(PrintJob.status == "queued").order_by(PrintJob.created_at.asc()).limit(1)
            )
        ).scalar_one_or_none()
        if job is None:
            return None
        claimed = await db.execute(
            update(PrintJob)
            .where(PrintJob.id == job.id, PrintJob.status == "queued")
            .values(status="printing", claimed_at=datetime.now(UTC))
        )
        if claimed.rowcount:
            await db.flush()
            return {
                "id": str(job.id),
                "kind": job.kind,
                "incident_id": str(job.incident_id),
                "filename": job.filename,
                "color": job.color,
                "created_at": job.created_at.isoformat() if job.created_at else None,
            }
    return None


@router.post("/print-agent/claim")
async def agent_claim(
    x_print_agent_secret: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Long-poll: claim the oldest queued job (→ metadata JSON), or hang up to CLAIM_HANG_SEC
    and answer 204 when the queue stays idle. Woken instantly by `_job_ready` on enqueue.
    Every call is also the heartbeat that keeps the relay «online» in the UI."""
    _check_agent_secret(x_print_agent_secret)
    _mark_seen()
    loop = asyncio.get_running_loop()
    ev = _job_event()
    deadline = loop.time() + CLAIM_HANG_SEC
    while True:
        ev.clear()
        job = await _try_claim(db)
        if job is not None:
            return job
        # Nothing to claim — end the read transaction so we don't idle-in-transaction while
        # the request hangs, then wait to be woken (or re-check after CLAIM_RECHECK_SEC).
        await db.rollback()
        remaining = deadline - loop.time()
        if remaining <= 0:
            return Response(status_code=status.HTTP_204_NO_CONTENT)
        try:
            await asyncio.wait_for(ev.wait(), timeout=min(CLAIM_RECHECK_SEC, remaining))
        except TimeoutError:
            pass


@router.get("/print-agent/jobs/{job_id}/file")
async def agent_job_file(
    job_id: uuid.UUID,
    x_print_agent_secret: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> Response:
    _check_agent_secret(x_print_agent_secret)
    _mark_seen()
    job = (await db.execute(select(PrintJob).where(PrintJob.id == job_id))).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Druckauftrag nicht gefunden")
    if job.status == "cancelled":
        raise HTTPException(status_code=409, detail="Druckauftrag wurde abgebrochen")
    return Response(content=job.pdf, media_type="application/pdf")


@router.post("/print-agent/jobs/{job_id}/status")
async def agent_job_status(
    job_id: uuid.UUID,
    body: AgentJobStatus,
    x_print_agent_secret: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    _check_agent_secret(x_print_agent_secret)
    _mark_seen()
    if body.status not in {"done", "failed"}:
        raise HTTPException(status_code=422, detail="status muss 'done' oder 'failed' sein")
    job = (await db.execute(select(PrintJob).where(PrintJob.id == job_id))).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Druckauftrag nicht gefunden")
    if job.status != "printing":
        raise HTTPException(status_code=409, detail=f"Druckauftrag ist '{job.status}', nicht 'printing'")
    job.status = body.status
    job.error = (body.error or "").strip()[:2000] or None
    job.finished_at = datetime.now(UTC)
    await db.flush()
    return {"job_id": str(job.id), "status": job.status}

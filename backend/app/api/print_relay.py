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
from .report import compose_report_from_payload, report_filename

router = APIRouter(tags=["print-relay"])

# Poll interval is ~5 s (tools/print_agent.py); the relay counts as online while the last
# heartbeat is fresher than ~6× that, so brief hiccups don't flicker the UI dot.
ONLINE_WINDOW_SEC = 30

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


@router.post("/print-agent/claim")
async def agent_claim(
    x_print_agent_secret: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Atomically claim the oldest queued job (→ metadata JSON), or 204 when idle.
    Every call is also the heartbeat that keeps the relay «online» in the UI."""
    _check_agent_secret(x_print_agent_secret)
    _mark_seen()
    # Conditional UPDATE guards the claim (portable to the SQLite test harness, atomic on
    # one row); the single agent makes real contention theoretical anyway.
    for _ in range(3):
        job = (
            await db.execute(
                select(PrintJob).where(PrintJob.status == "queued").order_by(PrintJob.created_at.asc()).limit(1)
            )
        ).scalar_one_or_none()
        if job is None:
            return Response(status_code=status.HTTP_204_NO_CONTENT)
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
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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

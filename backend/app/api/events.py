"""Audit events: client tactical-event ingest, chronological read, chain verification.

Capture substrate (sub-phase A). The reconstruction/scrubber UI consumes these once
sub-phase B ships; the read + verify endpoints exist now so the chain is inspectable.
"""

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import audit
from ..auth.dependencies import CurrentEditor, CurrentUser
from ..database import get_db
from ..models import Incident, IncidentEvent
from ..schemas import EventBatchIn, EventOut, SnapshotOut, VehicleSampleOut

router = APIRouter(prefix="/incidents", tags=["events"])


async def _ensure(db: AsyncSession, incident_id: uuid.UUID) -> None:
    exists = (await db.execute(select(Incident.id).where(Incident.id == incident_id))).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status_code=404, detail="Einsatz nicht gefunden")


@router.get("/{incident_id}/events", response_model=list[EventOut])
async def list_events(
    incident_id: uuid.UUID,
    _user: CurrentUser,
    from_: datetime | None = None,
    to: datetime | None = None,
    db: AsyncSession = Depends(get_db),
):
    await _ensure(db, incident_id)
    q = select(IncidentEvent).where(IncidentEvent.incident_id == incident_id)
    if from_ is not None:
        q = q.where(IncidentEvent.occurred_at >= from_)
    if to is not None:
        q = q.where(IncidentEvent.occurred_at <= to)
    q = q.order_by(IncidentEvent.seq.asc())
    return list((await db.execute(q)).scalars())


@router.post("/{incident_id}/events", response_model=list[EventOut], status_code=201)
async def ingest_events(
    incident_id: uuid.UUID, body: EventBatchIn, user: CurrentEditor, db: AsyncSession = Depends(get_db)
):
    """Flush a batch of client tactical events (entity.*, draw.*, layer.toggle, undo, redo).

    Server assigns seq + recorded_at + chain hash; client supplies occurred_at (scene
    wall-clock, possibly buffered offline).
    """
    await _ensure(db, incident_id)
    out = []
    for e in body.events:
        ev = await audit.append_event(
            db, incident_id=incident_id, op_type=e.op_type, source="client",
            payload=e.payload, user_id=user.id, occurred_at=e.occurred_at,
        )
        out.append(ev)
    return out


@router.get("/{incident_id}/snapshot", response_model=SnapshotOut)
async def snapshot_at(
    incident_id: uuid.UUID,
    _user: CurrentUser,
    at: datetime,
    db: AsyncSession = Depends(get_db),
) -> SnapshotOut:
    """Nearest workspace snapshot with occurred_at <= `at` — the replay fold anchor.

    Read-only; any authenticated user. Returns found=false (no workspace) when every
    snapshot is in the future, so the client folds from an empty earliest state.
    """
    await _ensure(db, incident_id)
    snap, blob = await audit.load_snapshot_at(db, incident_id, at)
    if snap is None:
        return SnapshotOut(found=False)
    return SnapshotOut(found=True, occurred_at=snap.occurred_at, seq_at=snap.seq_at, workspace=blob)


@router.get("/{incident_id}/samples", response_model=list[VehicleSampleOut])
async def samples(
    incident_id: uuid.UUID,
    _user: CurrentUser,
    from_: datetime | None = None,
    to: datetime | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Vehicle GPS samples in the window (for vehicle replay). May be empty today —
    the Traccar→samples capture job isn't wired yet (PLAN-audit-trail §4, Phase 6)."""
    await _ensure(db, incident_id)
    return await audit.samples_in_window(db, incident_id, from_, to)


@router.get("/{incident_id}/state")
async def state_at(
    incident_id: uuid.UUID,
    _user: CurrentUser,
    at: datetime,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Server-side convenience reconstruction at `at`: nearest snapshot + events since.

    The scrubber folds locally per-frame (fetching snapshot+events once); this single
    round-trip is for non-interactive consumers (export, debugging). Read-only.
    """
    await _ensure(db, incident_id)
    return await audit.reconstruct_state(db, incident_id, at)


@router.get("/{incident_id}/verify")
async def verify(incident_id: uuid.UUID, _user: CurrentUser, db: AsyncSession = Depends(get_db)) -> dict:
    await _ensure(db, incident_id)
    return await audit.verify_chain(db, incident_id)

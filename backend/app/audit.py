"""Audit-trail capture substrate (PLAN-audit-trail §A).

Append-only, hash-chained operational events per incident + versioned workspace
snapshots. The chain is over ingest order (``seq``); the replay timeline uses
``occurred_at``. GPS samples are append-only but stay outside the hash chain.

This module only *captures* (substrate A). The reconstruction/scrubber UI (B) and the
signed export + verify UI (C) are deferred per the plan — but ``verify_chain`` lives
here already since it's cheap and proves the capture is sound.
"""

import hashlib
import json
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import storage
from .models import IncidentEvent, VehicleSample, WorkspaceSnapshot

GENESIS = "0" * 64


def _canonical(fields: dict) -> str:
    """Stable JSON for hashing — sorted keys, no whitespace, UTC ISO timestamps."""
    return json.dumps(fields, sort_keys=True, separators=(",", ":"), default=str)


def compute_hash(prev_hash: str, fields: dict) -> str:
    return hashlib.sha256((prev_hash + _canonical(fields)).encode("utf-8")).hexdigest()


async def append_event(
    db: AsyncSession,
    *,
    incident_id: uuid.UUID,
    op_type: str,
    source: str,
    payload: dict | None = None,
    user_id: uuid.UUID | None = None,
    occurred_at: datetime | None = None,
) -> IncidentEvent:
    """Append one event to an incident's chain, assigning seq/prev_hash/hash.

    The unique(incident_id, seq) constraint is the race backstop; callers run inside the
    request transaction. Single active editor makes contention rare.
    """
    last = (
        await db.execute(
            select(IncidentEvent)
            .where(IncidentEvent.incident_id == incident_id)
            .order_by(IncidentEvent.seq.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    seq = (last.seq + 1) if last else 1
    prev_hash = last.hash if last else GENESIS
    occurred = occurred_at or datetime.now(UTC)

    fields = {
        "incident_id": str(incident_id),
        "seq": seq,
        "occurred_at": occurred.isoformat(),
        "source": source,
        "user_id": str(user_id) if user_id else None,
        "op_type": op_type,
        "payload": payload or {},
    }
    digest = compute_hash(prev_hash, fields)

    event = IncidentEvent(
        incident_id=incident_id,
        seq=seq,
        occurred_at=occurred,
        source=source,
        user_id=user_id,
        op_type=op_type,
        payload_json=payload,
        prev_hash=prev_hash,
        hash=digest,
    )
    db.add(event)
    await db.flush()
    return event


async def snapshot_workspace(
    db: AsyncSession, *, incident_id: uuid.UUID, workspace: dict
) -> WorkspaceSnapshot:
    """Persist a versioned copy of the saved blob = a fold checkpoint for replay."""
    seq_at = (
        await db.execute(
            select(func.coalesce(func.max(IncidentEvent.seq), 0)).where(
                IncidentEvent.incident_id == incident_id
            )
        )
    ).scalar_one()
    key = storage.new_key(f"snapshots/{incident_id}", ".json")
    storage.put_bytes(key, json.dumps(workspace, separators=(",", ":")).encode("utf-8"))
    snap = WorkspaceSnapshot(incident_id=incident_id, seq_at=seq_at, storage_key=key)
    db.add(snap)
    await db.flush()
    return snap


# --- Reconstruction (sub-phase B) ---------------------------------------------------


def nearest_snapshot(snapshots: list[WorkspaceSnapshot], at: datetime) -> WorkspaceSnapshot | None:
    """Pure selection: the latest snapshot whose occurred_at <= `at`.

    `snapshots` is any iterable of snapshot-like objects ordered or not; we scan and keep
    the one with the greatest occurred_at that is still <= at. Returns None when every
    snapshot is in the future (replay then starts from an empty/earliest state).
    """
    best: WorkspaceSnapshot | None = None
    for s in snapshots:
        if s.occurred_at <= at and (best is None or s.occurred_at > best.occurred_at):
            best = s
    return best


async def load_snapshot_at(
    db: AsyncSession, incident_id: uuid.UUID, at: datetime
) -> tuple[WorkspaceSnapshot | None, dict | None]:
    """Fetch the nearest snapshot <= `at` and load its stored blob (or (None, None))."""
    snaps = list(
        (
            await db.execute(
                select(WorkspaceSnapshot)
                .where(
                    WorkspaceSnapshot.incident_id == incident_id,
                    WorkspaceSnapshot.occurred_at <= at,
                )
                .order_by(WorkspaceSnapshot.occurred_at.desc())
                .limit(1)
            )
        ).scalars()
    )
    snap = snaps[0] if snaps else None
    if snap is None:
        return None, None
    try:
        blob = json.loads(storage.get_bytes(snap.storage_key).decode("utf-8"))
    except (FileNotFoundError, ValueError):
        blob = None
    return snap, blob


async def reconstruct_state(db: AsyncSession, incident_id: uuid.UUID, at: datetime) -> dict:
    """Server-side convenience reconstruction (the client folds locally for scrubbing).

    Returns the nearest snapshot blob <= `at` plus the events in (snapshot, at] so a
    caller (e.g. an export) gets a single round-trip. The blob is the authoritative
    workspace shape; the events let a consumer fold finer detail or render markers.
    """
    snap, blob = await load_snapshot_at(db, incident_id, at)
    snap_occurred = snap.occurred_at if snap else None
    q = select(IncidentEvent).where(
        IncidentEvent.incident_id == incident_id, IncidentEvent.occurred_at <= at
    )
    if snap_occurred is not None:
        q = q.where(IncidentEvent.occurred_at > snap_occurred)
    q = q.order_by(IncidentEvent.seq.asc())
    events = list((await db.execute(q)).scalars())
    return {
        "at": at.isoformat(),
        "snapshot_occurred_at": snap_occurred.isoformat() if snap_occurred else None,
        "workspace": blob,
        "events": [
            {
                "seq": e.seq,
                "occurred_at": e.occurred_at.isoformat(),
                "op_type": e.op_type,
                "payload": e.payload_json or {},
            }
            for e in events
        ],
    }


async def samples_in_window(
    db: AsyncSession, incident_id: uuid.UUID, from_: datetime | None, to: datetime | None
) -> list[VehicleSample]:
    q = select(VehicleSample).where(VehicleSample.incident_id == incident_id)
    if from_ is not None:
        q = q.where(VehicleSample.ts >= from_)
    if to is not None:
        q = q.where(VehicleSample.ts <= to)
    return list((await db.execute(q.order_by(VehicleSample.ts.asc()))).scalars())


async def verify_chain(db: AsyncSession, incident_id: uuid.UUID) -> dict:
    """Recompute the hash chain; report intact / where it first breaks."""
    events = list(
        (
            await db.execute(
                select(IncidentEvent)
                .where(IncidentEvent.incident_id == incident_id)
                .order_by(IncidentEvent.seq.asc())
            )
        ).scalars()
    )
    prev = GENESIS
    for ev in events:
        fields = {
            "incident_id": str(ev.incident_id),
            "seq": ev.seq,
            "occurred_at": ev.occurred_at.isoformat(),
            "source": ev.source,
            "user_id": str(ev.user_id) if ev.user_id else None,
            "op_type": ev.op_type,
            "payload": ev.payload_json or {},
        }
        expected = compute_hash(prev, fields)
        if ev.prev_hash != prev or ev.hash != expected:
            return {"intact": False, "broken_at_seq": ev.seq, "count": len(events)}
        prev = ev.hash
    return {"intact": True, "broken_at_seq": None, "count": len(events), "head": prev}

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

import anyio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import storage
from .models import Incident, IncidentEvent, VehicleSample, WorkspaceSnapshot

GENESIS = "0" * 64


class EventIdentityConflictError(ValueError):
    """A client event ID was reused for a different operation or author."""


def _stamp(dt: datetime) -> str:
    """The timestamp exactly as the chain hashes it: UTC, tz-aware, ISO.

    ⚠️ The hash covers ``occurred_at.isoformat()``, and that string used to depend on what the
    DATABASE DRIVER handed back. ``append_event`` hashes the Python value (tz-aware, «+00:00»);
    ``verify_chain`` hashes the value after a round-trip. Postgres' timestamptz returns UTC, so
    the two agreed and production verified — but any dialect that drops the tzinfo (SQLite, which
    is what the test suite runs on) produced a different string and reported an intact chain as
    broken. A legally load-bearing check must not depend on a driver detail.

    Normalising here is byte-compatible with every chain written so far: a value already stored
    as UTC formats identically, so existing incidents keep verifying. A naive value is READ as
    UTC, which is what it always was — everything is written with ``datetime.now(UTC)``.
    """
    return (dt if dt.tzinfo else dt.replace(tzinfo=UTC)).astimezone(UTC).isoformat()


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
    client_id: str | None = None,
) -> IncidentEvent:
    """Append one event to an incident's chain, assigning seq/prev_hash/hash.

    Callers run inside the request transaction; concurrent appenders are serialised on the
    incident row (see the lock below), so the unique(incident_id, seq) constraint is a
    backstop again rather than the thing that decides the race.
    """
    # Take the incident row first — the same lock the journal takes, for the same reason
    # (api/journal._ensure). Both `seq` and `prev_hash` are read-then-written: two appends
    # that read the same "last event" compute the same seq, and the loser of that race used to
    # come back as a 500 on uq_incident_events_seq in production — the batch flush
    # of one editor against a status webhook landing at the same moment. It would also fork the
    # hash chain, which is the more expensive half. Serialising is the fix; the wait is one
    # INSERT long. No-op on SQLite, which has neither row locks nor concurrent writers.
    await db.execute(select(Incident.id).where(Incident.id == incident_id).with_for_update())

    # The lock also serialises retry lookup with append. A lost response must not turn one
    # action into two chain links. Existing clients without IDs retain append semantics.
    #
    # ⚠️ An event's identity is (client_id, author, op_type, payload) — NOT its occurred_at
    # (24.09.2026). Some events are OBSERVED by every open device rather than performed by one
    # hand (the Atemschutz alarm and its end): each device derives the same client_id from the
    # same fact and sends the same payload, but stamps the moment IT noticed, a second or a
    # backgrounded minute apart. Comparing the stamp turned the 2nd and 3rd copy into 409s,
    # parked red in their outboxes. The first observation's time is kept; the copies are the
    # duplicate they are. A DIFFERENT author, op or payload under one id is still the conflict.
    if client_id is not None:
        existing = (
            await db.execute(
                select(IncidentEvent).where(
                    IncidentEvent.incident_id == incident_id, IncidentEvent.client_id == client_id
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            if (
                existing.source != source
                or existing.user_id != user_id
                or existing.op_type != op_type
                or _canonical(existing.payload_json or {}) != _canonical(payload or {})
            ):
                raise EventIdentityConflictError("Event ID already belongs to a different operation")
            return existing

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
        "occurred_at": _stamp(occurred),
        "source": source,
        "user_id": str(user_id) if user_id else None,
        "op_type": op_type,
        "payload": payload or {},
    }
    digest = compute_hash(prev_hash, fields)

    event = IncidentEvent(
        client_id=client_id,
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


def _encode_snapshot(workspace: dict) -> bytes:
    return json.dumps(workspace, separators=(",", ":")).encode("utf-8")


async def snapshot_workspace(db: AsyncSession, *, incident_id: uuid.UUID, workspace: dict) -> WorkspaceSnapshot:
    """Persist a versioned copy of the saved blob = a fold checkpoint for replay.

    One per save, deliberately: the replay fold (``src/lib/replay``) applies only the events whose
    payload carries the change (entity/draw/board/layer ops); Trupps, attendance, the Gebäude,
    a georef re-bake and every other slice reach a past moment ONLY through the snapshot the save
    that carried them wrote. Thinning them out would make replay show a Trupp's clock or a
    storey's ink up to one interval late.

    The encode and the write run on a worker thread: at field blob sizes (megabytes) both were a
    stall of the whole event loop on every save — every other request, the live position feed
    included, waited behind it. The blob is published before the row that references it is
    flushed, and the rollback hook is armed before the write starts, so a save cancelled or
    rolled back mid-way leaves no orphan (AGENTS.md · backup originals).
    """
    seq_at = (
        await db.execute(
            select(func.coalesce(func.max(IncidentEvent.seq), 0)).where(IncidentEvent.incident_id == incident_id)
        )
    ).scalar_one()
    key = storage.new_key(f"snapshots/{incident_id}", ".json")
    storage.created_in_transaction(db, key)
    data = await anyio.to_thread.run_sync(_encode_snapshot, workspace)
    await storage.aput_bytes(key, data)
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
    q = select(IncidentEvent).where(IncidentEvent.incident_id == incident_id, IncidentEvent.occurred_at <= at)
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
                select(IncidentEvent).where(IncidentEvent.incident_id == incident_id).order_by(IncidentEvent.seq.asc())
            )
        ).scalars()
    )
    prev = GENESIS
    for ev in events:
        fields = {
            "incident_id": str(ev.incident_id),
            "seq": ev.seq,
            "occurred_at": _stamp(ev.occurred_at),
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

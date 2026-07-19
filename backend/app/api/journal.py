"""Journal (Verlauf) store: append-only per-incident rows, read by seq cursor.

The operational journal no longer rides the workspace blob (unbounded growth → the whole
document re-synced on every edit). Editors append rows here — idempotent on the client row
id, so the offline outbox can retry a batch safely — and every device pulls new rows with
`since_seq` on its live-poll tick (an empty page is a few bytes). Rows are never mutated or
deleted; lifecycle changes (reminder done/snoozed, corrections) are NEW rows, as everywhere
else in the incident record.
"""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentEditor, CurrentUser
from ..database import get_db
from ..models import Incident, JournalEntry
from ..schemas import JournalAppendIn, JournalPage

router = APIRouter(prefix="/incidents", tags=["journal"])

MAX_BATCH = 500


async def _ensure(db: AsyncSession, incident_id: uuid.UUID, *, lock: bool = False) -> None:
    q = select(Incident.id).where(Incident.id == incident_id)
    if lock:
        # serialise concurrent appenders on the incident row so seq stays gapless-monotonic
        q = q.with_for_update()
    exists = (await db.execute(q)).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status_code=404, detail="Einsatz nicht gefunden")


@router.get("/{incident_id}/journal", response_model=JournalPage)
async def read_journal(
    incident_id: uuid.UUID,
    _user: CurrentUser,
    since_seq: int = 0,
    db: AsyncSession = Depends(get_db),
) -> JournalPage:
    """All rows with seq > since_seq, oldest first. since_seq=0 → the full journal."""
    await _ensure(db, incident_id)
    rows = (
        await db.execute(
            select(JournalEntry)
            .where(JournalEntry.incident_id == incident_id, JournalEntry.seq > since_seq)
            .order_by(JournalEntry.seq.asc())
        )
    ).scalars()
    entries = [{"seq": r.seq, "row": r.row_json} for r in rows]
    latest = entries[-1]["seq"] if entries else since_seq
    return JournalPage(entries=entries, latest_seq=latest)


async def append_rows(db: AsyncSession, incident_id: uuid.UUID, entries: list[dict]) -> list[dict]:
    """Core append (idempotent by row id, per-incident seq under the incident row lock).
    Shared by the HTTP endpoint and server-side system rows (archive/reopen boundary)."""
    await _ensure(db, incident_id, lock=True)

    ids = [e["id"] for e in entries]
    existing = set(
        (
            await db.execute(
                select(JournalEntry.client_id).where(
                    JournalEntry.incident_id == incident_id, JournalEntry.client_id.in_(ids)
                )
            )
        ).scalars()
    )
    next_seq = (
        (
            await db.execute(
                select(func.max(JournalEntry.seq)).where(JournalEntry.incident_id == incident_id)
            )
        ).scalar_one()
        or 0
    ) + 1

    accepted = []
    seen: set[str] = set()
    for e in entries:
        cid = e["id"]
        if cid in existing or cid in seen:  # replayed batch / duplicate within batch
            continue
        seen.add(cid)
        db.add(JournalEntry(incident_id=incident_id, client_id=cid, seq=next_seq, row_json=e))
        accepted.append({"seq": next_seq, "row": e})
        next_seq += 1

    await db.flush()
    return accepted


async def append_system_row(db: AsyncSession, incident_id: uuid.UUID, *, icon: str, text: str) -> None:
    """Server-authored boundary row (Einsatz abgeschlossen / wiedereröffnet). `t` stays empty —
    clients localise the display time from `at` (the server clock is UTC)."""
    at = datetime.now(UTC).isoformat()
    row = {"id": f"sys{uuid.uuid4().hex[:12]}", "t": "", "at": at, "icon": icon, "text": text}
    await append_rows(db, incident_id, [row])


@router.post("/{incident_id}/journal", response_model=JournalPage, status_code=201)
async def append_journal(
    incident_id: uuid.UUID,
    body: JournalAppendIn,
    _user: CurrentEditor,
    db: AsyncSession = Depends(get_db),
) -> JournalPage:
    """Append a batch of rows. Idempotent on the client row id: rows this incident already
    holds are skipped silently, so an offline outbox may retry the same batch after a lost
    response without duplicating the record. Returns the accepted rows with their seqs."""
    if len(body.entries) > MAX_BATCH:
        raise HTTPException(status_code=422, detail=f"Batch zu gross (max. {MAX_BATCH})")
    accepted = await append_rows(db, incident_id, body.entries)
    if accepted:
        latest = accepted[-1]["seq"]
    else:
        latest = (
            await db.execute(
                select(func.max(JournalEntry.seq)).where(JournalEntry.incident_id == incident_id)
            )
        ).scalar_one() or 0
    return JournalPage(entries=accepted, latest_seq=latest)

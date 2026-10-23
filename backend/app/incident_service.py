"""The incident service: loading an incident, its lifecycle, and the workspace save.

Moved out of the incidents router (sweep A.20, 23.10.2026): nine routers and the link scope
check imported these from `api/incidents`, so routers depended on each other. They depend on
this module now; `api/incidents` is the CRUD and workspace router on top of it.

The rule it carries: a closed Einsatz keeps its RECORD, not its operation (`incident_closed`,
`happened_after_close` – see the block below), and every workspace save goes through
`apply_workspace_put`'s conditional UPDATE.
"""

import uuid
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import NamedTuple

from fastapi import HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from . import audit, live_wait, push
from .alarm_validation import ALARM_VALIDATED_KEYS, validate_alarm_workspace
from .database import execute_dml
from .models import INCIDENT_ACTIVE_STATUSES, Incident, lifecycle_open
from .schemas import WorkspaceOut, WorkspacePut, _scrub_drawing_props
from .vehicle_presence import keep_server_gps
from .workspace_kinds import keep_newer_board_kinds

#: What every surface says when the incident behind an id is not there. One string, because
#: it is also the answer a caller must not be able to tell apart from «not yours» — every
#: incident-scoped router raises it through `get_incident_or_404` below.
INCIDENT_NOT_FOUND = "Einsatz nicht gefunden"


async def get_incident_or_404(db: AsyncSession, incident_id: uuid.UUID, *, lock: bool = False) -> Incident:
    """The incident behind a path id, or 404 — the load every incident-scoped route opens with.

    `lock` takes the row FOR UPDATE — for a check-then-set like minting a link secret, where
    two editors reading NULL in the same window would otherwise both write, and the QR the
    first one already showed encodes a secret the second one overwrote."""
    stmt = select(Incident).where(Incident.id == incident_id)
    if lock:
        stmt = stmt.with_for_update()
    inc = (await db.execute(stmt)).scalar_one_or_none()
    if inc is None:
        raise HTTPException(status_code=404, detail=INCIDENT_NOT_FOUND)
    return inc


# --- a closed Einsatz keeps its RECORD, not its operation ----------------------------------
#
# Staging walk-through 25.09.2026 (N3): one phone closed the Einsatz, and the other phone and the
# tablet ran it live for minutes afterwards — a «Kontakt» tap and two «Atemschutz-Alarm …
# Überfällig» rows were written INTO the closed record. The devices now learn of the close and
# stop (lib/incidentClosed), but a device that was offline, or never heard, still arrives with
# writes queued from before — and the server is the one place that can say «too late».
#
# The line is the one the `el` role already draws: the RECORD domains (Anwesenheit/Zeitplan,
# Mittel, Checklisten, Rapport + Beilagen — `api/incidents · RECORD_WORKSPACE_KEYS`, the
# `EL_EVENT_PREFIXES` vocabulary, and every Verlauf row that is not a live observation) stay
# writable, because a late correction to the record is a Nachtrag and the record renders it as
# one. Everything the running Einsatz OPERATES — the Atemschutz-Tafel, the Karte, the Pläne, and
# the rows and events those write — is refused once it is over. The Einsatzdaten (`PATCH`), media
# uploads and «Wieder öffnen» are untouched; reopening makes the Einsatz writable again, as it
# always did.
#
# The refusal is a 409 with a NAME, not a bare status: the client's outboxes park a write
# refused with `INCIDENT_CLOSED_CODE` as «refused» (kept, exported with «Einträge sichern», never
# re-sent, never a red lamp) — the bucket #204 made for the role refusals — and the device takes
# the refusal as the news that the Einsatz is closed. A plain 409 on the workspace is the
# revision conflict and would start a merge.

#: `{code}` of the closed-Einsatz refusal — mirrored by src/lib/incidentClosed.ts.
INCIDENT_CLOSED_CODE = "incident_closed"

#: ⚠️ A write is judged by WHEN IT HAPPENED, not by when it arrived (review of #235): a Kontakt
#: tapped at 14:44 on a phone whose uplink came back at 14:47 is a true fact of the Einsatz closed
#: at 14:45 — it is recorded (and prints as a Nachtrag), and only what happened AFTER the close is
#: refused. The stamp is the client's (rows `at`, events `occurred_at`, saves `edited_at` — all on
#: the server-aligned clock, lib/serverClock), so it gets a tolerance for the skew that clock may
#: still have. A write with no usable stamp is judged by arrival, i.e. refused.
CLOSED_CLOCK_TOLERANCE = timedelta(seconds=120)


def _as_utc(at: object) -> datetime | None:
    if isinstance(at, str):
        try:
            at = datetime.fromisoformat(at.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(at, datetime):
        return None
    return at if at.tzinfo is not None else at.replace(tzinfo=UTC)


def happened_after_close(at: object, closed_at: datetime | None) -> bool:
    """Did this write happen after the Einsatz was closed (see CLOSED_CLOCK_TOLERANCE)? No close
    time (a status moved off the running ones) or no usable stamp → judged by arrival: yes."""
    when = _as_utc(at)
    close = _as_utc(closed_at)
    if when is None or close is None:
        return True
    return when > close + CLOSED_CLOCK_TOLERANCE


class IncidentLifecycle(NamedTuple):
    """The lifecycle columns alone — a closed check must not drag the workspace JSONB along."""

    is_archived: bool
    status: str
    closed_at: datetime | None

    @property
    def is_open(self) -> bool:
        return lifecycle_open(self.is_archived, self.status)


async def incident_lifecycle(db: AsyncSession, incident_id: uuid.UUID, *, lock: bool = False) -> IncidentLifecycle:
    """Read whether the Einsatz is still running, or 404. `lock` takes the incident row FOR
    UPDATE — the same lock the journal/audit appenders take next — so an append cannot slip in
    between this check and a close committing beside it."""
    stmt = select(Incident.is_archived, Incident.status, Incident.closed_at).where(Incident.id == incident_id)
    if lock:
        stmt = stmt.with_for_update()
    row = (await db.execute(stmt)).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=INCIDENT_NOT_FOUND)
    return await resolved_lifecycle(
        db, incident_id, IncidentLifecycle(bool(row.is_archived), row.status, row.closed_at)
    )


async def current_close(db: AsyncSession, incident_id: uuid.UUID, first_closed_at: datetime | None) -> datetime | None:
    """When the Einsatz was closed THIS time. `closed_at` is the FIRST Einsatzende and is kept
    across «Wieder öffnen» (so later rows print as Nachträge) — judged against it, a write made
    while a reopened Einsatz ran would count as «after the close» once it is closed again. The
    latest lifecycle event that closed it says when; `closed_at` is the fallback for an Einsatz
    closed before those events existed. Only ever asked for a closed Einsatz (a handful of rows)."""
    from .models import IncidentEvent

    stamped = (await db.execute(select(Incident.last_closed_at).where(Incident.id == incident_id))).scalar_one_or_none()
    if stamped is not None:
        return stamped if first_closed_at is None else max(stamped, first_closed_at)
    # …an Einsatz closed before the column existed, or by a status: the lifecycle events say
    rows = (
        await db.execute(
            select(IncidentEvent.occurred_at, IncidentEvent.payload_json)
            .where(IncidentEvent.incident_id == incident_id, IncidentEvent.op_type == "status.change")
            .order_by(IncidentEvent.seq.desc())
        )
    ).all()
    for at, payload in rows:
        if not isinstance(payload, dict):
            continue
        closes = payload.get("archived") is True or (
            "to" in payload and payload.get("to") not in INCIDENT_ACTIVE_STATUSES
        )
        if closes:
            return at if first_closed_at is None else max(at, first_closed_at)
    return first_closed_at


async def resolved_lifecycle(db: AsyncSession, incident_id: uuid.UUID, lc: "IncidentLifecycle") -> "IncidentLifecycle":
    """A closed lifecycle carries the CURRENT close (see current_close); an open one as read."""
    if lc.is_open:
        return lc
    return lc._replace(closed_at=await current_close(db, incident_id, lc.closed_at))


def incident_closed(closed_at: datetime | None) -> HTTPException:
    """The refusal itself. `closed_at` rides along so a device that learns of the close from
    this answer can say WHEN (it is the first Einsatzende, kept across a reopen)."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": INCIDENT_CLOSED_CODE,
            "message": "Einsatz ist abgeschlossen – nicht mehr übernommen",
            "closed_at": closed_at.isoformat() if closed_at else None,
        },
    )


async def _rev(db: AsyncSession, incident_id: uuid.UUID) -> int:
    """The workspace revision alone — a cheap int column, no JSONB. 404 if the incident is gone."""
    rev = (await db.execute(select(Incident.workspace_rev).where(Incident.id == incident_id))).scalar_one_or_none()
    if rev is None:
        raise HTTPException(status_code=404, detail=INCIDENT_NOT_FOUND)
    return rev


def workspace_revision_conflict(server_rev: int, base_rev: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "message": "Workspace wurde zwischenzeitlich geändert",
            "server_rev": server_rev,
            "your_base_rev": base_rev,
        },
    )


# **Alarm validation must preserve unchanged legacy data.** Full workspace saves validate at
# `apply_workspace_put` against the stored incident, retaining exact existing malformed rows
# while rejecting new, edited or duplicated invalid rows. Never silently drop operational
# records or skip validation because a revision differs; return the normal conflict instead.
async def apply_workspace_put(
    db: AsyncSession,
    incident_id: uuid.UUID,
    body: WorkspacePut,
    *,
    user_id: uuid.UUID | None,
    source: str = "client",
    inc: Incident | None = None,
    writer: str | None = None,
) -> WorkspaceOut:
    """Shared save path for the editor endpoint and the station capture endpoint.

    `writer`: the saving device's id (`X-Workspace-Writer`), recorded for the follower read —
    see `get_workspace`. None for a save no device's follower should treat as its own.

    Optimistic concurrency at the DB level: bump the rev only if it still equals the
    client's base_rev. A conditional UPDATE is atomic, so two editors who both read
    rev=N can't both win — the loser matches 0 rows and gets the 409 (the app-level
    check alone raced because autoflush is off and the row isn't locked).

    `inc` is the incident row a caller ALREADY loaded in this same request/transaction —
    the slice routes (trupps/record/capture) read the full blob to merge into anyway, and
    at field blob sizes a second full-row SELECT is ~25–35 ms of pure JSONB re-decode.
    """
    # Validate against this incident's persisted state, including internal slice/capture
    # merges. Never use an observed revision mismatch as permission to skip validation.
    if inc is None:
        inc = await get_incident_or_404(db, incident_id)
    if inc.workspace_rev != body.base_rev:
        raise workspace_revision_conflict(inc.workspace_rev, body.base_rev)
    _scrub_drawing_props(body.workspace)
    # The stored side of the comparison, scrubbed the same way so an unchanged legacy row still
    # compares equal to its scrubbed resubmission. Only the keys validate_alarm_workspace reads
    # are copied: a deepcopy of the whole stored blob (megabytes in the field) per save bought
    # nothing — the scrub mutates, so it must not touch the loaded row itself.
    stored = inc.map_workspace_json if isinstance(inc.map_workspace_json, dict) else {}
    previous = {key: deepcopy(stored[key]) for key in ALARM_VALIDATED_KEYS if key in stored}
    _scrub_drawing_props(previous)
    # The vehicles' `gps` blocks are the SERVER's (app/vehicle_presence): whatever copy a device
    # sends — stale, merged over, or none at all from an older build — the stored one stands.
    keep_server_gps(body.workspace, stored)
    # …and a board object of a kind newer than the saving build is the server's to keep: that
    # build dropped it at load, so its absence here is not a deletion (app/workspace_kinds)
    keep_newer_board_kinds(body.workspace, stored)
    try:
        validate_alarm_workspace(body.workspace, previous)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    result = await execute_dml(
        db,
        update(Incident)
        .where(Incident.id == incident_id, Incident.workspace_rev == body.base_rev)
        .values(
            map_workspace_json=body.workspace,
            workspace_rev=Incident.workspace_rev + 1,
            updated_at=func.now(),
        ),
    )
    if result.rowcount == 0:
        # Read the rev COLUMN, not the row: a full re-SELECT lands on the identity-map copy
        # whose rev still says base_rev (the bump was another transaction's), so the 409 would
        # report server_rev == your_base_rev — and it re-decodes megabytes of JSONB to do it.
        raise workspace_revision_conflict(await _rev(db, incident_id), body.base_rev)
    new_rev = body.base_rev + 1
    # An Atemschutznotfall raised (or ended) by this save is pushed the moment it commits — the
    # 30 s sweep stays the fallback and shares its dedup key (app/push · notify_notfall_changes)
    await push.notify_notfall_changes(db, inc, previous.get("trupps"), body.workspace.get("trupps"))
    # Wake the devices long-polling this incident's workspace — once this transaction commits,
    # so they re-read the blob they are being woken for (see app/live_wait). Whose save it was
    # goes on record first, so the saving device's own poll is not handed back its own blob.
    live_wait.record_write_after_commit(db, incident_id, new_rev, live_wait.writer_id(writer))
    live_wait.notify_after_commit(db, live_wait.workspace_topic(incident_id))
    await audit.snapshot_workspace(db, incident_id=incident_id, workspace=body.workspace)
    # Record the save in the hash chain so workspace changes are replayable/attributable.
    await audit.append_event(
        db,
        incident_id=incident_id,
        op_type="workspace.save",
        source=source,
        user_id=user_id,
        payload={"rev": new_rev},
    )
    return WorkspaceOut(workspace=body.workspace, workspace_rev=new_rev)

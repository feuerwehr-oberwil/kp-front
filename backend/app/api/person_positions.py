"""Live crew positions (`/api/incidents/{id}/positions`) — self-reported, ephemeral.

WHAT THIS IS
------------
A responder opens the Einsatz on their own phone (the Einsatz-Link from the alarm, or a
signed-in session), picks their own name out of the roster once, and the phone starts
reporting where it is. The command post sees a dot per person on the `personen` layer and a
distance next to the name in the Anwesenheit list.

The question it answers is "where is the crew working right now" — someone on a
Wassertransport or a Zubringerleitung is kilometres from the Einsatzort *on purpose*, and
the FU wants to see that they are there rather than phone around to find out. It is not a
compliance tool: nothing here flags, warns about or scores distance.

WRITE-ONLY FOR A LINK SESSION
-----------------------------
The POST and DELETE below are the first (and only) writes on the incident-link allowlist —
see the rationale in `auth/incident_link.py`. The GET is deliberately *not* allowlisted, so
a phone holding a link can report its own position and read nobody else's. That asymmetry is
the whole privacy model of the feature and it is enforced there, not here.

EPHEMERAL, ON PURPOSE
---------------------
One row per (incident, person), overwritten on every update. No history, no hash chain, no
Verlauf entry, nothing in the Rapport. Rows die three ways: the incident is closed
(`api/incidents.close_incident`), the sweep drops them after `position_ttl_hours`
(`scheduler`), or the incident row goes and they cascade.

OFF ON THE PUBLIC DEMO
----------------------
The demo is a URL anyone on the internet can open, populated with fake Musterdorf people.
Real strangers posting real coordinates against those names is a privacy problem with no
upside, so every route here refuses (or empties out) when `identity.demoMode` is set. The
frontend hides the feature on the same flag; neither side relies on the other.
"""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..alarms import is_demo_deployment
from ..auth.capture_limiter import position_limiter
from ..auth.client_ip import client_ip
from ..auth.dependencies import CurrentUser
from ..database import dialect_insert, execute_dml, get_db
from ..models import Incident, Personnel, PersonPosition
from .incidents import INCIDENT_NOT_FOUND, get_incident_or_404

#: A second device claiming a person who is already sharing is refused while the incumbent is
#: still alive. Past that, last claim wins — a responder who swapped phones (or reinstalled)
#: must be able to take their own name back without an operator unsticking it for them.
CLAIM_GRACE = timedelta(seconds=60)


class PositionIn(BaseModel):
    person_id: uuid.UUID
    #: Name as the sharer saw it in the picker; stored as a snapshot.
    display_name: str = Field(min_length=1, max_length=200)
    device_id: str = Field(min_length=8, max_length=64)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracy_m: float | None = Field(default=None, ge=0, le=100_000)
    #: The device's own fix time. Trusted only as display data ("vor 3 min") — it orders
    #: nothing and settles no conflict, so a wrong phone clock is cosmetic.
    ts: datetime


class PositionOut(BaseModel):
    person_id: uuid.UUID
    display_name: str
    lat: float
    lng: float
    accuracy_m: float | None = None
    ts: datetime


router = APIRouter(prefix="/incidents", tags=["positions"])


def _rate_limit(request: Request) -> None:
    # ⚠️ `client_ip`, never the raw first `X-Forwarded-For` hop: that value is client-supplied
    # and used to hand a scripted caller a fresh bucket per request (SEC-08 · auth/client_ip).
    wait = position_limiter.check(client_ip(request))
    if wait:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Zu viele Standort-Meldungen — bitte kurz warten.",
            headers={"Retry-After": str(wait)},
        )


async def _open_incident(db: AsyncSession, incident_id: uuid.UUID) -> Incident:
    """The incident, or 404 — and 404 as well when it is closed or archived.

    Sharing is scoped to a running Einsatz, so a finished one is not "forbidden", it is
    simply no longer a thing a phone can report into. A link session never gets this far
    (`_incident_still_open` refuses first); this covers the signed-in path and the race where
    an Einsatz is closed while a phone is mid-flight.
    """
    inc = await get_incident_or_404(db, incident_id)
    if not inc.is_open:
        # Deliberately the SAME answer as «no such incident»: a phone must not learn from a
        # 403-vs-404 that an Einsatz it may no longer report into exists.
        raise HTTPException(status_code=404, detail=INCIDENT_NOT_FOUND)
    return inc


async def _current_claim(db: AsyncSession, incident_id: uuid.UUID, person_id: uuid.UUID) -> PersonPosition | None:
    """The row this person already holds for this Einsatz — the input to the claim check.

    Its own function so the race it cannot win is testable: whatever this read says, a row may
    exist by the time the write below runs, and that must end in an update rather than a 500.
    """
    return (
        await db.execute(
            select(PersonPosition).where(
                PersonPosition.incident_id == incident_id,
                PersonPosition.person_id == person_id,
            )
        )
    ).scalar_one_or_none()


@router.post(
    "/{incident_id}/positions",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(_rate_limit)],
)
async def put_position(
    incident_id: uuid.UUID,
    body: PositionIn,
    _user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Report where the caller is. Upserts the one row for (incident, person)."""
    if await is_demo_deployment(db):
        raise HTTPException(status_code=403, detail="In der Demo ist Standort teilen deaktiviert.")
    await _open_incident(db, incident_id)

    # `person_id` is a self-declared claim, but it still has to name somebody on the roster.
    # Checked here rather than left to the foreign key so an unknown id is a plain 404 instead
    # of an IntegrityError surfacing as a 500 on the responder's phone.
    known = (await db.execute(select(Personnel.id).where(Personnel.id == body.person_id))).scalar_one_or_none()
    if known is None:
        raise HTTPException(status_code=404, detail="Person nicht gefunden")

    row = await _current_claim(db, incident_id, body.person_id)

    now = datetime.now(UTC)
    if row is not None and row.device_id != body.device_id:
        # Someone else's phone is currently sharing under this name. Refuse while that claim
        # is fresh — two dots' worth of truth for one person is worse than none, and the
        # honest answer belongs on the second phone's screen, not silently in the data.
        held_since = row.updated_at
        if held_since is not None and held_since.tzinfo is None:
            held_since = held_since.replace(tzinfo=UTC)
        if held_since is not None and now - held_since < CLAIM_GRACE:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Dieser Name wird bereits von einem anderen Gerät geteilt.",
            )

    # ONE statement, not read-then-insert. The read above decides the CLAIM (whose name this
    # is); the write must not depend on it still being true a millisecond later. Two reports
    # for the same person arriving together — one phone retrying, or the same person open on
    # two tabs — both saw "no row yet" and both inserted, and the unique index turned the
    # second one into a 500 on somebody's phone mid-Einsatz. INSERT … ON CONFLICT DO UPDATE
    # cannot lose that race: whoever is second updates instead of colliding, and last-write-
    # wins is exactly right for a row that only ever says "here, now".
    insert = dialect_insert(db)
    values = {
        "incident_id": incident_id,
        "person_id": body.person_id,
        "device_id": body.device_id,
        "display_name": body.display_name,
        "lat": body.lat,
        "lng": body.lng,
        "accuracy_m": body.accuracy_m,
        "ts": body.ts,
        "updated_at": now,
    }
    stmt = insert(PersonPosition).values(**values)
    await db.execute(
        stmt.on_conflict_do_update(
            index_elements=["incident_id", "person_id"],
            set_={k: getattr(stmt.excluded, k) for k in values if k not in ("incident_id", "person_id")},
        )
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/{incident_id}/positions/{person_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(_rate_limit)],
)
async def stop_sharing(
    incident_id: uuid.UUID,
    person_id: uuid.UUID,
    user: CurrentUser,
    device: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Stop sharing: delete the row outright so the dot disappears at once.

    Aging out instead would leave a stale dot sitting where someone decided to stop being
    visible, which is the opposite of what they asked for. Always 204 — a row that is already
    gone is the state the caller wanted, and a 404 here would only tell a prober which names
    are currently sharing.

    TWO CALLERS, ONE ROUTE:

    * **The phone that is sharing** passes its own ``device``, and the delete is scoped to that
      row — so one phone can never switch off another's sharing. This is the normal path and the
      only one a link session can reach.
    * **The command post** (an EDITOR, logged in) passes no ``device`` and clears every row for
      that person. Somebody drives home with sharing still on, or a phone dies holding its last
      fix, and the dot sits on the Lage claiming a crew is somewhere they are not. Removing it is
      the operator's job and there was no way to do it.

    An editor deleting a position REMOVES data — it exposes nothing — so this is not a widening
    of who can see what. A viewer without a device gets 403: reading the Lage is not authority
    over what other people reported.
    """
    if await is_demo_deployment(db):
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    if device is None and user.role != "editor":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="editor-required")
    where = [
        PersonPosition.incident_id == incident_id,
        PersonPosition.person_id == person_id,
    ]
    if device is not None:
        where.append(PersonPosition.device_id == device)
    await execute_dml(db, delete(PersonPosition).where(*where))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{incident_id}/positions", response_model=list[PositionOut])
async def list_positions(
    incident_id: uuid.UUID,
    _user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> list[PersonPosition]:
    """The command post's view. NOT on the incident-link allowlist — a phone holding a link
    reaches this route only as a 403 from `enforce_link_scope`, which is the point."""
    if await is_demo_deployment(db):
        return []
    # No age filter here on purpose: a phone that locked at the Wassertransport 40 minutes ago
    # still holds the best answer anyone has to "where is he", and hiding it would read as
    # "nobody is sharing". The client renders the age and degrades the dot (same treatment a
    # stale vehicle gets); the only hard bound is the TTL sweep.
    rows = (
        await db.execute(
            select(PersonPosition)
            .where(PersonPosition.incident_id == incident_id)
            .order_by(PersonPosition.display_name)
        )
    ).scalars()
    return list(rows)

"""The `viewer` account's window onto the Einsätze: the running ones and the last week.

A `viewer` login («Fahrer», 21.10.2026) is a PIN tile shared by every driver and left signed
in on vehicle tablets – the widest credential a station hands out. The tactical picture of a
running Einsatz and the one from last night are what it is for; the archive (Rapporte,
Anwesenheit, names, years back) is not. So a viewer reads an Einsatz while it is open and for
`VIEWER_HISTORY` after it was last closed, and outside that it does not exist for them: 404,
never 403, so the tile cannot be used to probe which Einsätze there were.

Enforced in ONE place for every route: `get_current_user` calls `enforce_viewer_window` after
routing, so any route naming an `incident_id` – or a `media_id`, whose row names its incident –
is checked whatever it reads. `GET /incidents` filters with `viewer_window_clause`, the same
condition in SQL. `editor`, `el`, the deployment admin and link sessions are untouched (links
have their own scope: auth/incident_link).
"""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, Request, status
from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import INCIDENT_ACTIVE_STATUSES, Incident, Media, User, lifecycle_open

#: How long a closed Einsatz stays readable for a viewer, counted from its LAST close.
VIEWER_HISTORY = timedelta(days=7)

_not_found = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Einsatz nicht gefunden")


def is_viewer(user: User) -> bool:
    """A signed-in `viewer` account – not a link guest, which also carries role viewer."""
    return user.role == "viewer" and not getattr(user, "link_kind", None)


def _ended(inc_last_closed: datetime | None, inc_closed: datetime | None, started: datetime) -> datetime:
    # `last_closed_at` is stamped on every close; rows closed before it existed (25.09.2026)
    # only have `closed_at`, and an Einsatz archived without ever being closed has neither.
    end = inc_last_closed or inc_closed or started
    return end if end.tzinfo else end.replace(tzinfo=UTC)  # SQLite hands back naive datetimes


def viewer_window_clause(now: datetime | None = None) -> ColumnElement[bool]:
    """`enforce_viewer_window`'s condition as a WHERE clause, for the Einsatz list."""
    cutoff = (now or datetime.now(UTC)) - VIEWER_HISTORY
    running = and_(Incident.is_archived.is_(False), Incident.status.in_(INCIDENT_ACTIVE_STATUSES))
    return or_(running, func.coalesce(Incident.last_closed_at, Incident.closed_at, Incident.started_at) >= cutoff)


async def enforce_viewer_window(request: Request, db: AsyncSession, user: User) -> None:
    """404 when a viewer's route names an Einsatz outside the window. No-op for everyone else."""
    if not is_viewer(user):
        return
    incident_id = request.path_params.get("incident_id")
    media_id = request.path_params.get("media_id")
    cols = (Incident.is_archived, Incident.status, Incident.last_closed_at, Incident.closed_at, Incident.started_at)
    try:
        if incident_id is not None:
            q = select(*cols).where(Incident.id == uuid.UUID(str(incident_id)))
        elif media_id is not None:
            q = select(*cols).join(Media, Media.incident_id == Incident.id).where(Media.id == uuid.UUID(str(media_id)))
        else:
            return
    except ValueError:
        return  # not a UUID: the route's own validation answers it
    row = (await db.execute(q)).one_or_none()
    if row is None:
        return  # the route's own 404
    archived, state, last_closed, closed, started = row
    if lifecycle_open(archived, state):
        return
    if _ended(last_closed, closed, started) < datetime.now(UTC) - VIEWER_HISTORY:
        raise _not_found

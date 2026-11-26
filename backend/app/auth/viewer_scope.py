"""The `viewer` account's window onto the Einsätze: the running ones and the last few days.

A `viewer` login («Fahrer», 21.10.2026) is a PIN tile shared by every driver and left signed
in on vehicle tablets – the widest credential a station hands out. The tactical picture of a
running Einsatz and the one from last night are what it is for; the archive (Rapporte,
Anwesenheit, names, years back) is not. So a viewer reads an Einsatz while it is open and for
`access.viewerHistoryDays` (default 7, `0` = running only) after it was last closed, and
outside that it does not exist for them: 404, never 403, so the tile cannot be used to probe
which Einsätze there were.

Enforced in ONE place for every route: `get_current_user` calls `enforce_viewer_window` after
routing, so any route naming an `incident_id` – or a `media_id` or print `job_id`, whose row
names its incident – is checked whatever it reads. `GET /incidents` filters with `viewer_window_clause`, the same
condition in SQL. `editor`, `el`, the deployment admin and link sessions are untouched (links
have their own scope: auth/incident_link).
"""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, Request, status
from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..deployment_config import read_config
from ..models import INCIDENT_ACTIVE_STATUSES, Incident, Media, PrintJob, User, lifecycle_open

_not_found = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Einsatz nicht gefunden")
#: the print routes' own «no such job» (api/print_relay)
_job_not_found = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Druckauftrag nicht gefunden")


def is_viewer(user: User) -> bool:
    """A signed-in `viewer` account – not a link guest, which also carries role viewer."""
    return user.role == "viewer" and not getattr(user, "link_kind", None)


async def viewer_history(db: AsyncSession) -> timedelta:
    """`access.viewerHistoryDays` of the stored config. A broken document reads as the default."""
    return timedelta(days=(await read_config(db)).access.viewerHistoryDays)


def _ended(last_closed: datetime | None, closed: datetime | None, started: datetime) -> datetime:
    # `last_closed_at` is stamped on every close; rows closed before it existed (25.09.2026)
    # only have `closed_at`, and an Einsatz archived without ever being closed has neither.
    end = last_closed or closed or started
    return end if end.tzinfo else end.replace(tzinfo=UTC)  # SQLite hands back naive datetimes


def viewer_window_clause(history: timedelta) -> ColumnElement[bool]:
    """`enforce_viewer_window`'s condition as a WHERE clause, for the Einsatz list."""
    running = and_(Incident.is_archived.is_(False), Incident.status.in_(INCIDENT_ACTIVE_STATUSES))
    ended = func.coalesce(Incident.last_closed_at, Incident.closed_at, Incident.started_at)
    return or_(running, ended >= datetime.now(UTC) - history)


async def enforce_viewer_window(request: Request, db: AsyncSession, user: User) -> None:
    """404 when a viewer's route names an Einsatz outside the window. No-op for everyone else."""
    if not is_viewer(user):
        return
    incident_id = request.path_params.get("incident_id")
    media_id = request.path_params.get("media_id")
    # a print job names its Einsatz too: its status carries the Einsatz's file name, and a viewer
    # kept a job id past the window (hunt 24.11.2026, access-control F4)
    job_id = request.path_params.get("job_id")
    cols = (Incident.is_archived, Incident.status, Incident.last_closed_at, Incident.closed_at, Incident.started_at)
    try:
        if incident_id is not None:
            q = select(*cols).where(Incident.id == uuid.UUID(str(incident_id)))
        elif media_id is not None:
            q = select(*cols).join(Media, Media.incident_id == Incident.id).where(Media.id == uuid.UUID(str(media_id)))
        elif job_id is not None:
            q = (
                select(*cols)
                .join(PrintJob, PrintJob.incident_id == Incident.id)
                .where(PrintJob.id == uuid.UUID(str(job_id)))
            )
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
    if _ended(last_closed, closed, started) < datetime.now(UTC) - await viewer_history(db):
        # a print job answers as a missing job – the route's own 404 – so the two bodies cannot
        # tell a viewer which ids exist
        raise _job_not_found if incident_id is None and media_id is None and job_id is not None else _not_found

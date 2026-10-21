"""The `viewer` account's window onto the Einsätze: the running ones and the last few days.

A `viewer` login («Fahrer», 21.10.2026) is a PIN tile shared by every driver and left signed
in on vehicle tablets – the widest credential a station hands out. The tactical picture of a
running Einsatz and the one from last night are what it is for; the archive (Rapporte,
Anwesenheit, names, years back) is not. So a viewer reads an Einsatz while it is open and for
`access.viewerHistoryDays` (default 7, `0` = running only) after it was last closed, and
outside that it does not exist for them: 404, never 403, so the tile cannot be used to probe
which Einsätze there were.

Enforced in ONE place for every route: `get_current_user` calls `enforce_viewer_window` after
routing, so any route naming an `incident_id` – or a `media_id`, whose row names its incident –
is checked whatever it reads. `GET /incidents` filters with `viewer_window_clause`, the same
condition in SQL. `editor`, `el`, the deployment admin and link sessions are untouched (links
have their own scope: auth/incident_link).
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, Request, status
from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import INCIDENT_ACTIVE_STATUSES, DeploymentConfig, Incident, Media, User, lifecycle_open
from ..schemas import AccessConfig, load_stored_config

logger = logging.getLogger(__name__)

_not_found = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Einsatz nicht gefunden")


def is_viewer(user: User) -> bool:
    """A signed-in `viewer` account – not a link guest, which also carries role viewer."""
    return user.role == "viewer" and not getattr(user, "link_kind", None)


async def viewer_history(db: AsyncSession) -> timedelta:
    """`access.viewerHistoryDays` of the stored config. A broken document reads as the default."""
    row = (await db.execute(select(DeploymentConfig.config_json).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    try:
        days = load_stored_config(row or {}).access.viewerHistoryDays
    except Exception:  # noqa: BLE001 — a bad stored row must not 500 every viewer request
        logger.warning("deployment config failed validation — viewer window read as the default", exc_info=True)
        days = AccessConfig().viewerHistoryDays
    return timedelta(days=days)


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
    if _ended(last_closed, closed, started) < datetime.now(UTC) - await viewer_history(db):
        raise _not_found

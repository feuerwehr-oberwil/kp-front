"""incidents.last_closed_at — the LATER close for Einsätze closed twice before the column existed

Hunt 24.11.2026, data-consistency F7. c3e9a1d7f402 gave every existing row its only known close
(`last_closed_at = closed_at`). An Einsatz closed, reopened and closed again BEFORE that migration
kept the first close, and `current_close` trusts a stamped column without reading the audit log:
the Einsatzende, the Einsatzdauer and the end of every open Anwesenheit printed the first close.

This repairs exactly those rows, from the audit log:
- the Einsatz is closed now (`is_archived`) and still stamped with its first close
  (`last_closed_at = closed_at`);
- its `status.change` events show a reopen (`archived: false`) at or after that first close, and
  a server-written close (`archived: true`) after the reopen. The last such close becomes
  `last_closed_at`.
`closed_at` (the first close, which marks the Nachträge) is never touched, nor is a row whose
stamp already differs from it. Idempotent: a repaired row no longer matches.

Undo: the old value was `closed_at`, so `UPDATE incidents SET last_closed_at = closed_at WHERE id
IN (<the ids this migration logs>)` restores it. The downgrade does nothing (it cannot tell a
repaired row from a later correct close).

Revision ID: f3b8d1a6c2e9
Revises: e7a2c5b9d3f1
"""

import json
import logging
from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa

from alembic import op

revision: str = "f3b8d1a6c2e9"
down_revision: str | None = "e7a2c5b9d3f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

log = logging.getLogger("alembic.runtime.migration")

incidents = sa.table(
    "incidents",
    sa.column("id"),
    sa.column("is_archived", sa.Boolean),
    sa.column("closed_at", sa.DateTime(timezone=True)),
    sa.column("last_closed_at", sa.DateTime(timezone=True)),
)
events = sa.table(
    "incident_events",
    sa.column("incident_id"),
    sa.column("seq", sa.BigInteger),
    sa.column("op_type", sa.String),
    sa.column("occurred_at", sa.DateTime(timezone=True)),
    sa.column("payload_json", sa.JSON),
)


def _archived(payload: object) -> bool | None:
    """The `archived` flag of a status.change payload (a dict, or its JSON text), else None."""
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            return None
    flag = payload.get("archived") if isinstance(payload, dict) else None
    return flag if isinstance(flag, bool) else None


def later_close(first: datetime, rows: Sequence[tuple[datetime, object]]) -> datetime | None:
    """The last close after a reopen at or after `first`, from status.change rows in seq order."""
    reopened = False
    found: datetime | None = None
    for at, payload in rows:
        flag = _archived(payload)
        if flag is False and at >= first:
            reopened = True
        elif flag is True and reopened and at > first:
            found = at
    return found


def upgrade() -> None:
    conn = op.get_bind()
    stale = (
        sa.select(incidents.c.id, incidents.c.closed_at)
        .where(
            incidents.c.is_archived.is_(True),
            incidents.c.closed_at.is_not(None),
            incidents.c.last_closed_at == incidents.c.closed_at,
        )
        .subquery()
    )
    rows = conn.execute(
        sa.select(stale.c.id, stale.c.closed_at, events.c.occurred_at, events.c.payload_json)
        .join(events, events.c.incident_id == stale.c.id)
        .where(events.c.op_type == "status.change")
        .order_by(stale.c.id, events.c.seq)
    ).all()
    by_incident: dict[object, tuple[datetime, list[tuple[datetime, object]]]] = {}
    for inc_id, first, at, payload in rows:
        by_incident.setdefault(inc_id, (first, []))[1].append((at, payload))
    repaired = []
    for inc_id, (first, history) in by_incident.items():
        close = later_close(first, history)
        if close is not None:
            conn.execute(
                sa.update(incidents)
                .where(incidents.c.id == inc_id, incidents.c.last_closed_at == incidents.c.closed_at)
                .values(last_closed_at=close)
            )
            repaired.append(str(inc_id))
    log.info("last_closed_at backfill: %d incident(s) repaired %s", len(repaired), repaired)


def downgrade() -> None:
    pass

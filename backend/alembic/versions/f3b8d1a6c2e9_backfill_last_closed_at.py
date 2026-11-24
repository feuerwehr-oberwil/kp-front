"""incidents.last_closed_at — the LATER close for Einsätze stamped with their first one

Hunt 24.11.2026, data-consistency F7. c3e9a1d7f402 gave every existing row its only known close
(`last_closed_at = closed_at`). An Einsatz closed, reopened and closed again BEFORE that migration
kept the first close, and `current_close` trusts a stamped column without reading the audit log:
the Einsatzende, the Einsatzdauer and the end of every open Anwesenheit printed the first close.
(The same holds for a FireHub «Einsatzende», which stamps `closed_at` while the card stays open,
followed by the real close.)

This repairs exactly those rows, from the audit log:
- the Einsatz is closed now (archived, or a status outside «offen»/«in_arbeit» – the app's rule,
  models.lifecycle_open) and still stamped with its first close (`last_closed_at = closed_at`);
- replaying its SERVER-written `status.change` events in `seq` order (source «status»; `archived`
  and the status `to`), the last open → closed transition lies more than a minute after
  `closed_at` (a close event and its stamp differ by milliseconds). That transition, floored at
  `closed_at` as current_close does, becomes `last_closed_at`.
`closed_at` (the first close, which marks the Nachträge) is never touched, nor is a row whose
stamp already differs from it. The UPDATE re-checks both conditions, so a row a still-serving
old process reopens or closes meanwhile is left alone. Idempotent: a repaired row no longer
matches.

Undo: the migration logs each repaired id with its new stamp; `UPDATE incidents SET
last_closed_at = closed_at WHERE id = <id> AND last_closed_at = <new stamp>` restores one without
touching a later genuine close. The downgrade does nothing.

Revision ID: f3b8d1a6c2e9
Revises: e7a2c5b9d3f1
"""

import json
import logging
from collections.abc import Sequence
from datetime import datetime, timedelta

import sqlalchemy as sa

from alembic import op

revision: str = "f3b8d1a6c2e9"
down_revision: str | None = "e7a2c5b9d3f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

log = logging.getLogger("alembic.runtime.migration")

#: models.INCIDENT_ACTIVE_STATUSES, frozen here – a migration must not import the app
ACTIVE = ("offen", "in_arbeit")
#: a close event and the stamp it wrote differ by milliseconds; a real later close by minutes
SAME_CLOSE = timedelta(minutes=1)

incidents = sa.table(
    "incidents",
    sa.column("id"),
    sa.column("is_archived", sa.Boolean),
    sa.column("status", sa.String),
    sa.column("closed_at", sa.DateTime(timezone=True)),
    sa.column("last_closed_at", sa.DateTime(timezone=True)),
)
events = sa.table(
    "incident_events",
    sa.column("incident_id"),
    sa.column("seq", sa.BigInteger),
    sa.column("source", sa.String),
    sa.column("op_type", sa.String),
    sa.column("occurred_at", sa.DateTime(timezone=True)),
    sa.column("payload_json", sa.JSON),
)


def _payload(raw: object) -> dict:
    """A status.change payload as a dict (JSONB hands one back, SQLite its JSON text)."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    return raw if isinstance(raw, dict) else {}


def last_close(rows: Sequence[tuple[datetime, object]]) -> datetime | None:
    """When the last open → closed transition happened, replaying status.change rows in seq order
    from an open Einsatz – both lifecycle fields, as models.lifecycle_open reads them."""
    archived, status = False, ACTIVE[0]
    found: datetime | None = None
    for at, raw in rows:
        p = _payload(raw)
        was_open = not archived and status in ACTIVE
        if isinstance(p.get("archived"), bool):
            archived = p["archived"]
        if isinstance(p.get("to"), str):
            status = p["to"]
        if was_open and not (not archived and status in ACTIVE):
            found = at
    return found


def _closed():
    return sa.or_(incidents.c.is_archived.is_(True), incidents.c.status.not_in(ACTIVE))


def upgrade() -> None:
    conn = op.get_bind()
    stale = (
        sa.select(incidents.c.id, incidents.c.closed_at)
        .where(_closed(), incidents.c.closed_at.is_not(None), incidents.c.last_closed_at == incidents.c.closed_at)
        .subquery()
    )
    rows = conn.execute(
        sa.select(stale.c.id, stale.c.closed_at, events.c.occurred_at, events.c.payload_json)
        .join(events, events.c.incident_id == stale.c.id)
        .where(events.c.op_type == "status.change", events.c.source == "status")
        .order_by(stale.c.id, events.c.seq)
    ).all()
    by_incident: dict[object, tuple[datetime, list[tuple[datetime, object]]]] = {}
    for inc_id, first, at, payload in rows:
        by_incident.setdefault(inc_id, (first, []))[1].append((at, payload))
    repaired: list[str] = []
    for inc_id, (first, history) in by_incident.items():
        close = last_close(history)
        if close is None or close - first <= SAME_CLOSE:
            continue
        done = conn.execute(
            sa.update(incidents)
            .where(incidents.c.id == inc_id, _closed(), incidents.c.last_closed_at == incidents.c.closed_at)
            .values(last_closed_at=close)
        )
        if done.rowcount == 1:
            repaired.append(f"{inc_id}={close.isoformat()}")
    log.info("last_closed_at backfill: %d incident(s) repaired %s", len(repaired), repaired)


def downgrade() -> None:
    pass

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
  and the status `to`; the events of ONE transaction – same `recorded_at` – as one step, so a
  PATCH that writes two rows never looks briefly open), the history PROVES a later close: a
  second open → closed transition (closed, reopened, closed again), or a close after a FireHub
  «Einsatzende» that stamped `closed_at` first. The last such close, floored at `closed_at` as
  current_close does, becomes `last_closed_at`. A lone close with no such evidence is left as
  it is, however far its event lies from the stamp.
`closed_at` (the first close, which marks the Nachträge) is never touched, nor is a row whose
stamp already differs from it. The candidate rows are locked (FOR UPDATE) before their history
is read, and the UPDATE re-checks both conditions, so a still-serving old process cannot slip a
reopen or close in between. Idempotent: a repaired row no longer matches.

Undo: the migration logs each repaired id with its new stamp; `UPDATE incidents SET
last_closed_at = closed_at WHERE id = <id> AND last_closed_at = <new stamp>` restores one without
touching a later genuine close. The downgrade does nothing.

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

#: models.INCIDENT_ACTIVE_STATUSES, frozen here – a migration must not import the app
ACTIVE = ("offen", "in_arbeit")

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
    sa.column("recorded_at", sa.DateTime(timezone=True)),
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


def later_close(rows: Sequence[tuple[datetime, datetime | None, object]]) -> datetime | None:
    """The close the history PROVES came after the first one, else None – from (occurred_at,
    recorded_at, payload) status.change rows in seq order, replayed from an open Einsatz with both
    lifecycle fields as models.lifecycle_open reads them. Rows sharing a recorded_at are one
    transaction and one step."""
    archived, status = False, ACTIVE[0]
    closes: list[datetime] = []
    firehub_first = False
    i = 0
    while i < len(rows):
        # one transaction = the rows with this recorded_at (an unknown one is a step of its own)
        j = i + 1
        while j < len(rows) and rows[i][1] is not None and rows[j][1] == rows[i][1]:
            j += 1
        was_open = not archived and status in ACTIVE
        for _at, _rec, raw in rows[i:j]:
            p = _payload(raw)
            if isinstance(p.get("archived"), bool):
                archived = p["archived"]
            if isinstance(p.get("to"), str):
                status = p["to"]
            if p.get("source") == "firehub" and p.get("einsatzende") and not closes:
                firehub_first = True
        if was_open and not (not archived and status in ACTIVE):
            closes.append(rows[j - 1][0])
        i = j
    if len(closes) >= 2 or (closes and firehub_first):
        return closes[-1]
    return None


def _closed():
    return sa.or_(incidents.c.is_archived.is_(True), incidents.c.status.not_in(ACTIVE))


def upgrade() -> None:
    conn = op.get_bind()
    candidates = sa.and_(
        _closed(), incidents.c.closed_at.is_not(None), incidents.c.last_closed_at == incidents.c.closed_at
    )
    # locked first, so nothing reopens or closes them between reading the history and the UPDATE
    stale = dict(
        conn.execute(
            sa.select(incidents.c.id, incidents.c.closed_at)
            .where(candidates)
            .order_by(incidents.c.id)
            .with_for_update()
        ).all()
    )
    if not stale:
        log.info("last_closed_at backfill: 0 incident(s) repaired []")
        return
    history: dict[object, list[tuple[datetime, datetime | None, object]]] = {}
    for inc_id, at, recorded, payload in conn.execute(
        sa.select(events.c.incident_id, events.c.occurred_at, events.c.recorded_at, events.c.payload_json)
        .where(events.c.incident_id.in_(list(stale)), events.c.op_type == "status.change", events.c.source == "status")
        .order_by(events.c.incident_id, events.c.seq)
    ):
        history.setdefault(inc_id, []).append((at, recorded, payload))
    repaired: list[str] = []
    for inc_id, rows in history.items():
        close = later_close(rows)
        first = stale[inc_id]
        if close is None or close <= first:
            continue
        done = conn.execute(
            sa.update(incidents).where(incidents.c.id == inc_id, candidates).values(last_closed_at=close)
        )
        if done.rowcount == 1:
            repaired.append(f"{inc_id}={close.isoformat()}")
    log.info("last_closed_at backfill: %d incident(s) repaired %s", len(repaired), repaired)


def downgrade() -> None:
    pass

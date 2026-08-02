"""incidents.started_at_source + divera_emergencies.ts_create — where the alarm time came from

``started_at`` is published as the Alarmierungszeit (docs/STATS-EXPORT.md), but until now no
intake path except the generic ``POST /api/alarms`` ever set it: the Divera webhook, the
poller's auto-open and the pool take all let ``server_default=func.now()`` stand, so the
column held «when the record was opened», minutes to days after the alarm.

Two additive NULLable columns, and one bounded data repair:

* ``divera_emergencies.ts_create`` — Divera's own creation stamp for the alarm. It was
  already parsed at intake and already stored verbatim inside ``raw_payload_json``; it was
  simply never promoted to a column. Backfilled from that payload, so no alarm time that
  ever reached this deployment is lost.
* ``incidents.started_at_source`` — ``'alarm'`` / ``'manual'`` / NULL. **NULL is the honest
  answer, not a missing one:** it says the value is the row's insert time and must not be
  read as an alarm time. Everything already in the table starts NULL.
* Incidents opened from a Divera alarm whose ``ts_create`` survives in the pool row get
  ``started_at`` corrected to it and are marked ``'alarm'``. This is a RECOVERY, not a
  guess — the value is the alarm's own timestamp as the dispatcher's system stated it, and
  it is the same value the fixed code path would have written. Rows without a recoverable
  stamp are left exactly as they are, with NULL provenance saying so.

Both repairs are deliberately narrow. The Divera one needs a 1:1 pool row, a non-null
``ts_create``, and an existing ``started_at`` LATER than the alarm — a record can be opened
after an alarm, never before, so an earlier value means a human already backdated it and
theirs wins. The provenance-only one keys on ``started_at <> created_at``, which is a proof
rather than a heuristic (see step 3). Nothing is matched by resemblance or by time window,
and no row's alarm time is ever invented: a self-hoster whose alarms carried no stamp gets
NULL everywhere, which reads as «this deployment has no alarm times before today» and is the
truth.

Revision ID: f4a5b6c7d8e9
Revises: d2e3f4a5b6c7
Create Date: 2026-08-02 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f4a5b6c7d8e9"
down_revision: str | None = "d2e3f4a5b6c7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("divera_emergencies", sa.Column("ts_create", sa.BigInteger(), nullable=True))
    op.add_column("incidents", sa.Column("started_at_source", sa.String(length=8), nullable=True))

    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        # SQLite (the test harness) builds the schema from metadata and holds no production
        # rows; the JSON-extract repair below is postgres-only syntax and has nothing to do.
        return

    # 1. Promote the alarm stamp we already had out of the raw payload.
    op.execute(
        """
        UPDATE divera_emergencies
           SET ts_create = (raw_payload_json ->> 'ts_create')::bigint
         WHERE ts_create IS NULL
           AND raw_payload_json ->> 'ts_create' ~ '^[0-9]+$'
        """
    )

    # 2. Correct the incidents that inherited an insert-time «alarm time» from that alarm.
    #    Joined on the pool row's own taken_incident_id (the take/auto-open link) — never on a
    #    time window, so nothing is matched by resemblance.
    op.execute(
        """
        UPDATE incidents AS i
           SET started_at = to_timestamp(e.ts_create),
               started_at_source = 'alarm'
          FROM divera_emergencies AS e
         WHERE e.taken_incident_id = i.id
           AND e.ts_create IS NOT NULL
           AND e.ts_create > 0
           AND i.started_at_source IS NULL
           AND i.started_at > to_timestamp(e.ts_create)
        """
    )

    # 3. Rows whose started_at was written EXPLICITLY keep their provenance too. This is a
    #    proof, not an inference: both columns default to now(), which is transaction-stable
    #    in postgres, so a defaulted row has started_at = created_at to the microsecond.
    #    started_at <> created_at therefore means somebody or something set it on purpose —
    #    before this migration the only writers were the Einsatz-Wizard, the Einsatzdaten
    #    correction (both human) and the generic `POST /api/alarms` payload (the sender).
    #    That is what recovers the handful of records a human had already backdated.
    op.execute(
        """
        UPDATE incidents
           SET started_at_source = CASE WHEN source IN ('manual', 'divera') THEN 'manual' ELSE 'alarm' END
         WHERE started_at_source IS NULL
           AND created_at IS NOT NULL
           AND started_at <> created_at
        """
    )


def downgrade() -> None:
    # started_at is not restored: the pre-upgrade value was the record-open time that this
    # migration exists to replace, and ts_create — the value it was replaced with — stays
    # readable in raw_payload_json either way.
    op.drop_column("incidents", "started_at_source")
    op.drop_column("divera_emergencies", "ts_create")

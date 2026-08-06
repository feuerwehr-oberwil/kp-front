"""incidents.alarm_origin — where the alarm came in from

One additive NULLable column. No backfill, and none is possible: the alerting system only
began sending an origin with this change, so every existing row genuinely has no answer.

WHY THE COLUMN EXISTS
---------------------
An alerting system's sender allowlist can hold more than the dispatch centre. At the
deployment this was built for it holds ten numbers — one landline and nine mobiles — so a
dispatch from the Alarmzentrale and an SMS a member sent by hand are equally allowlisted and,
until now, indistinguishable once they arrive here. That distinction is what lets a consumer
decide whether an Einsatz may reach a public surface, so it is worth recording at intake
rather than reconstructing later, which cannot be done at all.

WHAT NULL MEANS
---------------
«Nobody told us», not «suspicious». It is what an unlabelled allowlist entry produces, what a
fallback relay handling an alarm during an outage produces (it cannot reach this app), and
what every deployment whose alerting system sends no origin produces. Consumers must treat it
as unknown, never as a negative answer.

The column is written once and never updated — see the note on the model. That is enforced in
the milestones endpoint rather than by a constraint, because «first writer wins» is not
something a CHECK can express.

Revision ID: d9e0f1a2b3c4
Revises: a7f19c3b04e2
Create Date: 2026-08-06 16:20:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d9e0f1a2b3c4"
down_revision: str | None = "a7f19c3b04e2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("incidents", sa.Column("alarm_origin", sa.String(length=32), nullable=True))


def downgrade() -> None:
    op.drop_column("incidents", "alarm_origin")

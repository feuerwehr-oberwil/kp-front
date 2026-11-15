"""«Alarm aktualisiert»: the pending Divera update of an open Einsatz

Revision ID: e7a2c5b9d3f1
Revises: d5f9b3a7c1e2
Create Date: 2026-11-15 12:00:00.000000

One nullable JSONB column, `incidents.alarm_update_json` (app/alarm_update): a follow-up of the
alarm an Einsatz was opened from waits there for the crew instead of being thrown away. Starts
NULL on every row; nothing to backfill.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "e7a2c5b9d3f1"
down_revision: str | None = "d5f9b3a7c1e2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("incidents", sa.Column("alarm_update_json", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("incidents", "alarm_update_json")

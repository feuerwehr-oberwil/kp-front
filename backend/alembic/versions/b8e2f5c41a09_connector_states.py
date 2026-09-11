"""Connector health: one state row per polling connector

Additive and empty on arrival — the rows are written by the jobs themselves, the first time
each one has something to report. A deployment that uses none of the three connectors keeps an
empty table forever.

The row is a REPORT, not a resume point: nothing reads it back to decide what to do next
(unlike `sharepoint_sync_state`, which carries the delta token), so dropping it costs a line on
the admin System card and nothing operational.

Revision ID: b8e2f5c41a09
Revises: a5c1d8e34f70
Create Date: 2026-09-11 09:40:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "b8e2f5c41a09"
down_revision: str | None = "a5c1d8e34f70"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "connector_states",
        sa.Column("name", sa.String(length=32), primary_key=True),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("detail", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("connector_states")

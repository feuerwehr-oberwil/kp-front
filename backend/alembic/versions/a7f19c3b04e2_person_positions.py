"""person_positions — self-reported live location of one crew member per incident

One row per (incident, person), overwritten on every update; no history. Cascades with the
incident, and the application deletes the rows when the Einsatz is closed.

Revision ID: a7f19c3b04e2
Revises: c7d8e9f0a1b2
Create Date: 2026-08-05 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "a7f19c3b04e2"
down_revision: str | None = "c7d8e9f0a1b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "person_positions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "incident_id",
            UUID(as_uuid=True),
            sa.ForeignKey("incidents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "person_id",
            UUID(as_uuid=True),
            sa.ForeignKey("personnel.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("device_id", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("lat", sa.Numeric(10, 7), nullable=False),
        sa.Column("lng", sa.Numeric(10, 7), nullable=False),
        sa.Column("accuracy_m", sa.Numeric(8, 1), nullable=True),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("incident_id", "person_id", name="uq_person_positions_incident_person"),
    )
    op.create_index("ix_person_positions_incident_id", "person_positions", ["incident_id"])


def downgrade() -> None:
    op.drop_index("ix_person_positions_incident_id", table_name="person_positions")
    op.drop_table("person_positions")

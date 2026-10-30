"""restore print_jobs – the station print relay is back

Revision ID: e5a7c9d1b3f6
Revises: d4f8b2e6a1c9
Create Date: 2026-10-30 18:00:00.000000

`d3e6a9c2f5b8` dropped the queue on the claim that prod had never printed through it (0 rows on
08.10.2026). That count could not show use: the scheduler sweeps every job after 7 days. The
station agent's own log has 18 KP Front jobs printed between 25.08. and 16.09.2026. This
recreates the table exactly as `d3e6a9c2f5b8`'s downgrade does. The agent secret that migration
deleted is not restored – it is pasted again at /admin → Anbindungen (or set as
`PRINT_AGENT_SECRET`).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e5a7c9d1b3f6"
down_revision: str | None = "d4f8b2e6a1c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "print_jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("incident_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("pdf", sa.LargeBinary(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("requested_by", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("color", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.ForeignKeyConstraint(["incident_id"], ["incidents.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requested_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_print_jobs_incident_id"), "print_jobs", ["incident_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_print_jobs_incident_id"), table_name="print_jobs")
    op.drop_table("print_jobs")

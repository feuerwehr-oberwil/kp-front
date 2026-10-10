"""drop print_jobs — the station print relay is gone

KP Front no longer queues PDFs for an on-site print agent: the Rapport and the Zeitplan are
downloaded and printed through the device's own print dialog. The queue table goes, and so does
the agent secret a station may have pasted into /admin (an `integration_credentials` row nothing
reads any more). Prod had never queued a job (0 rows, 08.10.2026).

The downgrade recreates the empty table as `c2d3e4f5a6b7` left it; the deleted secret is not
restored — it is re-pasted in /admin if anyone ever goes back.

Revision ID: d3e6a9c2f5b8
Revises: f9b8c7d6e5a4
Create Date: 2026-10-09 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d3e6a9c2f5b8"
down_revision: str | None = "f9b8c7d6e5a4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index(op.f("ix_print_jobs_incident_id"), table_name="print_jobs")
    op.drop_table("print_jobs")
    op.execute("DELETE FROM integration_credentials WHERE name = 'print_agent_secret'")


def downgrade() -> None:
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

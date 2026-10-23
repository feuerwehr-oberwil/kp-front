"""drop incident_notes and reference_datasets.fetch_interval – both dead since the initial schema

Revision ID: d4f8b2e6a1c9
Revises: c3e7a1d9b5f2
Create Date: 2026-10-23 10:00:00.000000

Sweep C.7/C.8 (23.10.2026): the `incident_notes` table (model `IncidentNote`) and the
`reference_datasets.fetch_interval` column came with the initial schema and never got a reader
or a writer – no module, no raw SQL, no client. Every backup, restore drill and `alembic check`
carried them. Both are empty by construction; the downgrade recreates them empty.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d4f8b2e6a1c9"
down_revision: str | None = "c3e7a1d9b5f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index(op.f("ix_incident_notes_incident_id"), table_name="incident_notes")
    op.drop_table("incident_notes")
    op.drop_column("reference_datasets", "fetch_interval")


def downgrade() -> None:
    op.add_column("reference_datasets", sa.Column("fetch_interval", sa.Text(), nullable=True))
    op.create_table(
        "incident_notes",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("incident_id", sa.UUID(), nullable=False),
        sa.Column("author_id", sa.UUID(), nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("text", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["incident_id"], ["incidents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_incident_notes_incident_id"), "incident_notes", ["incident_id"], unique=False)

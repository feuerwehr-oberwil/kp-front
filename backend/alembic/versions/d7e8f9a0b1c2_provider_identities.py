"""provider-neutral personnel identities and incident provenance backfill

Revision ID: d7e8f9a0b1c2
Revises: c6d7e8f9a0b1
Create Date: 2026-07-15 16:10:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "d7e8f9a0b1c2"
down_revision: str | None = "c6d7e8f9a0b1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "personnel_external_identities",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("personnel_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("external_id", sa.Text(), nullable=False),
        sa.Column("metadata_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("synced_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["personnel_id"], ["personnel.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider", "external_id", name="uq_personnel_external_provider_id"),
        sa.UniqueConstraint("personnel_id", "provider", name="uq_personnel_external_person_provider"),
    )
    op.create_index("ix_personnel_external_personnel_id", "personnel_external_identities", ["personnel_id"])
    op.execute(
        """
        INSERT INTO personnel_external_identities
            (id, personnel_id, provider, external_id, synced_at, created_at, updated_at)
        SELECT gen_random_uuid(), id, 'divera', divera_id::text, now(), now(), now()
        FROM personnel
        WHERE divera_id IS NOT NULL
        ON CONFLICT (provider, external_id) DO NOTHING
        """
    )
    op.execute(
        """
        UPDATE incidents
        SET source_ref = divera_id::text
        WHERE source = 'divera' AND divera_id IS NOT NULL AND source_ref IS NULL
        """
    )


def downgrade() -> None:
    op.drop_index("ix_personnel_external_personnel_id", table_name="personnel_external_identities")
    op.drop_table("personnel_external_identities")


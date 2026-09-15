"""plan_page_floors — one page of a plan revision is one Geschoss

Gebäude ↔ Geschossplan ↔ Karte (14.09.2026): a Modul-6 PDF carries its floors either one
per page or as regions of one A0/A1 sheet; the station gives each floor a stable signed index,
an optional name, its page, and – for a region – a clip rectangle and a join to the floor
it meets (one point pair: the same staircase on both drawings). The
rows are keyed by the exact revision, so an incident that pinned a version keeps that
version's floors. Nothing is migrated — every existing revision simply has no floors.

Revision ID: d3e7f19a2c45
Revises: b2f61c8d5e30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d3e7f19a2c45"
down_revision: str | None = "b2f61c8d5e30"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "plan_page_floors",
        sa.Column("dataset_id", sa.Text(), primary_key=True),
        sa.Column("plan_version", sa.Integer(), primary_key=True),
        sa.Column("floor_index", sa.Integer(), primary_key=True),
        sa.Column("page", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("floor_name", sa.String(length=80), nullable=True),
        sa.Column("clip", postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite"), nullable=True),
        sa.Column("join", postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["dataset_id", "plan_version"], ["plan_revisions.dataset_id", "plan_revisions.version"]
        ),
    )


def downgrade() -> None:
    op.drop_table("plan_page_floors")

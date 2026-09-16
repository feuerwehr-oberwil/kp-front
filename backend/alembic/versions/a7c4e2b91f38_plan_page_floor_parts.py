"""plan_page_floors.part — one Geschoss may be drawn in several pieces

16.09.2026: a large building's 1. OG can exist as two separate drawings (one per wing), so a
storey is no longer one row. ``part`` numbers the drawings of one storey (0 = the first, and the
only one on every pack that exists today), each with its own ``clip`` and its own ``join``, and
becomes part of the key. Nothing is migrated — every existing row is part 0.

Revision ID: a7c4e2b91f38
Revises: f5b3a91d7e24
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7c4e2b91f38"
down_revision: str | None = "f5b3a91d7e24"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("plan_page_floors", sa.Column("part", sa.Integer(), nullable=False, server_default="0"))
    # the key grows by one column; every existing row keeps the identity it had (part 0)
    op.drop_constraint("plan_page_floors_pkey", "plan_page_floors", type_="primary")
    op.create_primary_key(
        "plan_page_floors_pkey", "plan_page_floors", ["dataset_id", "plan_version", "floor_index", "part"]
    )


def downgrade() -> None:
    # a storey drawn in several pieces cannot survive a key that holds one row per storey
    op.execute(sa.text("DELETE FROM plan_page_floors WHERE part <> 0"))
    op.drop_constraint("plan_page_floors_pkey", "plan_page_floors", type_="primary")
    op.create_primary_key("plan_page_floors_pkey", "plan_page_floors", ["dataset_id", "plan_version", "floor_index"])
    op.drop_column("plan_page_floors", "part")

"""plan_page_floors.marker — what the PDF's own § markers proposed for this floor

Plan markers (15.09.2026): a Modul-6 export can declare its own storeys, regions, join points
and map fit as ``§`` text spans, and the alignment worker turns them into the floor pack. For
the NEXT export to follow the markers where they moved and still keep the name or the region an
admin corrected, each row records the proposal it was born from. NULL is every existing row and
every pack assembled by hand — which reads, correctly, as «all of this is the admin's».

Revision ID: a7d41f0c9b63
Revises: d3e7f19a2c45
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a7d41f0c9b63"
down_revision: str | None = "d3e7f19a2c45"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "plan_page_floors",
        sa.Column("marker", postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite"), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("plan_page_floors", "marker")

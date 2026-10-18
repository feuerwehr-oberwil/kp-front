"""object_visits.target_kind / lat / lng — a visit at a place, and where every visit was

Revision ID: b7c4d2e9f1a3
Revises: a1f5b2c3d4e5
Create Date: 2026-10-16 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b7c4d2e9f1a3"
down_revision: str | None = "a1f5b2c3d4e5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # every visit so far was at a catalogue object
    op.add_column(
        "object_visits",
        sa.Column("target_kind", sa.String(length=16), nullable=False, server_default="object"),
    )
    op.add_column("object_visits", sa.Column("lat", sa.Float(), nullable=True))
    op.add_column("object_visits", sa.Column("lng", sa.Float(), nullable=True))
    # the object visits on record take their object's position as it stands today (the documents
    # themselves stay untouched: a revision is immutable)
    op.execute(
        """
        UPDATE object_visits
           SET lat = (SELECT CAST(o.lat AS FLOAT) FROM objects o WHERE o.id = object_visits.object_id),
               lng = (SELECT CAST(o.lng AS FLOAT) FROM objects o WHERE o.id = object_visits.object_id)
         WHERE object_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_column("object_visits", "lng")
    op.drop_column("object_visits", "lat")
    op.drop_column("object_visits", "target_kind")

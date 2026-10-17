"""objects: a station-set position, the outline choice, the town; object_position_events

Revision ID: b2d6e8f1a3c7
Revises: a1f5b2c3d4e5
Create Date: 2026-10-17 16:00:00.000000

«Lage korrigieren» (Karte & Objekte review round 2): the station moves an object's pin in
/admin and picks how its outline is drawn. ``position_source = 'station'`` marks a position no
import, push or footprint job may overwrite; ``outline`` is ``building`` / ``none`` (NULL = the
automatic rule); ``locality`` is the town when it is not the home town («Therwil»). Every
correction is appended to ``object_position_events`` (before/after), the undo reads it back.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "b2d6e8f1a3c7"
down_revision: str | None = "a1f5b2c3d4e5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("objects", sa.Column("locality", sa.Text(), nullable=True))
    op.add_column("objects", sa.Column("position_source", sa.String(length=16), nullable=True))
    op.add_column("objects", sa.Column("position_set_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("objects", sa.Column("outline", sa.String(length=16), nullable=True))
    op.create_table(
        "object_position_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("object_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("action", sa.String(length=24), nullable=False),
        sa.Column("actor", sa.Text(), nullable=True),
        sa.Column("before", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("after", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["object_id"], ["objects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_object_position_events_object_id", "object_position_events", ["object_id"])


def downgrade() -> None:
    op.drop_index("ix_object_position_events_object_id", table_name="object_position_events")
    op.drop_table("object_position_events")
    op.drop_column("objects", "outline")
    op.drop_column("objects", "position_set_at")
    op.drop_column("objects", "position_source")
    op.drop_column("objects", "locality")

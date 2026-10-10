"""objects.measures / remarks / measures_source — an Einsatzobjekt's Sofortmassnahmen + Bemerkungen

Revision ID: a1f5b2c3d4e5
Revises: a1d2e3f4b5c6
Create Date: 2026-10-09 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a1f5b2c3d4e5"
down_revision: str | None = "a1d2e3f4b5c6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # both nullable, no default: an object nobody wrote measures for has none (the card shows
    # nothing then, rather than an empty heading)
    op.add_column("objects", sa.Column("measures", sa.Text(), nullable=True))
    op.add_column("objects", sa.Column("remarks", sa.Text(), nullable=True))
    op.add_column("objects", sa.Column("measures_source", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("objects", "measures_source")
    op.drop_column("objects", "remarks")
    op.drop_column("objects", "measures")

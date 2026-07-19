"""incident is_exercise — Übungen: stats-excluded, hard-deletable

Revision ID: c6d7e8f9a0b1
Revises: b5c6d7e8f9a0
Create Date: 2026-07-14 21:30:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = 'c6d7e8f9a0b1'
down_revision: str | None = 'b5c6d7e8f9a0'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'incidents',
        sa.Column('is_exercise', sa.Boolean(), nullable=False, server_default='false'),
    )


def downgrade() -> None:
    op.drop_column('incidents', 'is_exercise')

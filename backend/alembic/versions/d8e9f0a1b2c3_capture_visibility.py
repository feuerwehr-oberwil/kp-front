"""incident cross-visibility — editor-opened latch + capture write counters

Revision ID: d8e9f0a1b2c3
Revises: c2d3e4f5a6b7
Create Date: 2026-07-18 21:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = 'd8e9f0a1b2c3'
down_revision: str | None = 'c2d3e4f5a6b7'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('incidents', sa.Column('editor_opened_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('incidents', sa.Column('capture_writes', sa.Integer(), server_default='0', nullable=False))
    op.add_column('incidents', sa.Column('capture_last_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('incidents', 'capture_last_at')
    op.drop_column('incidents', 'capture_writes')
    op.drop_column('incidents', 'editor_opened_at')

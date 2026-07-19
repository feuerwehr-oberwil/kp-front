"""personnel roster fields (funktion, einheit, default_funkkanal)

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-06-27 12:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = 'd4e5f6a7b8c9'
down_revision: str | None = 'c3d4e5f6a7b8'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('personnel', sa.Column('funktion', sa.Text(), nullable=True))
    op.add_column('personnel', sa.Column('einheit', sa.Text(), nullable=True))
    op.add_column('personnel', sa.Column('default_funkkanal', sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column('personnel', 'default_funkkanal')
    op.drop_column('personnel', 'einheit')
    op.drop_column('personnel', 'funktion')

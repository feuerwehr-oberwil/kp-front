"""drop dead personnel roster fields (funktion, einheit, default_funkkanal)

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-06-27 14:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = 'e5f6a7b8c9d0'
down_revision: str | None = 'd4e5f6a7b8c9'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column('personnel', 'default_funkkanal')
    op.drop_column('personnel', 'einheit')
    op.drop_column('personnel', 'funktion')


def downgrade() -> None:
    op.add_column('personnel', sa.Column('funktion', sa.Text(), nullable=True))
    op.add_column('personnel', sa.Column('einheit', sa.Text(), nullable=True))
    op.add_column('personnel', sa.Column('default_funkkanal', sa.Integer(), nullable=True))

"""deployment_config stats_secret — read-only statistics-export token

Revision ID: b5c6d7e8f9a0
Revises: a3b4c5d6e7f9
Create Date: 2026-07-13 22:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = 'b5c6d7e8f9a0'
down_revision: str | None = 'a3b4c5d6e7f9'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('deployment_config', sa.Column('stats_secret', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('deployment_config', 'stats_secret')

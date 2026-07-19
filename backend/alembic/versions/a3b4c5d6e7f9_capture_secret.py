"""deployment_config capture_secret — station-level Erfassungs-Poster token

Revision ID: a3b4c5d6e7f9
Revises: f2a3b4c5d6e7
Create Date: 2026-07-08 17:30:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = 'a3b4c5d6e7f9'
down_revision: str | None = 'f2a3b4c5d6e7'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('deployment_config', sa.Column('capture_secret', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('deployment_config', 'capture_secret')

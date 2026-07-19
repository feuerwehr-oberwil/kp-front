"""incident report_done_at — Abschluss-Assistent completion bookmark

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
Create Date: 2026-07-08 16:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = 'f2a3b4c5d6e7'
down_revision: str | None = 'e1f2a3b4c5d6'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('incidents', sa.Column('report_done_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('incidents', 'report_done_at')

"""incident source_ref + auto_opened — generic alarm intake & auto-open

Revision ID: e1f2a3b4c5d6
Revises: d0e1f2a3b4c5
Create Date: 2026-07-08 12:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = 'e1f2a3b4c5d6'
down_revision: str | None = 'd0e1f2a3b4c5'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('incidents', sa.Column('source_ref', sa.Text(), nullable=True))
    op.add_column(
        'incidents',
        sa.Column('auto_opened', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index(
        'ix_incidents_source_ref_unique',
        'incidents',
        ['source', 'source_ref'],
        unique=True,
        postgresql_where=sa.text('source_ref IS NOT NULL'),
    )


def downgrade() -> None:
    op.drop_index('ix_incidents_source_ref_unique', table_name='incidents')
    op.drop_column('incidents', 'auto_opened')
    op.drop_column('incidents', 'source_ref')

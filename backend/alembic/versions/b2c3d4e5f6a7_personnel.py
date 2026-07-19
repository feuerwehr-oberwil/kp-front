"""personnel (Mannschaft synced from Divera)

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-06-23 14:30:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'b2c3d4e5f6a7'
down_revision: str | None = 'a1b2c3d4e5f6'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'personnel',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('divera_id', sa.Integer(), nullable=True),
        sa.Column('display_name', sa.Text(), nullable=False),
        sa.Column('first_name', sa.Text(), nullable=True),
        sa.Column('last_name', sa.Text(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.text('true')),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    # one row per Divera member; manually-added crew carry NULL divera_id
    op.create_index(
        'ix_personnel_divera_id_unique',
        'personnel',
        ['divera_id'],
        unique=True,
        postgresql_where=sa.text('divera_id IS NOT NULL'),
    )


def downgrade() -> None:
    op.drop_index('ix_personnel_divera_id_unique', table_name='personnel')
    op.drop_table('personnel')

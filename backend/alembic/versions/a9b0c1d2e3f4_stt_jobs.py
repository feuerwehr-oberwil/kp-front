"""stt_jobs — speech-to-text draft segments per audio recording

Revision ID: a9b0c1d2e3f4
Revises: d7e8f9a0b1c2
Create Date: 2026-07-16 12:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = 'a9b0c1d2e3f4'
down_revision: str | None = 'd7e8f9a0b1c2'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'stt_jobs',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('media_id', sa.Uuid(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('segments', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('created_by', sa.Uuid(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['media_id'], ['media.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('media_id'),
    )


def downgrade() -> None:
    op.drop_table('stt_jobs')

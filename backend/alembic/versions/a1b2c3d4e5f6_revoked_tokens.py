"""revoked tokens (persisted JWT blocklist)

Revision ID: a1b2c3d4e5f6
Revises: f3cd27418de6
Create Date: 2026-06-20 09:00:00.000000
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = 'a1b2c3d4e5f6'
down_revision: str | None = 'f3cd27418de6'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'revoked_tokens',
        sa.Column('jti', sa.String(length=64), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('revoked_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('jti'),
    )
    op.create_index(op.f('ix_revoked_tokens_expires_at'), 'revoked_tokens', ['expires_at'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_revoked_tokens_expires_at'), table_name='revoked_tokens')
    op.drop_table('revoked_tokens')

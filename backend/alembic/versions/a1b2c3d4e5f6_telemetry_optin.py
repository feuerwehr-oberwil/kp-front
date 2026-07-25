"""Telemetry: opt-in consent, install id, and the outbox

Additive only, and the additive-ness is the point: ``telemetry_consent`` lands NULL on every
existing deployment, and NULL means off. An upgrade therefore cannot start sending — the
station has to click something first. Same for ``telemetry_install_id``: no id is minted
until the first payload is actually queued, so an instance that never opts in never even
generates one.

Revision ID: a1b2c3d4e5f6
Revises: e9f0a1b2c3d4
Create Date: 2026-07-25 18:30:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

from alembic import op

revision: str = 'a1b2c3d4e5f6'
down_revision: str | None = 'e9f0a1b2c3d4'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('deployment_config', sa.Column('telemetry_consent', sa.Text(), nullable=True))
    op.add_column(
        'deployment_config', sa.Column('telemetry_install_id', UUID(as_uuid=True), nullable=True)
    )
    op.create_table(
        'telemetry_outbox',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('channel', sa.String(length=16), nullable=False),
        sa.Column('payload_json', JSONB(), nullable=False),
        sa.Column(
            'created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('attempts', sa.Integer(), server_default=sa.text('0'), nullable=False),
        sa.Column('last_error', sa.String(length=200), nullable=True),
    )
    op.create_index('ix_telemetry_outbox_pending', 'telemetry_outbox', ['sent_at', 'created_at'])


def downgrade() -> None:
    op.drop_index('ix_telemetry_outbox_pending', table_name='telemetry_outbox')
    op.drop_table('telemetry_outbox')
    op.drop_column('deployment_config', 'telemetry_install_id')
    op.drop_column('deployment_config', 'telemetry_consent')

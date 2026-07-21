"""deployment_config.plan_scales_json — editor-authored station plan calibration

Additive nullable column; no data migration. Holds {default, byPlan} so a once-off plan
scale calibration persists across incidents/devices (see #3 plan-scale feature).

Revision ID: e9f0a1b2c3d4
Revises: d8e9f0a1b2c3
Create Date: 2026-07-21 10:30:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = 'e9f0a1b2c3d4'
down_revision: str | None = 'd8e9f0a1b2c3'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('deployment_config', sa.Column('plan_scales_json', JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column('deployment_config', 'plan_scales_json')

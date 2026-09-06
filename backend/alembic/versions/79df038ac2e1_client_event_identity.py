"""Idempotent client audit event delivery.

Revision ID: 79df038ac2e1
Revises: 7f3ac1d90e42
Create Date: 2026-09-06
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "79df038ac2e1"
down_revision: str | None = "7f3ac1d90e42"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("incident_events", sa.Column("client_id", sa.String(128), nullable=True))
    op.create_index("uq_incident_events_client_id", "incident_events", ["incident_id", "client_id"], unique=True)


def downgrade() -> None:
    op.drop_index("uq_incident_events_client_id", table_name="incident_events")
    op.drop_column("incident_events", "client_id")

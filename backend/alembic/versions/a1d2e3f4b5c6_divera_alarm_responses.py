"""divera_emergencies.responses_json — the alarm's Rückmeldungen as the poll last saw them

Revision ID: a1d2e3f4b5c6
Revises: d3e6a9c2f5b8
Create Date: 2026-10-08 20:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "a1d2e3f4b5c6"
down_revision: str | None = "d3e6a9c2f5b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # both nullable: an alarm nobody answered (or a station without Divera) simply has none
    op.add_column("divera_emergencies", sa.Column("responses_json", postgresql.JSONB(), nullable=True))
    op.add_column("divera_emergencies", sa.Column("responses_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("divera_emergencies", "responses_at")
    op.drop_column("divera_emergencies", "responses_json")

"""user notify_object_visits — who gets the «Neuer Objektbesuch» push

Revision ID: f9b8c7d6e5a4
Revises: e2f3a4b5c6d7
Create Date: 2026-10-05 15:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f9b8c7d6e5a4"
down_revision: str | None = "e2f3a4b5c6d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # nobody by default: an admin picks the accounts in /admin › Objektbesuche
    op.add_column(
        "users",
        sa.Column("notify_object_visits", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("users", "notify_object_visits")

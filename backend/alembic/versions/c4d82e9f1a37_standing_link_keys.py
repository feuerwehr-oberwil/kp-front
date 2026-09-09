"""Standing link keys: Stations-Terminal + fixe Atemschutz-URL (deployment-level secrets).

Revision ID: c4d82e9f1a37
Revises: a1e50b7c4d2f
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4d82e9f1a37"
# Parents must be COMMITTED migrations: this shipped pointing at "b2f61c8d5e30", an untracked
# WIP revision, so every deploy died at `alembic upgrade head` (09.09.2026).
down_revision: str | None = "a1e50b7c4d2f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("deployment_config", sa.Column("terminal_link_key", sa.Text(), nullable=True))
    op.add_column("deployment_config", sa.Column("atemschutz_standing_key", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("deployment_config", "atemschutz_standing_key")
    op.drop_column("deployment_config", "terminal_link_key")

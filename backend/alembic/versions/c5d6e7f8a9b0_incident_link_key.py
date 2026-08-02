"""deployment_config incident_link_key — minting key for incident view links

Additive and NULL on every existing deployment, which is the whole contract: NULL means the
link surface answers 403, so an upgrade cannot open a logged-out read path by itself. The
station has to mint a key and hand it to its alerting system first.

Revision ID: c5d6e7f8a9b0
Revises: b3d5f7a9c1e4
Create Date: 2026-08-02 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c5d6e7f8a9b0"
down_revision: str | None = "b3d5f7a9c1e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("deployment_config", sa.Column("incident_link_key", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("deployment_config", "incident_link_key")

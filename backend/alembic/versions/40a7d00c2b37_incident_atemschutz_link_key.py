"""incident atemschutz_link_key — the Atemschutzüberwachung link

Revision ID: 40a7d00c2b37
Revises: 121b67d2688e
Create Date: 2026-09-01 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "40a7d00c2b37"
down_revision: str | None = "121b67d2688e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("incidents", sa.Column("atemschutz_link_key", sa.Text(), nullable=True))
    # Unique for the same reason as `view_link_key`: the secret IS the credential and the
    # exchange looks an incident up BY this value, so two incidents sharing one would make
    # «which Einsatz does this link open» a question with two answers. NULL (no link minted)
    # is the normal state and repeats freely.
    op.create_index("ix_incidents_atemschutz_link_key", "incidents", ["atemschutz_link_key"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_incidents_atemschutz_link_key", table_name="incidents")
    op.drop_column("incidents", "atemschutz_link_key")

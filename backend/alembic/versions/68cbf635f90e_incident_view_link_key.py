"""incident view_link_key — the Rapport's revocable view-only link

Revision ID: 68cbf635f90e
Revises: c4e7a91b3d58
Create Date: 2026-09-01 00:14:08.353582
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "68cbf635f90e"
down_revision: str | None = "c4e7a91b3d58"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("incidents", sa.Column("view_link_key", sa.Text(), nullable=True))
    # Unique because the secret IS the credential: the exchange looks an incident up BY this
    # value, so two incidents sharing one would make «which Einsatz does this link open» a
    # question with two answers. NULL (no link minted) is the normal state and repeats freely.
    op.create_index("ix_incidents_view_link_key", "incidents", ["view_link_key"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_incidents_view_link_key", table_name="incidents")
    op.drop_column("incidents", "view_link_key")

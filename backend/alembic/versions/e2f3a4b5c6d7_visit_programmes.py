"""Reusable visit routes and scheduled rounds.

Revision ID: e2f3a4b5c6d7
Revises: d1e2f3a4b5c6
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "e2f3a4b5c6d7"
down_revision = "d1e2f3a4b5c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "visit_programmes",
        sa.Column("ref", sa.Text(), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("routes", postgresql.JSONB(), nullable=False),
        sa.Column("years", postgresql.JSONB(), nullable=False),
    )
    op.add_column("visit_lists", sa.Column("scheduled_on", sa.Date(), nullable=True))
    op.add_column("visit_lists", sa.Column("archived", sa.Boolean(), server_default=sa.false(), nullable=False))


def downgrade() -> None:
    op.drop_column("visit_lists", "archived")
    op.drop_column("visit_lists", "scheduled_on")
    op.drop_table("visit_programmes")

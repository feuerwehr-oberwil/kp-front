"""Visit statistics: aggregate counters + the per-day dedup scratch table

Both tables land empty and stay empty unless ``VISIT_STATS=true``, which only the public
demo sets — see app/visits.py. So this migration is a no-op for every station: it creates
two tables nothing in their deployment writes to.

``visit_stats`` is the record (one row per day/kind/key, counters only). ``visit_hashes``
holds the day's salted visitor hashes purely so ``uniques`` can be deduped; those rows are
meaningless once the day rolls over (the salt is derived per day and never stored) and are
swept after 90 days.

Revision ID: c4e7a91b3d58
Revises: f7a1c93d5b20
Create Date: 2026-08-19 11:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c4e7a91b3d58"
down_revision: str | None = "f7a1c93d5b20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "visit_stats",
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("kind", sa.String(length=16), primary_key=True),
        sa.Column("key", sa.String(length=64), primary_key=True),
        sa.Column("hits", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("uniques", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.create_table(
        "visit_hashes",
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("kind", sa.String(length=16), primary_key=True),
        sa.Column("key", sa.String(length=64), primary_key=True),
        sa.Column("visitor", sa.String(length=32), primary_key=True),
    )


def downgrade() -> None:
    op.drop_table("visit_hashes")
    op.drop_table("visit_stats")

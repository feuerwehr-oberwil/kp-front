"""join the staging head with the incident alarm update (staging integration only)

e3a7c9d1f5b4 (the staging-only join) and e7a2c5b9d3f1 (#631: incident alarm update) both descend
from d5f9b3a7c1e2, so the staging branch has two heads after merging main on 15.11.2026. This
empty revision joins them so `alembic upgrade head` has one target. It lives on the staging branch only.

Revision ID: f2b8d4a6c0e5
Revises: e3a7c9d1f5b4, e7a2c5b9d3f1
Create Date: 2026-11-15 19:30:00.000000
"""

from collections.abc import Sequence

revision: str = "f2b8d4a6c0e5"
down_revision: str | tuple[str, ...] | None = ("e3a7c9d1f5b4", "e7a2c5b9d3f1")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

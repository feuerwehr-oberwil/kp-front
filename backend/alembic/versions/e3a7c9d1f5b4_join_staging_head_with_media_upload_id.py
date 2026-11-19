"""join the staging head with the media upload id (staging integration only)

d1f3b5a7c9e2 (the staging-only join) and d5f9b3a7c1e2 (#634: media upload id) both descend from
c4e8a2f6d0b1, so the staging branch has two heads after merging main on 15.11.2026. This empty
revision joins them so `alembic upgrade head` has one target. It lives on the staging branch only.

Revision ID: e3a7c9d1f5b4
Revises: d1f3b5a7c9e2, d5f9b3a7c1e2
Create Date: 2026-11-15 17:00:00.000000
"""

from collections.abc import Sequence

revision: str = "e3a7c9d1f5b4"
down_revision: str | tuple[str, ...] | None = ("d1f3b5a7c9e2", "d5f9b3a7c1e2")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

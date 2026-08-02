"""backfill editor_opened_at for incidents that predate the latch

The stats export now drops incidents with `editor_opened_at IS NULL` — the line between «an
alarm arrived» and «the station attended an Einsatz», which matters now that every alarm opens
itself. The latch column only landed on 2026-07-18 (d8e9f0a1b2c3) and was never backfilled, so
without this migration switching the filter on would silently delete the station's entire
pre-latch history from the figures reported to the canton. That is the exact opposite of what
the filter is for.

The backfill is evidence-based rather than date-based: under the old model an incident only
came into being through a human (create or pool take), so `auto_opened = false` is proof of
one; `workspace_rev > 0` means somebody worked in it, and a completed Rapport means somebody
finished it. Untouched auto-opened rows stay NULL — they are precisely the alarms nobody
attended, and the auto-archive sweep has been filing them away as such all along.

`started_at` is the stamp, not `now()`: the latch means «the KP had this incident», and dating
that to today would put a 2024 Einsatz's confirmation in 2026.

Revision ID: e3f4a5b6c7d8
Revises: d2e3f4a5b6c7
Create Date: 2026-08-02 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e3f4a5b6c7d8"
down_revision: str | None = "f4a5b6c7d8e9"  # rebased onto #75's alarm-time migration
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE incidents
               SET editor_opened_at = COALESCE(started_at, created_at)
             WHERE editor_opened_at IS NULL
               AND (auto_opened = false OR workspace_rev > 0 OR report_done_at IS NOT NULL)
            """
        )
    )


def downgrade() -> None:
    # One-way: which rows were stamped here and which by a real editor open is not recorded,
    # and clearing the column wholesale would lose live latches. Leaving the values is
    # harmless — a downgrade only un-applies the export filter that reads them.
    pass

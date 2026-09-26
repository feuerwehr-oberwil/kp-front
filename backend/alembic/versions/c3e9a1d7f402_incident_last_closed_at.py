"""incidents.last_closed_at — when the Einsatz was closed THIS time

Staging walk-through 25.09.2026 (D2): after «Wieder öffnen» and a second close, every device and
the printed Rapport kept the FIRST close as the Einsatzende — the Einsatzdauer, the «Einsatzende»
line and the end of every Anwesenheit interval — while the Trupps' Austritt and the close rows sat
minutes later on the same paper. ``closed_at`` stays what it was (the first Einsatzende, which is
what marks the Nachträge); ``last_closed_at`` is stamped on EVERY close and is what the Einsatzende
defaults to. Existing rows take their only known close.

Revision ID: c3e9a1d7f402
Revises: a7c4e2b91f38
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3e9a1d7f402"
down_revision: str | None = "a7c4e2b91f38"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("incidents", sa.Column("last_closed_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(sa.text("UPDATE incidents SET last_closed_at = closed_at WHERE closed_at IS NOT NULL"))


def downgrade() -> None:
    op.drop_column("incidents", "last_closed_at")

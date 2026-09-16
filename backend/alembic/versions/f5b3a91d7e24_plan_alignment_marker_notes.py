"""plan_alignments.marker_notes — why a marked export produced what it produced

Structured marker warnings (16.09.2026): `plan_markers` used to hand the worker free-text
sentences that only ever reached a log line, so an admin looking at an object with «Vorschlag
bereit» and zero Geschosse had no way to learn that a «§4OG]» was missing and a «§[EG» sat off
the page. Every marker run now writes what it read onto the row — the warnings as codes plus a
small summary — and the Objektpläne page says it out loud. NULL is every existing row and every
sheet that carries no markers at all.

Revision ID: f5b3a91d7e24
Revises: a7d41f0c9b63
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f5b3a91d7e24"
down_revision: str | None = "a7d41f0c9b63"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "plan_alignments",
        sa.Column(
            "marker_notes",
            postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("plan_alignments", "marker_notes")

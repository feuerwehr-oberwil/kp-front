"""one einsatz-link audit row per Einsatz

Revision ID: 5b31c0a7f4d2
Revises: 40a7d00c2b37
Create Date: 2026-09-03 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "5b31c0a7f4d2"
down_revision: str | None = "40a7d00c2b37"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_WHERE = "source = 'einsatz-link'"


def upgrade() -> None:
    # «Der Einsatz-Link wurde erstellt» belongs in the chain once per Einsatz. The endpoint that
    # writes it checks first and then appends, which is a race the incident-row lock does not
    # settle on every engine (SQLite has no row locks, so a StrictMode double mount wrote two).
    # A partial unique index makes the invariant the database's, not the handler's.
    op.create_index(
        "uq_incident_events_einsatz_link",
        "incident_events",
        ["incident_id"],
        unique=True,
        postgresql_where=sa.text(_WHERE),
        sqlite_where=sa.text(_WHERE),
    )


def downgrade() -> None:
    op.drop_index("uq_incident_events_einsatz_link", table_name="incident_events")

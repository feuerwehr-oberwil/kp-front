"""incidents.exercise_since_creation – only an Übung born as one deletes without the Verwaltung

Revision ID: c3e7a1d9b5f2
Revises: b2d6e8f1a3c7
Create Date: 2026-10-22 10:00:00.000000

RBAC audit S1 (22.10.2026): `is_exercise` is an Einsatzdaten field, so an editor or el could
flip a real Einsatz to «Übung» and then hard-delete it. The delete door now reads this column.

Backfill errs closed. The hash chain records every Übung toggle since the first release
(api/incidents · patch_incident writes `meta.change` with an `exercise` payload), but the
`incident.create` event never carried the flag. So a row counts as «Übung since creation» only
when it is an Übung today AND its chain holds no toggle at all; any toggle, either way, means it
was real at some point and keeps the admin-only delete.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c3e7a1d9b5f2"
down_revision: str | None = "b2d6e8f1a3c7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "incidents",
        sa.Column("exercise_since_creation", sa.Boolean(), server_default="false", nullable=False),
    )
    op.execute(
        """
        UPDATE incidents SET exercise_since_creation = true
        WHERE is_exercise
          AND NOT EXISTS (
            SELECT 1 FROM incident_events e
            WHERE e.incident_id = incidents.id
              AND e.op_type = 'meta.change'
              AND e.payload_json -> 'exercise' IS NOT NULL
          )
        """
    )


def downgrade() -> None:
    op.drop_column("incidents", "exercise_since_creation")

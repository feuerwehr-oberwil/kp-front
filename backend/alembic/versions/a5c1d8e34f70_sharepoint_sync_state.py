"""SharePoint pull connector: one sync-state row per area

Lands empty and stays empty on every deployment that does not configure the connector — the
worker writes a row the first time it runs for an area, and it only runs when the credentials
AND a `sharepoint.sources` entry are both present.

The imported DATA is not here: plans go to `reference_datasets`/`objects`, layers to
`reference_datasets` + `deployment_config.referenceLayers`, the workbook through the existing
import. This table carries only the resume point (Graph's deltaLink + the resolved ids), what
was imported from which eTag, and the last run's report for the admin System card.

Revision ID: a5c1d8e34f70
Revises: c4d82e9f1a37
Create Date: 2026-09-09 22:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "a5c1d8e34f70"
down_revision: str | None = "c4d82e9f1a37"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sharepoint_sync_state",
        sa.Column("area", sa.String(length=16), primary_key=True),
        sa.Column("delta_token", sa.Text(), nullable=True),
        sa.Column("drive_id", sa.Text(), nullable=True),
        sa.Column("item_id", sa.Text(), nullable=True),
        sa.Column("source_fingerprint", sa.Text(), nullable=True),
        sa.Column("files", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("missing", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="ok"),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("imported", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("skipped", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("sharepoint_sync_state")

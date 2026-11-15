"""media.upload_id: the client's id for one capture, so a retried upload is not stored twice

Revision ID: d5f9b3a7c1e2
Revises: c4e8a2f6d0b1
Create Date: 2026-11-15 12:00:00.000000

A retry after a lost response (a proxy timeout while the server was still storing the file)
used to store a second copy. The client now sends an id per capture; the same id again returns
the stored row. Nullable – existing rows and uploads without an id are untouched – and unique
per Einsatz only where set.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d5f9b3a7c1e2"
down_revision: str | None = "c4e8a2f6d0b1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("media", sa.Column("upload_id", sa.String(length=64), nullable=True))
    op.create_index(
        "ix_media_incident_upload_id",
        "media",
        ["incident_id", "upload_id"],
        unique=True,
        postgresql_where=sa.text("upload_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_media_incident_upload_id", table_name="media")
    op.drop_column("media", "upload_id")

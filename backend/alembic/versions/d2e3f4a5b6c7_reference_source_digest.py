"""reference_datasets.source_digest — checksum of the bytes currently stored

Additive and NULL everywhere, which is the whole contract: NULL means "no upstream checksum
recorded", so the Objektplan-Pull treats such a dataset as needing a fetch and a deployment
that never configures a snapshot store is unaffected. Nothing reads it on the upload path.

Revision ID: d2e3f4a5b6c7
Revises: c5d6e7f8a9b0
Create Date: 2026-08-02 15:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d2e3f4a5b6c7"
down_revision: str | None = "c5d6e7f8a9b0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("reference_datasets", sa.Column("source_digest", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("reference_datasets", "source_digest")

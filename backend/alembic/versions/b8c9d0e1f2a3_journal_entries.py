"""journal_entries — Verlauf rows as first-class append-only records

The operational journal leaves the workspace blob (the one unbounded domain made the
whole document re-sync on every edit). Rows are appended once and never rewritten:
client row id = idempotency key, seq = per-incident read cursor.

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-07-02 16:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = 'b8c9d0e1f2a3'
down_revision: str | None = 'a7b8c9d0e1f2'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'journal_entries',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('incident_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('incidents.id', ondelete='CASCADE'), nullable=False),
        sa.Column('client_id', sa.Text(), nullable=False),
        sa.Column('seq', sa.BigInteger(), nullable=False),
        sa.Column('row_json', postgresql.JSONB(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint('incident_id', 'client_id', name='uq_journal_client_id'),
        sa.UniqueConstraint('incident_id', 'seq', name='uq_journal_seq'),
    )
    op.create_index('ix_journal_entries_incident_id', 'journal_entries', ['incident_id'])


def downgrade() -> None:
    op.drop_index('ix_journal_entries_incident_id', table_name='journal_entries')
    op.drop_table('journal_entries')

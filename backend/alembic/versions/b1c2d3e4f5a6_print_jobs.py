"""print_jobs — station print relay queue

Revision ID: b1c2d3e4f5a6
Revises: a9b0c1d2e3f4
Create Date: 2026-07-18 18:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = 'b1c2d3e4f5a6'
down_revision: str | None = 'a9b0c1d2e3f4'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'print_jobs',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('incident_id', sa.Uuid(), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('filename', sa.Text(), nullable=False),
        sa.Column('pdf', sa.LargeBinary(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('requested_by', sa.Uuid(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('claimed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['incident_id'], ['incidents.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['requested_by'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_print_jobs_incident_id'), 'print_jobs', ['incident_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_print_jobs_incident_id'), table_name='print_jobs')
    op.drop_table('print_jobs')

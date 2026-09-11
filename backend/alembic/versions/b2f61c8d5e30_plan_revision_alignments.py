"""Immutable plan revisions and durable admin alignment proposals.

Revision ID: b2f61c8d5e30
Revises: a1e50b7c4d2f
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b2f61c8d5e30"
# Repointed twice while this migration waited to land (09.09. onto c4d82e9f1a37, 11.09. onto
# b8e2f5c41a09): the parent must always be the COMMITTED head, or the chain forks into two
# heads and tests/test_migration_chain.py fails — and a WIP parent would kill the deploy at
# boot (memory: migration chain trap). Revision id unchanged, so DBs that already ran this
# migration keep their stamp.
down_revision: str | None = "b8e2f5c41a09"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "plan_revisions",
        sa.Column(
            "dataset_id", sa.Text(), sa.ForeignKey("reference_datasets.id", ondelete="RESTRICT"), primary_key=True
        ),
        sa.Column("version", sa.Integer(), primary_key=True),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("content_digest", sa.String(64), nullable=True),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "plan_alignments",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("dataset_id", sa.Text(), nullable=False),
        sa.Column("plan_version", sa.Integer(), nullable=False),
        sa.Column("page", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("edit_version", sa.Integer(), nullable=False),
        sa.Column("pairs", postgresql.JSONB(), nullable=False),
        sa.Column("aspect", sa.Float(), nullable=True),
        sa.Column("scale_m_per_u", sa.Float(), nullable=True),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("coverage", sa.Float(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("reference_rings", postgresql.JSONB(), nullable=False),
        sa.Column("reference_source", sa.Text(), nullable=True),
        sa.Column("reference_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["dataset_id", "plan_version"], ["plan_revisions.dataset_id", "plan_revisions.version"]
        ),
        sa.UniqueConstraint("dataset_id", "plan_version", "page"),
    )
    op.create_index("ix_plan_alignments_status", "plan_alignments", ["status"])
    op.create_table(
        "plan_alignment_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("alignment_id", sa.Integer(), sa.ForeignKey("plan_alignments.id"), nullable=False),
        sa.Column("action", sa.String(24), nullable=False),
        sa.Column("edit_version", sa.Integer(), nullable=False),
        sa.Column("snapshot", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_plan_alignment_events_alignment_id", "plan_alignment_events", ["alignment_id"])
    # Existing keys are already immutable originals: pin them without moving or rewriting files.
    op.execute("""
        INSERT INTO plan_revisions (dataset_id, version, storage_key, content_digest, content_type, size_bytes, created_at)
        SELECT id, current_version, storage_key, source_digest, COALESCE(content_type, 'application/pdf'), size_bytes, updated_at
        FROM reference_datasets WHERE id LIKE 'plan:%' AND kind = 'pdf' AND storage_key IS NOT NULL
    """)
    op.execute("""
        INSERT INTO plan_alignments (dataset_id, plan_version, page, status, edit_version, pairs,
                                     reference_rings, attempts)
        SELECT dataset_id, version, 0, 'pending', 1, '[]'::jsonb, '[]'::jsonb, 0 FROM plan_revisions
    """)


def downgrade() -> None:
    # Dropping metadata does not delete PDF originals. Operators may export/restore them.
    op.drop_table("plan_alignment_events")
    op.drop_table("plan_alignments")
    op.drop_table("plan_revisions")

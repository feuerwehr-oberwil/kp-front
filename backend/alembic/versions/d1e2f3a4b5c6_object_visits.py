"""Objektbesuche: visits, revisions, photos, refs, work lists, delivery outbox

The module is off by default (``objectVisits.enabled``) and every table lands empty — except
``objects.filing_folder``, which is backfilled for objects whose provenance names the plan-library
folder they came from:

* ``source_note`` «OneDrive: Einsatzpläne/<folder>» (the private importer) or
  «SchlüHü hub: Einsatzplaene/<folder>» → ``<folder>``;
* objects the SharePoint pull created (``source_note`` «SharePoint») → «<address> - <name>», the
  inverse of ``admin_objects.folder_identity``, or the bare name for a folder without address.

Anything else stays NULL; ``object_visits.object_folder`` derives a folder at read time.

The change feed's counter is a one-row table rather than a SEQUENCE — see
``models.ObjectVisitSeq`` for why commit order matters to a polling organizer.

Revision ID: d1e2f3a4b5c6
Revises: c3e9a1d7f402
Create Date: 2026-10-03 10:00:00.000000
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "d1e2f3a4b5c6"
down_revision: str | None = "c3e9a1d7f402"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen copy of `object_visits.folder_from_source` as of this migration — a migration must not
# import app code that may change after it shipped.
_FOLDER_NOTE = re.compile(r"^[^:/]{1,60}:\s*Einsatzpl(?:ä|ae)ne/(?P<folder>[^/]+?)/?\s*$")


def _backfill(source_note: str | None, name: str | None, address: str | None) -> str | None:
    note = (source_note or "").strip()
    match = _FOLDER_NOTE.match(note)
    if match:
        return match.group("folder").strip() or None
    if note == "SharePoint" and name:
        name = " ".join(name.split())
        address = " ".join((address or "").split())
        return f"{address} - {name}" if address else name
    return None


def upgrade() -> None:
    op.add_column("objects", sa.Column("filing_folder", sa.Text(), nullable=True))

    op.create_table(
        "object_refs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("object_id", sa.UUID(), sa.ForeignKey("objects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source", sa.String(length=64), nullable=False),
        sa.Column("external_id", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("source", "external_id", name="uq_object_refs_source_external"),
    )
    op.create_index("ix_object_refs_object_id", "object_refs", ["object_id"])

    op.create_table(
        "visit_lists",
        sa.Column("ref", sa.Text(), primary_key=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("closes_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("items", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "object_visits",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("object_id", sa.UUID(), sa.ForeignKey("objects.id", ondelete="SET NULL"), nullable=True),
        sa.Column("work_ref", sa.Text(), nullable=True),
        sa.Column("lifecycle", sa.String(length=16), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("ready", sa.Boolean(), nullable=False),
        sa.Column("doc", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("visited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("findings", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=True),
        sa.Column("created_by_name", sa.Text(), nullable=True),
        sa.Column("updated_by", sa.UUID(), nullable=True),
        sa.Column("updated_by_name", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
    )
    op.create_index("ix_object_visits_object_id", "object_visits", ["object_id"])
    op.create_index("ix_object_visits_work_ref", "object_visits", ["work_ref"])
    op.create_index("ix_object_visits_seq", "object_visits", ["seq"])
    op.create_index("ix_object_visits_object_visited", "object_visits", ["object_id", "visited_at"])

    op.create_table(
        "object_visit_revisions",
        sa.Column("visit_id", sa.Text(), sa.ForeignKey("object_visits.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("revision", sa.Integer(), primary_key=True),
        sa.Column("op_id", sa.Text(), nullable=False),
        sa.Column("lifecycle", sa.String(length=16), nullable=False),
        sa.Column("doc", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("ready", sa.Boolean(), nullable=False),
        sa.Column("response", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_by", sa.UUID(), nullable=True),
        sa.Column("accepted_by_name", sa.Text(), nullable=True),
        sa.UniqueConstraint("visit_id", "op_id", name="uq_object_visit_revisions_op"),
    )

    op.create_table(
        "object_visit_attachments",
        sa.Column("visit_id", sa.Text(), sa.ForeignKey("object_visits.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("att_id", sa.Text(), primary_key=True),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "object_visit_seq",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("value", sa.BigInteger(), nullable=False),
    )

    op.create_table(
        "object_visit_deliveries",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("destination", sa.String(length=64), nullable=False),
        sa.Column("visit_id", sa.Text(), sa.ForeignKey("object_visits.id", ondelete="CASCADE"), nullable=False),
        sa.Column("wanted_revision", sa.Integer(), nullable=False),
        sa.Column("delivered_revision", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_owner", sa.Text(), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("failed_fingerprint", sa.Text(), nullable=True),
        sa.Column("remote_folder_id", sa.Text(), nullable=True),
        sa.Column("remote_items", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("destination", "visit_id", name="uq_object_visit_deliveries_dest_visit"),
    )
    op.create_index("ix_object_visit_deliveries_visit_id", "object_visit_deliveries", ["visit_id"])
    op.create_index("ix_object_visit_deliveries_due", "object_visit_deliveries", ["state", "next_attempt_at"])

    op.create_table(
        "object_visit_delivery_log",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "delivery_id",
            sa.UUID(),
            sa.ForeignKey("object_visit_deliveries.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("event", sa.String(length=32), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=True),
        sa.Column("detail", sa.Text(), nullable=True),
    )
    op.create_index("ix_object_visit_delivery_log_delivery_id", "object_visit_delivery_log", ["delivery_id"])

    # The backfill: read every object once, write the folder where provenance names one.
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, name, address, source_note FROM objects")).fetchall()
    for row in rows:
        folder = _backfill(row.source_note, row.name, row.address)
        if folder:
            conn.execute(
                sa.text("UPDATE objects SET filing_folder = :folder WHERE id = :id"), {"folder": folder, "id": row.id}
            )


def downgrade() -> None:
    op.drop_index("ix_object_visit_delivery_log_delivery_id", table_name="object_visit_delivery_log")
    op.drop_table("object_visit_delivery_log")
    op.drop_index("ix_object_visit_deliveries_due", table_name="object_visit_deliveries")
    op.drop_index("ix_object_visit_deliveries_visit_id", table_name="object_visit_deliveries")
    op.drop_table("object_visit_deliveries")
    op.drop_table("object_visit_seq")
    op.drop_table("object_visit_attachments")
    op.drop_table("object_visit_revisions")
    op.drop_index("ix_object_visits_object_visited", table_name="object_visits")
    op.drop_index("ix_object_visits_seq", table_name="object_visits")
    op.drop_index("ix_object_visits_work_ref", table_name="object_visits")
    op.drop_index("ix_object_visits_object_id", table_name="object_visits")
    op.drop_table("object_visits")
    op.drop_table("visit_lists")
    op.drop_index("ix_object_refs_object_id", table_name="object_refs")
    op.drop_table("object_refs")
    op.drop_column("objects", "filing_folder")

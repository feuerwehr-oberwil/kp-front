"""objects: add source_key, the station's own stable key

WHY
---
A scheduled plan pull reads an index published by whatever produces the station's plans.
Each row has to name the object it belongs to. Until now the only thing this app could
match on was ``objects.id`` — its own UUID — which meant the publisher had to already know
an id it has no way of knowing. Publishers emit their own object UUID, the two id spaces
overlap by zero, and the pull therefore skipped every plan as "unknown object" — silently,
because skipping is the safe branch.

Observed on a production deployment 2026-08-03: **582 reference datasets, all ``uploaded``,
zero ``snapshot``**, after the job had run hourly since it shipped without ever storing a
plan. Nothing looked wrong, because the manual upload path was still feeding the same rows.

WHY NOT JUST RE-DERIVE THE UUID
-------------------------------
Because that makes two codebases implement one derivation rule with nothing comparing
them, and this estate has been bitten by exactly that five times (the Ausrückordnung, the
alarm-number derivation, the ported geo_resolver, a hardcoded log-leak list, an allowlist
test measuring the wrong path form). The geo_resolver copy drifted within 24 hours of
being made. Recording the identity beats re-deriving it.

It also keeps any id-derivation scheme out of this product entirely: ``source_key`` is
opaque here and never parsed. A station's own importer owns its key format, which is where
that knowledge belongs — a deployment that uploads plans by hand needs no key at all.

NULLABLE, AND UNIQUE
--------------------
Nullable because most objects will never have one: a station that uploads plans by hand
needs no external key, and a self-hoster inherits nothing. Unique because two objects
claiming the same station key is a real conflict — a plan would attach to whichever the
query happened to return first, which is the silent-wrong-answer failure this whole change
exists to remove. Partial index so the NULLs do not collide.

NO BACKFILL HERE
----------------
Deliberately. This migration cannot know the keys — they live in the station's importer,
not in this database, and inventing them from the UUID would reintroduce the derivation
the change removes. The importer sets them on its next run; it is idempotent and upserts
by id, so re-running it IS the backfill. Until then ``source_key`` is NULL and the pull
matches nothing — exactly what it already does, so nothing regresses.

Revision ID: c7d8e9f0a1b2
Revises: e3f4a5b6c7d8
Create Date: 2026-08-03 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7d8e9f0a1b2"
down_revision: str | None = "e3f4a5b6c7d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("objects", sa.Column("source_key", sa.Text(), nullable=True))
    # Partial: only non-NULL keys must be unique. Without the WHERE clause every
    # object without a station key would collide with every other one.
    op.create_index(
        "ix_objects_source_key",
        "objects",
        ["source_key"],
        unique=True,
        postgresql_where=sa.text("source_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_objects_source_key", table_name="objects")
    op.drop_column("objects", "source_key")

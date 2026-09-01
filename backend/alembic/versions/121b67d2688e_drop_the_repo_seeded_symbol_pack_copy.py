"""drop the repo-seeded symbol pack copy — nothing reads it, and it used to override us

Revision ID: 121b67d2688e
Revises: 68cbf635f90e
Create Date: 2026-09-01 08:58:00.000000

`seed_reference` copied public/tactical-symbols.json into `reference.symbols:tactical` on a
deployment's FIRST boot and returned early ever after, while the frontend overlaid that row's
artwork on top of the bundled pack. So the row was frozen at whatever the pack looked like the
day the station was set up, and it silently reverted every symbol we redrew afterwards — for
symbols it already knew, forever. A new symbol had no row, came through fine, and made the
result look like a half-finished deploy. The screen was wrong while the printed Kroki was right,
because kroki.py reads the file.

The frontend now reads only the bundled pack (lib/useSymbols) and the seed is gone, so this row
is dead weight. Deleted here rather than left to puzzle the next person who finds a symbol pack
in the station's own data.

⚠️ Scoped to the REPO-SEEDED rows by their `source_note`, which `seed_reference` wrote verbatim.
A dataset a station uploaded itself carries a different note and is left alone — this migration
must not be the thing that eats somebody's own artwork.

The storage blob is deliberately NOT unlinked: it is ~48 kB, a migration that reaches into the
object store is a much worse failure when it goes wrong, and an orphan file costs nothing.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "121b67d2688e"
down_revision: str | None = "68cbf635f90e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SEED_NOTE = "public/tactical-symbols.json (KP Front, FKS-Konvention)"


def upgrade() -> None:
    op.execute(
        sa.text("DELETE FROM reference_datasets WHERE id = :id AND source_note = :note").bindparams(
            id="symbols:tactical", note=_SEED_NOTE
        )
    )


def downgrade() -> None:
    # Nothing to restore: the row was a copy of a file that ships with the application, and the
    # code that read it is gone. Re-creating it would re-create the bug.
    pass

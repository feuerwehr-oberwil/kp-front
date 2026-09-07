"""add the 'el' incident role

The Einsatzleiter function (07.09.2026): a third incident role between editor and
viewer. An ``el`` session reads everything a viewer reads, but may additionally write
the operational RECORD domains — Anwesenheit, Mittel, Checklisten, Rapport (incl.
Beilagen) — through the scoped ``PUT …/workspace/record`` slice, never the tactical
picture (the full workspace PUT stays editor-only). This migration only widens the
``ck_users_role`` CHECK; the gate lives in ``auth/dependencies.py``.

Revision ID: a1e50b7c4d2f
Revises: 79df038ac2e1
Create Date: 2026-09-07 00:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "a1e50b7c4d2f"
down_revision: str | None = "79df038ac2e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_users_role", "users", type_="check")
    op.create_check_constraint("ck_users_role", "users", "role in ('editor','viewer','el')")


def downgrade() -> None:
    op.drop_constraint("ck_users_role", "users", type_="check")
    # ⚠️ demote any 'el' rows first, or the recreated constraint refuses the table
    op.execute("UPDATE users SET role = 'viewer' WHERE role = 'el'")
    op.create_check_constraint("ck_users_role", "users", "role in ('editor','viewer')")

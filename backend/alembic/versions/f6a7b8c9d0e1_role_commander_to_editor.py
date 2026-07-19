"""rename role commander -> editor

Product incident roles are generic ``editor`` / ``viewer``; ``commander`` was only a
compatibility name for ``editor``. This migrates the stored value and swaps the
``ck_users_role`` CHECK constraint to the new pair. The constraint is dropped before the
data UPDATE and recreated after, so neither the old nor the new constraint is ever
violated mid-migration.

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-06-30 00:00:00.000000
"""
from collections.abc import Sequence

from alembic import op

revision: str = 'f6a7b8c9d0e1'
down_revision: str | None = 'e5f6a7b8c9d0'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint('ck_users_role', 'users', type_='check')
    op.execute("UPDATE users SET role = 'editor' WHERE role = 'commander'")
    op.create_check_constraint('ck_users_role', 'users', "role in ('editor','viewer')")


def downgrade() -> None:
    op.drop_constraint('ck_users_role', 'users', type_='check')
    op.execute("UPDATE users SET role = 'commander' WHERE role = 'editor'")
    op.create_check_constraint('ck_users_role', 'users', "role in ('commander','viewer')")

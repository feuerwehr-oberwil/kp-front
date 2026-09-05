"""users.auth_generation — the counter that ends every session of an account at once

Resetting a PIN used to change nothing for whoever was already signed in: the old access
cookie kept working for its full eight hours and the old refresh cookie kept minting fresh
seven-day successors indefinitely (security audit SEC-05). Access and refresh tokens now carry
the generation they were minted under, and `auth/dependencies` and `/auth/refresh` refuse a
token whose generation is behind the row's.

Additive and NOT NULL with a server default of 0: every existing row starts at the generation
that a token minted before this deploy is read as, so nobody is signed out by the migration
itself. The first PIN reset or deactivation after it moves that account to 1 and ends its old
sessions.

Revision ID: 7f3ac1d90e42
Revises: 5b31c0a7f4d2
Create Date: 2026-09-05 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "7f3ac1d90e42"
down_revision: str | None = "5b31c0a7f4d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("auth_generation", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("users", "auth_generation")

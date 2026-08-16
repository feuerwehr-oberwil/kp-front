"""integration_credentials — the station's integration keys, in the database, encrypted

WHY THE TABLES EXIST
--------------------
Connecting Divera, Traccar, Web Push, speech-to-text, the two webhook intakes, the print
agent or an uptime monitor meant editing `.env` and restarting the container. That is not a
step a volunteer with Docker and nothing else can be asked to take at 22:00 on a Tuesday, and
it could not be turned into a browser form as long as the values lived in the environment:
`settings = Settings()` is built once at boot, several scheduler jobs were registered or not
registered at that same moment, and a process cannot restart itself into new environment. A
form that wrote `.env` would appear to work and change nothing — the worst failure shape
there is.

WHY NOT `deployment_config.config_json`
---------------------------------------
`GET /api/config` is public (the login screen brands itself before anybody logs in), and the
Sicherung export/import round-trip replaces that document wholesale. A credential in there
would make the export a leak and the import a credential-deletion button. The three station
secrets that came before this — `capture_secret`, `stats_secret`, `incident_link_key` — are
columns for exactly that reason.

WHAT IS STORED
--------------
`integration_credentials`: one row per credential the station set from the browser, holding
`version ‖ nonce ‖ AES-256-GCM(value, aad=name)` under a key HKDF-derived from `SECRET_KEY`,
which stays in `.env`. A database dump therefore carries no usable credential on its own.
⚠️ The other side of that: rotating `SECRET_KEY` makes these rows unreadable, exactly as it
invalidates every PIN. The app reports such a row as «unlesbar, bitte neu setzen».

`integration_credential_audit`: that a credential changed, when, by whom, through which
path — never the value, not even encrypted. Config writes keep the previous document so a
bad write is undoable; credentials deliberately do NOT, because keeping old values would mean
one leaked `SECRET_KEY` exposes every credential the station has ever held.

NOTHING IS MIGRATED
-------------------
No data moves out of anybody's `.env`. A value present in the environment keeps winning, and
both tables come up empty on every existing deployment — Oberwil's and the demo's behaviour
is bit-for-bit what it was. Only a station that left a variable blank can now fill it from a
browser.

Revision ID: f7a1c93d5b20
Revises: c1d2e3f4a5b6
Create Date: 2026-08-16 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "f7a1c93d5b20"
down_revision: str | None = "c1d2e3f4a5b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "integration_credentials",
        # the Settings attribute name — also the env-variable name upper-cased, and the AAD
        # the ciphertext is bound to, so a row cannot be moved into another credential's slot
        sa.Column("name", sa.String(length=64), primary_key=True),
        sa.Column("value_encrypted", sa.LargeBinary(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column(
            "updated_by",
            postgresql.UUID(as_uuid=True).with_variant(sa.String(length=36), "sqlite"),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
    )
    op.create_table(
        "integration_credential_audit",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=64), nullable=False),
        # set | rotated | cleared — never the value
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column(
            "actor_id",
            postgresql.UUID(as_uuid=True).with_variant(sa.String(length=36), "sqlite"),
            nullable=True,
        ),
    )
    # «what changed recently» is the only query this table has
    op.create_index("ix_integration_credential_audit_at", "integration_credential_audit", ["at"])


def downgrade() -> None:
    op.drop_index("ix_integration_credential_audit_at", table_name="integration_credential_audit")
    op.drop_table("integration_credential_audit")
    op.drop_table("integration_credentials")

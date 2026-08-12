"""deployment_config_history — the previous config document, kept, so a bad write is undoable

WHY THE TABLE EXISTS
--------------------
`deployment_config.config_json` has no partial writes: the Verwaltung, `admin_config load`, the
geodata push and the backup import all replace the WHOLE document. That is fine until one of
them is holding an outdated copy — and then a station loses its Dienstgrade, its Atemschutz-
Doktrin (the Alarmdruck included), its Partnerorganisationen and its Fahrzeuge in a single write,
silently, because the symptom is features quietly not being there rather than an error.

It happened to the public demo three times in four days. Each time it was diagnosed as whatever
path had just been observed, each time that path was closed, and each time the next occurrence
came through a different one. The guards are worth having and they are still there — a browser
must now send the version it read (api/config), and `admin_config load` refuses to empty a
populated section without `--force`. But every one of them protects against a route somebody
thought of. This table does not: it keeps what was there before ANY write, so the answer to «the
config is wrong and nobody knows why» stops being «restore from a seed file, if one exists».

⚠️ A station has no seed file. The demo could be repaired by re-running its reset; Oberwil could
not have been. That asymmetry is the actual reason this is a table and not a runbook.

WHAT IS STORED
--------------
One row per REPLACED document, written just before the new one lands: the old JSON, when it was
replaced, and what did it (`source` — `api` / `cli` / `branding` / `geodata`), plus the acting
user where there is one. The row is the document as it was, not a diff: a diff needs its base to
be intact to mean anything, and the case this exists for is precisely the one where it is not.

Unbounded on purpose at this size. A config document is a few KB and a station changes it a
handful of times a year; the demo's nightly reset is the only frequent writer, and 365 rows a
year of a few KB is not a problem worth a retention job that could itself delete the row somebody
needs. If that changes, prune by age — never keep «only the last N», because the write that
destroys a config is often followed by several innocent ones.

Revision ID: c1d2e3f4a5b6
Revises: d9e0f1a2b3c4
Create Date: 2026-08-12 10:05:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c1d2e3f4a5b6"
down_revision: str | None = "d9e0f1a2b3c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "deployment_config_history",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        # the document AS IT WAS before the write that replaced it
        sa.Column(
            "config_json", postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite"), nullable=True
        ),
        sa.Column("replaced_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        # api | cli | branding | geodata — which path did the replacing
        sa.Column("source", sa.String(length=16), nullable=True),
        # the admin driving the UI; NULL for a CLI push, which has no user
        sa.Column(
            "replaced_by", postgresql.UUID(as_uuid=True).with_variant(sa.String(length=36), "sqlite"), nullable=True
        ),
    )
    # «what did the config look like before yesterday» is the only query this table has
    op.create_index("ix_config_history_replaced_at", "deployment_config_history", ["replaced_at"])


def downgrade() -> None:
    op.drop_index("ix_config_history_replaced_at", table_name="deployment_config_history")
    op.drop_table("deployment_config_history")

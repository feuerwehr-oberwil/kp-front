"""Migrations ↔ models drift (08.10.2026, ported from KP Rück's test_migration_drift).

Production's schema is what `alembic upgrade head` builds (start.sh); the tests run on what
`Base.metadata.create_all` builds. Nothing compared the two, so a model change without a
migration passed every test here and failed — or silently differed — on the next deploy. This
builds a scratch database purely from the migrations and diffs it against the models with
alembic's autogenerate. On the way it walks every migration down to base and up again, so a
broken `downgrade()` is found before somebody needs it.

Postgres only (CI): the migrations are written for it, and the SQLite fallback has no schema
of record to compare. The scratch database sits next to the one DATABASE_URL names
(`<name>_drift`) and is dropped again afterwards.

The run caught one real difference on its first day: both incident link keys were unique
INDEXES in production and unique CONSTRAINTS in the tests (models.py now declares the index).
"""

import asyncio
import os
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import command

BACKEND_DIR = Path(__file__).resolve().parents[1]
_URL = os.getenv("DATABASE_URL", "")

pytestmark = pytest.mark.skipif(
    not _URL.startswith("postgresql"), reason="compares against a migrated Postgres; set DATABASE_URL (CI does)"
)


def _drift_url() -> str:
    url = make_url(_URL.replace("postgresql://", "postgresql+asyncpg://", 1))
    return url.set(database=f"{url.database}_drift").render_as_string(hide_password=False)


async def _admin(*statements: str) -> None:
    # CREATE/DROP DATABASE cannot run inside a transaction, nor inside the database it names.
    eng = create_async_engine(_URL.replace("postgresql://", "postgresql+asyncpg://", 1), isolation_level="AUTOCOMMIT")
    try:
        async with eng.connect() as conn:
            for statement in statements:
                await conn.execute(text(statement))
    finally:
        await eng.dispose()


async def _diffs(url: str) -> list:
    from app.database import Base

    def compare(sync_conn):
        return compare_metadata(MigrationContext.configure(sync_conn, opts={"compare_type": True}), Base.metadata)

    eng = create_async_engine(url)
    try:
        async with eng.connect() as conn:
            return await conn.run_sync(compare)
    finally:
        await eng.dispose()


def _relevant(diff) -> bool:
    entry = diff[0] if isinstance(diff, list) else diff  # modify_* diffs come batched in a list
    # alembic's own bookkeeping table is not a model, by design.
    return not (entry[0] == "remove_table" and entry[1].name == "alembic_version")


# Deliberately SYNC: alembic/env.py runs its own asyncio.run(), which cannot nest inside the
# loop pytest-asyncio gives an async test.
def test_migrations_build_the_schema_the_models_declare(monkeypatch):
    import app.models  # noqa: F401  (register every table on Base.metadata)
    from app.config import settings

    url = _drift_url()
    name = make_url(url).database
    asyncio.run(_admin(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)', f'CREATE DATABASE "{name}"'))
    # env.py reads its URL from the app settings. Config() WITHOUT alembic.ini: loading the ini
    # runs fileConfig(), which reconfigures logging for every later test in the process.
    monkeypatch.setattr(settings, "database_url", url)
    cfg = Config()
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    try:
        command.upgrade(cfg, "heads")
        command.downgrade(cfg, "base")
        command.upgrade(cfg, "heads")
        diffs = [d for d in asyncio.run(_diffs(url)) if _relevant(d)]
    finally:
        asyncio.run(_admin(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))

    assert diffs == [], (
        "The migrations and the models disagree. A model change needs a migration "
        '(`uv run alembic revision --autogenerate -m "…"`), and a migration must build what the '
        "model declares. Differences:\n" + "\n".join(repr(d) for d in diffs)
    )

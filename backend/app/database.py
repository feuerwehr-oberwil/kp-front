"""Async SQLAlchemy engine, session factory, and Base."""

from collections.abc import AsyncGenerator
from typing import Any, cast

from fastapi import Depends
from sqlalchemy import Delete, Update
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import settings

engine = create_async_engine(
    settings.database_url,
    echo=False,
    future=True,
    pool_size=10,
    max_overflow=10,
    pool_timeout=30,
    pool_recycle=1800,
    pool_pre_ping=True,
)

async_session_maker = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


async def execute_dml(db: AsyncSession, stmt: Delete | Update) -> CursorResult[Any]:
    """`db.execute()` for UPDATE/DELETE, typed so `.rowcount` is actually visible.

    SQLAlchemy types `AsyncSession.execute()` as returning `Result[Any]`, which has no
    `rowcount` — that lives on `CursorResult`, which is what a DML statement really returns.
    One cast here beats the same cast at every sweep and revoke call site.
    """
    return cast("CursorResult[Any]", await db.execute(stmt))


async def _committing_session() -> AsyncGenerator[AsyncSession, None]:
    """One session, one transaction, for the whole request — committed when the endpoint returns.

    ⚠️ The `scope="function"` on the `Depends` below is the load-bearing part, not decoration.
    FastAPI runs the exit code of a dependency-with-yield at REQUEST scope by default, which is
    *after* the response has already gone out on the wire (fastapi/routing.py: the response is
    sent inside the request exit stack). So the commit landed after the client had its 200 —
    and a client that immediately re-read what it had just written raced its own write and lost,
    measurably: a tight write-then-read loop against a single uvicorn worker read the PRE-write
    state 23 times in 300. That is what «gespeichert» over an unchanged table was, and why an
    operator saved a second time. At function scope the commit runs when the path-operation
    function ends and BEFORE the response is sent, so read-your-own-write holds again.

    The transaction boundary is unchanged — still the whole endpoint, so multi-step writes
    (station_workbook's personnel + config import, personnel.adopt_ranks) still roll back
    together on a later failure. What moves is only *when* the commit is flushed relative to
    the response. The one thing function scope forbids is using the session AFTER the endpoint
    returns — background tasks or a StreamingResponse body reading from `db`. This app has
    neither (the only streaming responses are FileResponse off disk); if one is ever added, it
    must open its own session rather than pushing this back to request scope.
    """
    async with async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def get_db(session: AsyncSession = Depends(_committing_session, scope="function")) -> AsyncSession:
    """FastAPI dependency: a committing async session.

    A thin non-generator wrapper so all ~130 `Depends(get_db)` call sites keep working unchanged
    while the scope that actually decides *when* the commit runs is declared in exactly one
    place. `scope` lives on the `Depends`, never on the dependency function, so a plain
    `async def get_db()` generator has no way to ask for it.
    """
    return session

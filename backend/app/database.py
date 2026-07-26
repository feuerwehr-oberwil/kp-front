"""Async SQLAlchemy engine, session factory, and Base."""

from collections.abc import AsyncGenerator
from typing import Any, cast

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


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency: a committing async session."""
    async with async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()

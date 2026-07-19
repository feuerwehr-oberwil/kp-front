"""DB-backed JWT JTI blocklist with opportunistic + periodic pruning.

Revoked/logged-out tokens are persisted in the ``revoked_tokens`` table so they stay
revoked across restarts and across multiple instances (the previous in-memory store
silently re-validated them on restart / on a second instance).

The public interface (``revoke`` / ``is_revoked`` / ``cleanup_expired`` and the cleanup
task lifecycle) is unchanged, so ``dependencies.py``, ``router.py`` and ``cookies.py``
don't change. The store opens its own short-lived session per call via the app session
factory; callers therefore still pass no DB handle. This runs on every authenticated
request, so ``is_revoked`` is a single indexed primary-key lookup.
"""

import asyncio
import logging
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..models import RevokedToken

logger = logging.getLogger(__name__)


class TokenBlocklist:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession] | None = None) -> None:
        # Resolved lazily so importing this module never forces the engine to build
        # (keeps the pure/unit tests import-safe) and so tests can inject a test factory.
        self._session_factory = session_factory
        self._cleanup_task: asyncio.Task | None = None
        self._cleanup_interval = 3600

    def _factory(self) -> async_sessionmaker[AsyncSession]:
        if self._session_factory is None:
            from ..database import async_session_maker

            self._session_factory = async_session_maker
        return self._session_factory

    # --- cleanup task lifecycle (unchanged interface) ------------------------------

    async def start_cleanup_task(self) -> None:
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
            logger.info("Token blocklist cleanup task started")

    async def stop_cleanup_task(self) -> None:
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None

    async def _cleanup_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._cleanup_interval)
                await self.cleanup_expired()
            except asyncio.CancelledError:
                break
            except Exception as e:  # noqa: BLE001
                logger.error(f"Token blocklist cleanup error: {e}")

    # --- public store API (unchanged signatures) -----------------------------------

    async def revoke(self, jti: str, expires_at: datetime) -> None:
        """Persist a token's JTI as revoked until its own expiry (idempotent)."""
        async with self._factory()() as session:
            await self._revoke(session, jti, expires_at)
            await session.commit()

    async def is_revoked(self, jti: str) -> bool:
        """Hot path: single indexed PK lookup; ``True`` iff the JTI is blocklisted."""
        async with self._factory()() as session:
            found = (
                await session.execute(select(RevokedToken.jti).where(RevokedToken.jti == jti))
            ).scalar_one_or_none()
            return found is not None

    async def cleanup_expired(self) -> int:
        """Delete rows whose tokens have already expired; returns rows removed."""
        async with self._factory()() as session:
            now = datetime.now(UTC)
            result = await session.execute(delete(RevokedToken).where(RevokedToken.expires_at <= now))
            await session.commit()
            return result.rowcount or 0

    # --- internals -----------------------------------------------------------------

    async def _revoke(self, session: AsyncSession, jti: str, expires_at: datetime) -> None:
        """Upsert one revocation. Uses an ON CONFLICT no-op on postgres; falls back to a
        select-then-insert elsewhere (e.g. SQLite in tests) so a double-logout is a no-op,
        never an IntegrityError on the auth hot path."""
        # Opportunistic prune so the table can't grow unbounded between periodic sweeps.
        await session.execute(delete(RevokedToken).where(RevokedToken.expires_at <= datetime.now(UTC)))

        dialect = session.bind.dialect.name if session.bind is not None else ""
        if dialect == "postgresql":
            stmt = (
                pg_insert(RevokedToken)
                .values(jti=jti, expires_at=expires_at)
                .on_conflict_do_nothing(index_elements=["jti"])
            )
            await session.execute(stmt)
            return

        exists = (
            await session.execute(select(RevokedToken.jti).where(RevokedToken.jti == jti))
        ).scalar_one_or_none()
        if exists is None:
            session.add(RevokedToken(jti=jti, expires_at=expires_at))


token_blocklist = TokenBlocklist()

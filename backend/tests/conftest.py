"""Async DB test harness for the integration tests.

Runs against ``DATABASE_URL`` when set (CI provides a postgres:16 service), otherwise an
ephemeral in-memory SQLite (``sqlite+aiosqlite``). The postgres-specific column types
(JSONB, the postgres UUID) are taught to render on SQLite via lightweight ``@compiles``
shims so the *whole* schema — incidents, audit chain, revoked_tokens — stands up locally
without a database server. Every timestamp column in the schema declares
``DateTime(timezone=True)``; SQLite's own DATETIME impl silently drops the tzinfo on write
and hands back a naive datetime on read, which is not what asyncpg does, so that impl is
swapped for one that reattaches UTC on the way out. Behaviour the tests assert
(optimistic-lock UPDATE, blocklist PK lookup, hash chain) is dialect-agnostic, so SQLite is
a faithful stand-in here.

Fixtures:
- ``engine`` / ``db_session``: a rolled-back async session per test.
- ``client``: an httpx AsyncClient wired to the FastAPI app with ``get_db`` overridden
  and the token blocklist pointed at the test session factory.
- ``editor`` / ``viewer``: seeded users with a known PIN.
"""

import os

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Ensure config accepts a secret in local runs before app modules import settings.
os.environ.setdefault(
    "SECRET_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",  # gitleaks:allow
)
# Configure the deployment-admin secret so the admin surface is ENABLED under test (fail-closed
# otherwise). Tests unlock it via the ``admin_login`` fixture; ``test_admin_auth`` overrides it
# to exercise the unset / fail-closed path.
TEST_ADMIN_SECRET = "test-admin-secret-0123456789ab"
os.environ.setdefault("ADMIN_SECRET", TEST_ADMIN_SECRET)

TEST_PIN = "135790"[:6]


def _install_sqlite_shims() -> None:
    """Teach SQLite to render the postgres-only column types used across the schema, and to
    round-trip a tz-aware ``DateTime`` the way a real Postgres/asyncpg pair does."""
    from datetime import UTC

    from sqlalchemy import DateTime
    from sqlalchemy.dialects import sqlite as sqlite_dialect
    from sqlalchemy.dialects.postgresql import JSONB, UUID
    from sqlalchemy.dialects.sqlite.pysqlite import SQLiteDialect_pysqlite
    from sqlalchemy.ext.compiler import compiles

    @compiles(JSONB, "sqlite")
    def _compile_jsonb(type_, compiler, **kw):
        return "JSON"

    @compiles(UUID, "sqlite")
    def _compile_uuid(type_, compiler, **kw):
        return "CHAR(36)"

    class _TZAwareSQLiteDateTime(sqlite_dialect.DATETIME):
        """Same on-disk string as SQLite's own DATETIME impl; only the read side differs,
        reattaching UTC so a ``timezone=True`` column answers with an aware datetime here
        too — every timestamp in this schema declares one, so nothing here is ever meant
        to stay naive."""

        def result_processor(self, dialect, coltype):
            process = super().result_processor(dialect, coltype)

            def process_and_localize(value):
                value = process(value)
                return value.replace(tzinfo=UTC) if value is not None and value.tzinfo is None else value

            return process_and_localize

    # `aiosqlite`'s dialect has no colspecs of its own — it inherits pysqlite's, which is
    # where `DateTime` actually resolves to SQLite's DATETIME impl. Mutated in place (not
    # reassigned) so that inheritance keeps seeing it.
    SQLiteDialect_pysqlite.colspecs[DateTime] = _TZAwareSQLiteDateTime


@pytest.fixture(scope="session")
def database_url() -> str:
    url = os.getenv("DATABASE_URL")
    if not url:
        return "sqlite+aiosqlite:///:memory:"
    if url.startswith("postgresql://") and "+asyncpg" not in url:
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


@pytest_asyncio.fixture
async def engine(database_url: str):
    is_sqlite = database_url.startswith("sqlite")
    if is_sqlite:
        _install_sqlite_shims()

    # A single shared in-memory connection so the schema persists across sessions
    # within one test (StaticPool keeps the same connection).
    kwargs: dict = {}
    if is_sqlite:
        from sqlalchemy.pool import StaticPool

        kwargs = {"poolclass": StaticPool, "connect_args": {"check_same_thread": False}}

    eng = create_async_engine(database_url, **kwargs)

    import app.models  # noqa: F401  (register tables on Base.metadata)
    from app.database import Base

    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield eng
    finally:
        async with eng.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await eng.dispose()


@pytest.fixture(autouse=True)
def _clean_credential_cache():
    """The integration-credential store caches its DB rows process-wide (app/credentials).

    Each test gets its own database, so a value one test stored would otherwise still be in
    the snapshot for the next one. The environment half is not cached at all, so a
    ``monkeypatch.setattr(settings, …)`` is live immediately either way.
    """
    from app.credentials import reset_cache

    reset_cache()
    yield
    reset_cache()


@pytest_asyncio.fixture
async def session_factory(engine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False, autoflush=False)


@pytest_asyncio.fixture
async def db_session(session_factory) -> AsyncSession:
    async with session_factory() as session:
        yield session


@pytest_asyncio.fixture
async def client(engine, session_factory):
    """FastAPI app with get_db overridden onto the test DB and a real cookie jar."""
    import httpx

    from app.auth.capture_limiter import capture_limiter, position_limiter
    from app.auth.token_blocklist import token_blocklist
    from app.database import get_db
    from app.main import app

    # In-memory per-IP bucket persists across tests (module singleton) — start each test full
    # so a burst-draining rate-limit test can't starve unrelated capture tests. The position
    # bucket is a SECOND singleton with its own sizing; leaving it undrained made a whole file
    # of position tests order-dependent (adding one POST early failed a test much further down).
    capture_limiter.reset()
    position_limiter.reset()

    async def _override_get_db():
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = _override_get_db
    # Point the persisted blocklist at the test DB (auth hot path).
    prev_factory = token_blocklist._session_factory
    token_blocklist._session_factory = session_factory

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()
    token_blocklist._session_factory = prev_factory


async def _make_user(session: AsyncSession, *, username: str, role: str):
    from app.auth.security import hash_pin
    from app.models import User

    user = User(
        username=username,
        pin_hash=hash_pin(TEST_PIN),
        role=role,
        display_name=username.title(),
        is_active=True,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


@pytest_asyncio.fixture
async def editor(db_session: AsyncSession):
    return await _make_user(db_session, username="cmd", role="editor")


@pytest_asyncio.fixture
async def viewer(db_session: AsyncSession):
    return await _make_user(db_session, username="view", role="viewer")


@pytest.fixture
def admin_login():
    """Unlock the deployment-admin surface on a client (sets the admin-session cookie).
    Independent of the kiosk login — admin authority is the shared ADMIN_SECRET."""

    async def _unlock(client) -> None:
        r = await client.post("/api/admin/login", json={"secret": TEST_ADMIN_SECRET})
        assert r.status_code == 200, r.text

    return _unlock

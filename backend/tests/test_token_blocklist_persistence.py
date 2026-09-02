"""The persisted JWT blocklist must survive a fresh store instance / new session.

This is the security regression the in-memory blocklist had: a revoked (logged-out or
rotated) token silently became valid again after a restart or on a second instance.
These run against the test DB (SQLite locally, postgres in CI).
"""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from app.auth.token_blocklist import TokenBlocklist

pytestmark = pytest.mark.asyncio


async def test_revoke_then_blocked_in_a_fresh_store(session_factory):
    """A second TokenBlocklist instance (simulating a restart / other instance) still
    sees the revocation, because it lives in the DB, not process memory."""
    jti = "jti-restart-1"
    exp = datetime.now(UTC) + timedelta(hours=1)

    writer = TokenBlocklist(session_factory=session_factory)
    await writer.revoke(jti, exp)

    # Brand-new instance, no shared in-memory state.
    reader = TokenBlocklist(session_factory=session_factory)
    assert await reader.is_revoked(jti) is True
    assert await reader.is_revoked("never-revoked") is False


async def test_revoke_is_idempotent(session_factory):
    """A double logout (revoking the same jti twice) is a no-op, not an error."""
    store = TokenBlocklist(session_factory=session_factory)
    jti = "jti-double"
    exp = datetime.now(UTC) + timedelta(hours=1)
    await store.revoke(jti, exp)
    await store.revoke(jti, exp)  # must not raise
    assert await store.is_revoked(jti) is True


async def test_expired_revocations_are_pruned(session_factory):
    """Expired revocations are removed (opportunistically on write and by cleanup), while
    live ones survive — so the table can't grow without bound and a stale jti can't linger.
    """
    store = TokenBlocklist(session_factory=session_factory)
    live = datetime.now(UTC) + timedelta(hours=1)

    # Insert a live revocation and an already-expired one.
    await store.revoke("live", live)
    # Write the expired row directly so the opportunistic prune doesn't remove it first.
    async with session_factory() as s:
        from app.models import RevokedToken

        s.add(RevokedToken(jti="stale", expires_at=datetime.now(UTC) - timedelta(seconds=1)))
        await s.commit()

    removed = await store.cleanup_expired()
    assert removed == 1
    assert await store.is_revoked("stale") is False
    assert await store.is_revoked("live") is True


async def test_logout_revocation_blocks_the_token_end_to_end(client, editor):
    """Login → /me works → logout → the same access cookie is rejected (DB-backed)."""
    login = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert login.status_code == 200

    assert (await client.get("/api/auth/me")).status_code == 200

    access_token = login.cookies.get("access_token")
    assert access_token, "login did not set access_token cookie"

    assert (await client.post("/api/auth/logout")).status_code == 200

    # logout cleared the cookie jar; re-attach the (now revoked) access token explicitly to
    # prove the blocklist — not just the missing cookie — is what rejects it.
    client.cookies.set("access_token", access_token)
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_consume_is_atomic_first_wins_replay_loses(session_factory):
    """``consume`` fuses the refresh-token check + rotation into one statement: exactly one
    caller inserts (``True``), any replay of the same jti is refused (``False``), and the jti
    ends up revoked either way."""
    store = TokenBlocklist(session_factory=session_factory)
    jti = "jti-consume"
    exp = datetime.now(UTC) + timedelta(hours=1)

    assert await store.consume(jti, exp) is True
    assert await store.consume(jti, exp) is False  # replay of an already-consumed refresh token
    assert await store.is_revoked(jti) is True


async def test_factory_lazily_resolves_and_caches_the_app_session_maker(session_factory, monkeypatch):
    """With no factory injected (the production wiring — every other test here injects the
    test session factory explicitly), ``_factory()`` lazily imports the app's own
    ``async_session_maker`` on first use and caches it, rather than resolving it at import
    time (which would force engine construction just from importing this module)."""
    import app.database as database_module

    monkeypatch.setattr(database_module, "async_session_maker", session_factory)
    store = TokenBlocklist()  # no factory injected: exercises the lazy-import branch
    assert store._session_factory is None

    jti = "jti-default-factory"
    exp = datetime.now(UTC) + timedelta(hours=1)
    await store.revoke(jti, exp)

    assert store._session_factory is session_factory  # resolved once, then cached
    assert await store.is_revoked(jti) is True


async def test_cleanup_task_lifecycle_prunes_periodically_and_survives_loop_errors(session_factory):
    """``start_cleanup_task`` / ``stop_cleanup_task`` manage the periodic sweep; the loop
    itself must (a) actually call ``cleanup_expired`` on its own schedule and (b) log and
    keep running past a failed sweep rather than dying (the ``except Exception`` branch) —
    a single flaky iteration must not silently end all future pruning until the next
    process restart."""
    from app.models import RevokedToken

    store = TokenBlocklist(session_factory=session_factory)
    store._cleanup_interval = 0  # near-instant tick, keeps the test fast

    async with session_factory() as s:
        s.add(RevokedToken(jti="loop-stale", expires_at=datetime.now(UTC) - timedelta(seconds=1)))
        await s.commit()

    calls = 0
    second_sweep_committed = asyncio.Event()
    real_cleanup_expired = store.cleanup_expired

    async def flaky_cleanup_expired():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("simulated sweep failure")
        result = await real_cleanup_expired()
        second_sweep_committed.set()  # only after the delete actually committed
        return result

    store.cleanup_expired = flaky_cleanup_expired

    await store.start_cleanup_task()
    assert store._cleanup_task is not None
    try:
        # Wait for the failing first iteration and the succeeding, committed second one —
        # not just the call count, which ticks before its own delete/commit finishes and
        # would otherwise race stop_cleanup_task's cancel against that commit.
        await asyncio.wait_for(second_sweep_committed.wait(), timeout=5)
        assert calls >= 2, "cleanup loop did not survive the first iteration's error"
    finally:
        await store.stop_cleanup_task()

    assert store._cleanup_task is None
    assert await store.is_revoked("loop-stale") is False  # the surviving second sweep pruned it


async def test_is_revoked_raises_rather_than_reporting_not_revoked_when_db_is_unavailable(monkeypatch):
    """An unreachable DB must not read as "token is fine". ``is_revoked`` has no
    try/except around the query, so a connection failure propagates as an exception instead
    of being swallowed into ``False`` — and ``dependencies.py`` doesn't catch anything but
    ``(JWTError, ValueError)`` either, so the request 500s rather than authenticating on a
    token nobody could actually check. This is the fail-closed behaviour the code actually
    has today (a broad except-and-return-False here would be the security bug); this test
    pins that it stays this way.
    """
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    # A port nothing listens on: the connection is refused immediately, no real network wait.
    broken_engine = create_async_engine("postgresql+asyncpg://nope:nope@127.0.0.1:1/nope")
    broken_factory = async_sessionmaker(broken_engine, class_=AsyncSession, expire_on_commit=False)
    store = TokenBlocklist(session_factory=broken_factory)

    with pytest.raises(Exception):  # the point is "raises", not a specific DB-driver exception type
        await store.is_revoked("whatever")

    await broken_engine.dispose()

"""The persisted JWT blocklist must survive a fresh store instance / new session.

This is the security regression the in-memory blocklist had: a revoked (logged-out or
rotated) token silently became valid again after a restart or on a second instance.
These run against the test DB (SQLite locally, postgres in CI).
"""

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

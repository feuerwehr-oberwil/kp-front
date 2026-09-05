"""SEC-05: rotating a credential must end the sessions that credential opened.

An admin who resets a PIN is doing the one thing an operator reasonably reads as «throw the
intruder out». Until the auth generation existed, the old access cookie and the old refresh
cookie both kept working, and each refresh minted a fresh seven-day successor — so the reset
changed nothing for whoever was already inside.
"""

import asyncio

import httpx
import pytest

from app.auth.security import create_access_token, create_refresh_token

pytestmark = pytest.mark.asyncio

PIN = "135790"
NEW_PIN = "246803"


async def _login(user, pin: str = PIN) -> tuple[str, str]:
    """Log in on a throwaway cookie jar; return that session's (access, refresh) tokens.

    Deliberately not on the shared `client`: the admin calls below run on that one, and an
    admin request that also carries the user's own login is refused as self-administration.
    """
    async with _bearer() as fresh:
        r = await fresh.post("/api/auth/login", json={"user_id": str(user.id), "pin": pin})
    assert r.status_code == 200, r.text
    return r.cookies["access_token"], r.cookies["refresh_token"]


def _bearer(**cookies: str) -> httpx.AsyncClient:
    """A client carrying exactly the cookies named — never the shared jar's."""
    from app.main import app

    contender = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    for name, value in cookies.items():
        contender.cookies.set(name, value)
    return contender


async def _reset_pin(client, admin_login, user, pin: str = NEW_PIN) -> None:
    await admin_login(client)
    r = await client.post(f"/api/auth/users/{user.id}/pin", json={"pin": pin})
    assert r.status_code == 200, r.text


async def test_pin_reset_invalidates_the_old_access_cookie(client, editor, admin_login):
    access, _refresh = await _login(editor)

    await _reset_pin(client, admin_login, editor)

    async with _bearer(access_token=access) as old:
        assert (await old.get("/api/auth/me")).status_code == 401


async def test_pin_reset_invalidates_the_old_refresh_cookie(client, editor, admin_login):
    _access, refresh = await _login(editor)

    await _reset_pin(client, admin_login, editor)

    async with _bearer(refresh_token=refresh) as old:
        assert (await old.post("/api/auth/refresh")).status_code == 401


async def test_concurrent_refresh_of_a_revoked_token_mints_no_successor(client, editor, admin_login):
    """The rotation race must not leave a window where one contender still gets a new pair."""
    _access, refresh = await _login(editor)
    await _reset_pin(client, admin_login, editor)

    async def present_once():
        async with _bearer(refresh_token=refresh) as contender:
            return await contender.post("/api/auth/refresh")

    first, second = await asyncio.gather(present_once(), present_once())

    assert [first.status_code, second.status_code] == [401, 401]


async def test_refresh_issued_before_the_reset_cannot_outlive_it_via_rotation(client, editor, admin_login):
    """Refreshing once before the reset does not buy a session that survives it."""
    _access, refresh = await _login(editor)

    async with _bearer(refresh_token=refresh) as session:
        rotated = await session.post("/api/auth/refresh")
        assert rotated.status_code == 200
        successor_access = rotated.cookies["access_token"]
        successor_refresh = rotated.cookies["refresh_token"]

    await _reset_pin(client, admin_login, editor)

    async with _bearer(access_token=successor_access, refresh_token=successor_refresh) as old:
        assert (await old.get("/api/auth/me")).status_code == 401
        assert (await old.post("/api/auth/refresh")).status_code == 401


async def test_login_with_the_new_pin_still_works_after_the_reset(client, editor, admin_login):
    await _reset_pin(client, admin_login, editor)

    access, _refresh = await _login(editor, pin=NEW_PIN)

    async with _bearer(access_token=access) as fresh:
        assert (await fresh.get("/api/auth/me")).status_code == 200


async def test_resetting_one_pin_leaves_other_users_signed_in(client, editor, viewer, admin_login):
    other_access, other_refresh = await _login(viewer)

    await _reset_pin(client, admin_login, editor)

    async with _bearer(access_token=other_access, refresh_token=other_refresh) as bystander:
        assert (await bystander.get("/api/auth/me")).status_code == 200
        assert (await bystander.post("/api/auth/refresh")).status_code == 200


async def test_reactivation_does_not_revive_sessions_from_before_the_deactivation(client, editor, admin_login):
    """Deactivating is the other «throw them out» gesture; reactivating must not undo it."""
    access, refresh = await _login(editor)
    await admin_login(client)
    # The last active editor may not be deactivated at all — give the station a second one.
    spare = await client.post(
        "/api/auth/users",
        json={"username": "spare", "display_name": "Spare", "role": "editor", "pin": PIN},
    )
    assert spare.status_code == 201, spare.text

    off = await client.patch(f"/api/auth/users/{editor.id}", json={"is_active": False})
    assert off.status_code == 200, off.text
    on = await client.patch(f"/api/auth/users/{editor.id}", json={"is_active": True})
    assert on.status_code == 200, on.text

    async with _bearer(access_token=access, refresh_token=refresh) as revived:
        assert (await revived.get("/api/auth/me")).status_code == 401
        assert (await revived.post("/api/auth/refresh")).status_code == 401


async def test_tokens_minted_before_the_generation_claim_existed_keep_working(client, editor):
    """Deploy compatibility: a cookie in flight has no `gen` and is read as generation 0 —
    the generation every existing row starts at. The first revocation still ends it."""
    legacy = {"sub": str(editor.id), "username": editor.username, "role": editor.role}

    async with _bearer(access_token=create_access_token(legacy)) as inflight:
        assert (await inflight.get("/api/auth/me")).status_code == 200


async def test_a_pre_deploy_token_dies_at_the_first_reset(client, editor, admin_login):
    legacy = {"sub": str(editor.id), "username": editor.username, "role": editor.role}
    access = create_access_token(legacy)
    refresh = create_refresh_token(legacy)

    await _reset_pin(client, admin_login, editor)

    async with _bearer(access_token=access, refresh_token=refresh) as old:
        assert (await old.get("/api/auth/me")).status_code == 401
        assert (await old.post("/api/auth/refresh")).status_code == 401

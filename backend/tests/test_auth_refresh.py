"""Refresh-token validation and one-time atomic rotation."""

import asyncio
from datetime import UTC, datetime, timedelta

import httpx
import jwt
import pytest
from sqlalchemy import update

from app.auth.security import create_refresh_token, successor_jti
from app.config import settings
from app.models import RevokedToken
from tests.conftest import TEST_PIN

pytestmark = pytest.mark.asyncio


def _jti(token: str) -> str:
    return jwt.decode(token, options={"verify_signature": False})["jti"]


def _bearer(**cookies: str) -> httpx.AsyncClient:
    """A client carrying exactly the cookies named — one browser's jar, nobody else's."""
    from app.main import app

    contender = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    for name, value in cookies.items():
        contender.cookies.set(name, value)
    return contender


async def _login(user) -> str:
    """Log in on a throwaway jar; return that session's refresh token."""
    async with _bearer() as fresh:
        r = await fresh.post("/api/auth/login", json={"user_id": str(user.id), "pin": TEST_PIN})
    assert r.status_code == 200, r.text
    return r.cookies["refresh_token"]


async def _refresh(token: str) -> httpx.Response:
    async with _bearer(refresh_token=token) as session:
        return await session.post("/api/auth/refresh")


@pytest.mark.parametrize("claims", [{}, {"sub": "not-a-uuid"}, {"sub": None}])
async def test_refresh_rejects_invalid_subject_claim(client, claims):
    client.cookies.set("refresh_token", create_refresh_token(claims))

    response = await client.post("/api/auth/refresh")

    assert response.status_code == 401
    assert response.json() == {"detail": "Ungültiges Refresh-Token"}


async def test_concurrent_refresh_replay_mints_exactly_one_successor(client, editor):
    """Two requests presenting the same valid token cannot mint two successors.

    Both may be ANSWERED (a just-consumed token is re-delivered, see the lost-answer tests
    below), but with one and the same successor jti — never a second, independent session.
    """
    token = create_refresh_token({"sub": str(editor.id), "username": editor.username, "role": editor.role})

    first, second = await asyncio.gather(_refresh(token), _refresh(token))

    answered = [r for r in (first, second) if r.status_code == 200]
    assert answered, (first.text, second.text)
    assert {_jti(r.cookies["refresh_token"]) for r in answered} == {successor_jti(_jti(token))}


async def test_concurrent_refresh_without_grace_answers_exactly_once(client, editor, monkeypatch):
    """With the grace window off, rotation is strictly one-time again: 200 + 401."""
    monkeypatch.setattr(settings, "refresh_reuse_grace_seconds", 0)
    token = create_refresh_token({"sub": str(editor.id), "username": editor.username, "role": editor.role})

    first, second = await asyncio.gather(_refresh(token), _refresh(token))

    assert sorted([first.status_code, second.status_code]) == [200, 401]
    refused = first if first.status_code == 401 else second
    assert refused.json() == {"detail": "Refresh-Token widerrufen"}


# --- A rotation whose answer never arrived (e2e «session renewal», 24.09.2026) -------------
# The old page's 401 started a refresh, the reload tore the page down while the POST was in
# flight: the server had consumed the token, the browser never stored the successor, and the
# reloaded page presented the consumed token — «Refresh-Token widerrufen», kiosk login.


async def test_a_lost_rotation_answer_is_delivered_again(client, editor):
    old = await _login(editor)
    lost = await _refresh(old)  # the server rotates; this answer never reaches the cookie jar
    assert lost.status_code == 200

    again = await _refresh(old)

    assert again.status_code == 200, again.text
    assert _jti(again.cookies["refresh_token"]) == _jti(lost.cookies["refresh_token"])
    async with _bearer(access_token=again.cookies["access_token"]) as page:
        assert (await page.get("/api/auth/me")).status_code == 200


async def test_a_consumed_token_is_refused_once_its_successor_was_used(client, editor):
    """The client evidently got the successor and moved on — the old token is a replay now."""
    old = await _login(editor)
    successor = (await _refresh(old)).cookies["refresh_token"]
    assert (await _refresh(successor)).status_code == 200

    replay = await _refresh(old)

    assert replay.status_code == 401
    assert replay.json() == {"detail": "Refresh-Token widerrufen"}


async def test_a_consumed_token_is_refused_after_the_grace_window(client, editor, db_session):
    old = await _login(editor)
    assert (await _refresh(old)).status_code == 200
    long_ago = datetime.now(UTC) - timedelta(seconds=settings.refresh_reuse_grace_seconds + 5)
    await db_session.execute(update(RevokedToken).where(RevokedToken.jti == _jti(old)).values(revoked_at=long_ago))
    await db_session.commit()

    assert (await _refresh(old)).status_code == 401


async def test_logout_ends_the_chain_including_the_grace_window(client, editor):
    """Neither the logged-out token nor the one it replaced can buy a session back."""
    old = await _login(editor)
    rotated = await _refresh(old)
    current = rotated.cookies["refresh_token"]

    async with _bearer(access_token=rotated.cookies["access_token"], refresh_token=current) as page:
        assert (await page.post("/api/auth/logout")).status_code == 200

    assert (await _refresh(current)).status_code == 401
    assert (await _refresh(old)).status_code == 401


async def test_logout_before_any_rotation_is_final(client, editor):
    token = await _login(editor)

    async with _bearer(refresh_token=token) as page:
        assert (await page.post("/api/auth/logout")).status_code == 200

    assert (await _refresh(token)).status_code == 401

"""Refresh-token validation and one-time atomic rotation."""

import asyncio

import httpx
import pytest

from app.auth.security import create_refresh_token

pytestmark = pytest.mark.asyncio


@pytest.mark.parametrize("claims", [{}, {"sub": "not-a-uuid"}, {"sub": None}])
async def test_refresh_rejects_invalid_subject_claim(client, claims):
    client.cookies.set("refresh_token", create_refresh_token(claims))

    response = await client.post("/api/auth/refresh")

    assert response.status_code == 401
    assert response.json() == {"detail": "Ungültiges Refresh-Token"}


async def test_concurrent_refresh_replay_mints_exactly_one_successor(client, editor):
    """Two requests presenting the same valid token cannot both pass rotation."""
    from app.main import app

    token = create_refresh_token({"sub": str(editor.id), "username": editor.username, "role": editor.role})
    transport = httpx.ASGITransport(app=app)

    async def present_once():
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as contender:
            contender.cookies.set("refresh_token", token)
            return await contender.post("/api/auth/refresh")

    first, second = await asyncio.gather(present_once(), present_once())

    assert sorted([first.status_code, second.status_code]) == [200, 401]
    refused = first if first.status_code == 401 else second
    assert refused.json() == {"detail": "Refresh-Token widerrufen"}

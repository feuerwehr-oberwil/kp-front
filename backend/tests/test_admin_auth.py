"""Deployment-admin auth — the ADMIN_SECRET gate that separates station administration
from the incident editor role.

Covers:
- /api/admin/session reports configured/authenticated honestly.
- Wrong secret → 401 (and the right secret → 200 + a working admin session).
- An admin-gated endpoint (GET /api/system) is reachable only WITH an admin session,
  regardless of the editor role.
- Logout revokes the admin session.
- Fail-closed: with ADMIN_SECRET unset, login and every admin endpoint return 403.

Runs against the test DB (SQLite locally, postgres in CI).
"""

import pytest

from tests.conftest import TEST_ADMIN_SECRET

pytestmark = pytest.mark.asyncio


async def test_session_state_before_and_after_login(client):
    before = await client.get("/api/admin/session")
    assert before.json() == {"configured": True, "authenticated": False}

    bad = await client.post("/api/admin/login", json={"secret": "wrong-secret-xxxxxxxx"})
    assert bad.status_code == 401

    ok = await client.post("/api/admin/login", json={"secret": TEST_ADMIN_SECRET})
    assert ok.status_code == 200

    after = await client.get("/api/admin/session")
    assert after.json() == {"configured": True, "authenticated": True}


async def test_admin_endpoint_needs_admin_session_not_editor(client, editor, admin_login):
    # A logged-in editor alone cannot reach an admin endpoint.
    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert (await client.get("/api/system")).status_code == 401

    # Unlocking admin grants access.
    await admin_login(client)
    assert (await client.get("/api/system")).status_code == 200


async def test_admin_session_can_read_admin_inventory_without_kiosk_login(client, admin_login):
    await admin_login(client)
    objects = await client.get("/api/objects")
    incidents = await client.get("/api/incidents")
    reference = await client.get("/api/reference")
    assert objects.status_code == 200, objects.text
    assert incidents.status_code == 200, incidents.text
    assert reference.status_code == 200, reference.text


async def test_logout_revokes_admin_session(client, admin_login):
    await admin_login(client)
    assert (await client.get("/api/system")).status_code == 200

    out = await client.post("/api/admin/logout")
    assert out.status_code == 200

    # cookie cleared → locked out again
    assert (await client.get("/api/admin/session")).json()["authenticated"] is False
    assert (await client.get("/api/system")).status_code == 401


async def test_fail_closed_when_secret_unset(client, monkeypatch):
    # Simulate a deployment that never configured ADMIN_SECRET: the surface is OFF.
    from app.config import settings

    monkeypatch.setattr(settings, "admin_secret", "")

    state = await client.get("/api/admin/session")
    assert state.json() == {"configured": False, "authenticated": False}

    login = await client.post("/api/admin/login", json={"secret": "anything-at-all-here"})
    assert login.status_code == 403

    # every admin endpoint is 403 (not configured), never falling back to the editor PIN
    assert (await client.get("/api/system")).status_code == 403
    assert (await client.put("/api/config", json={"identity": {"appName": "X"}})).status_code == 403

"""Batch E — admin-only system/maintenance status (GET /api/system).

Covers:
- An admin session gets a 200 with the documented dict shape (version/database/counts/storage/integrations).
- The DB liveness probe reports ok:true against the test DB.
- A logged-in user without an admin session is rejected (401).

System is gated on the ADMIN_SECRET session, not the editor role.
Runs against the test DB (SQLite locally, postgres in CI).
"""

import pytest

pytestmark = pytest.mark.asyncio


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def test_system_shape_as_admin(client, editor, admin_login):
    await _login(client, editor)
    await admin_login(client)
    r = await client.get("/api/system")
    assert r.status_code == 200, r.text
    body = r.json()

    # Top-level sections present.
    for key in ("version", "database", "counts", "storage", "integrations"):
        assert key in body

    # Version block.
    assert set(body["version"]) == {"commit", "branch", "env"}
    assert body["version"]["env"] in {"production", "dev"}

    # DB probe is live against the test session.
    assert body["database"] == {"ok": True}

    # Counts — all keys present, ints (>= 0) against the seeded test DB.
    counts = body["counts"]
    for key in ("incidents", "incidents_open", "personnel_active", "users", "reference_datasets"):
        assert key in counts
        assert counts[key] is None or isinstance(counts[key], int)
    # The editor we logged in as is a real user row.
    assert counts["users"] is not None and counts["users"] >= 1

    # Storage block.
    storage = body["storage"]
    for key in ("media_dir", "used_bytes", "file_count", "disk_total_bytes", "disk_free_bytes"):
        assert key in storage
    assert isinstance(storage["used_bytes"], int)
    assert isinstance(storage["file_count"], int)

    # Integrations expose generic capability blocks and retain old flags temporarily.
    integ = body["integrations"]
    assert set(integ) == {
        "diveraConfigured", "traccarConfigured", "sttConfigured", "personnel", "alarms", "vehicles", "providers"
    }
    assert isinstance(integ["diveraConfigured"], bool)
    assert isinstance(integ["traccarConfigured"], bool)
    assert isinstance(integ["sttConfigured"], bool)
    for domain in ("personnel", "alarms", "vehicles"):
        assert set(integ[domain]) == {"provider", "configured", "capabilities"}
        assert isinstance(integ[domain]["configured"], bool)
        assert isinstance(integ[domain]["capabilities"], list)
    registrations = integ["providers"]
    assert {(p["provider"], p["domain"]) for p in registrations} == {
        ("divera", "personnel"), ("divera", "alarms"), ("traccar", "vehicles"),
    }
    assert all(isinstance(p["capabilities"], list) for p in registrations)

    # Connectors — every consumer/producer listed read-only, one row each.
    connectors = {c["id"]: c for c in body["connectors"]}
    assert set(connectors) == {
        "print_relay", "capture", "stats", "divera_webhook", "alarm_webhook", "push", "stt"
    }
    for c in connectors.values():
        assert c["direction"] in {"in", "out"}
        assert isinstance(c["configured"], bool)
    # nothing configured in the bare test env → no state, fail-closed everywhere
    assert connectors["print_relay"]["state"] is None


async def test_system_connector_print_relay_online(client, editor, admin_login, monkeypatch):
    """With the relay secret set and a fresh heartbeat, the connector reports online."""
    from datetime import UTC, datetime

    from app.api import print_relay
    from app.config import settings

    monkeypatch.setattr(settings, "print_agent_secret", "print-agent-secret-0123456789ab")
    monkeypatch.setattr(print_relay, "_last_seen", datetime.now(UTC))
    await _login(client, editor)
    await admin_login(client)
    body = (await client.get("/api/system")).json()
    relay = next(c for c in body["connectors"] if c["id"] == "print_relay")
    assert relay["configured"] is True
    assert relay["state"] == "online"
    assert relay["detail"]  # last_seen iso timestamp


async def test_system_requires_admin(client, editor):
    # A logged-in editor WITHOUT an admin session is locked out.
    await _login(client, editor)
    r = await client.get("/api/system")
    assert r.status_code == 401


async def test_system_requires_auth(client):
    r = await client.get("/api/system")
    assert r.status_code == 401

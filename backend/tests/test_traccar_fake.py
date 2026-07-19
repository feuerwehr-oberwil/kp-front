"""Fake Traccar mode (TRACCAR_FAKE): double-gated injection + serving the fake fleet."""

import pytest

from app.api.traccar import _fake_positions
from app.config import settings

TEST_PIN = "135790"  # conftest's seeded editor PIN

PAYLOAD = [
    {"name": "TLF", "lat": 47.5239, "lng": 7.5706},
    {"name": "MTF", "lat": 47.521, "lng": 7.5665, "speed": 38, "course": 65},
]


@pytest.fixture(autouse=True)
def _clean_fake_store():
    _fake_positions.clear()
    yield
    _fake_positions.clear()


@pytest.fixture
def fake_mode(monkeypatch):
    monkeypatch.setattr(settings, "traccar_fake", True)
    monkeypatch.setattr(settings, "alarm_webhook_secret", "alarm-secret-123")


async def _login_editor(client, editor) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": TEST_PIN})
    assert r.status_code == 200, r.text


async def test_inject_fails_closed_without_flag(client, monkeypatch):
    monkeypatch.setattr(settings, "alarm_webhook_secret", "alarm-secret-123")
    r = await client.post("/api/traccar/fake?secret=alarm-secret-123", json=PAYLOAD)
    assert r.status_code == 403


async def test_inject_fails_closed_without_secret_configured(client, monkeypatch):
    monkeypatch.setattr(settings, "traccar_fake", True)
    monkeypatch.setattr(settings, "alarm_webhook_secret", "")
    r = await client.post("/api/traccar/fake", json=PAYLOAD)
    assert r.status_code == 403


async def test_inject_rejects_wrong_secret(client, fake_mode):
    r = await client.post("/api/traccar/fake", json=PAYLOAD)
    assert r.status_code == 401
    r = await client.post("/api/traccar/fake", json=PAYLOAD, headers={"X-Webhook-Secret": "nope"})
    assert r.status_code == 401


async def test_inject_and_serve_positions(client, fake_mode, editor):
    r = await client.post("/api/traccar/fake?secret=alarm-secret-123", json=PAYLOAD)
    assert r.status_code == 200
    assert r.json() == {"ok": True, "count": 2}

    await _login_editor(client, editor)
    status = await client.get("/api/traccar/status")
    assert status.json() == {"configured": True, "host": "fake"}

    pos = await client.get("/api/traccar/positions")
    assert pos.status_code == 200
    body = pos.json()
    assert [p["device_name"] for p in body] == ["TLF", "MTF"]
    assert body[0]["latitude"] == pytest.approx(47.5239)
    assert body[1]["speed"] == pytest.approx(38)

    trails = await client.get("/api/traccar/trails")
    assert trails.status_code == 200
    assert trails.json() == []


async def test_clear_fake_positions(client, fake_mode, editor):
    r = await client.post("/api/traccar/fake?secret=alarm-secret-123", json=PAYLOAD)
    assert r.status_code == 200
    r = await client.delete("/api/traccar/fake?secret=alarm-secret-123")
    assert r.json() == {"ok": True, "count": 0}

    await _login_editor(client, editor)
    pos = await client.get("/api/traccar/positions")
    assert pos.json() == []


async def test_positions_still_503_when_fake_off_and_unconfigured(client, editor):
    await _login_editor(client, editor)
    pos = await client.get("/api/traccar/positions")
    assert pos.status_code == 503

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


# --- the one answer for every device (24.09.2026) ----------------------------------------


async def test_every_device_is_answered_from_one_traccar_call_per_ten_seconds(monkeypatch):
    """Each open device polls every 15 s; each poll used to be one Traccar LOGIN."""
    import httpx

    import app.traccar as traccar_mod

    calls: list[int] = []
    clock = [100.0]

    class _Client:
        base_url = "https://traccar.example"
        email = "kp@example"

        async def get_vehicle_positions(self):
            calls.append(1)
            if len(calls) == 3:
                raise httpx.ConnectError("down")
            return []

    monkeypatch.setattr(traccar_mod, "traccar_client", _Client())
    monkeypatch.setattr(traccar_mod.time, "monotonic", lambda: clock[0])
    traccar_mod.reset_positions_cache()
    try:
        for _ in range(3):
            await traccar_mod.cached_vehicle_positions()
        assert calls == [1]
        clock[0] += 10.5
        await traccar_mod.cached_vehicle_positions()
        assert calls == [1, 1]
        # a failure is shared the same way — ten devices must not queue ten timeouts
        clock[0] += 10.5
        for _ in range(2):
            with pytest.raises(httpx.ConnectError):
                await traccar_mod.cached_vehicle_positions()
        assert len(calls) == 3
    finally:
        traccar_mod.reset_positions_cache()


async def test_an_injected_fix_time_is_kept(client, fake_mode, editor):
    r = await client.post(
        "/api/traccar/fake?secret=alarm-secret-123",
        json=[{"name": "TLF", "lat": 47.5, "lng": 7.5, "ts": "2026-09-23T17:23:10Z"}],
    )
    assert r.status_code == 200
    assert _fake_positions[0].last_update.isoformat() == "2026-09-23T17:23:10+00:00"

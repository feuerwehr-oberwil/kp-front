"""Outbound incident webhooks (alarms.webhooks) — payload shape + scheduling contract.

Delivery itself is fire-and-forget httpx (not tested against a live server); what matters
is that every creation path schedules with the right payload, that non-http(s) URLs are
dropped, and that a broken webhook layer can never break intake (fail-open)."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app import webhooks
from app.config import settings
from app.models import DeploymentConfig, Incident


@pytest.fixture
def capture_deliveries(monkeypatch):
    calls: list[tuple[str, dict]] = []

    async def fake_deliver(url: str, payload: dict) -> None:
        calls.append((url, payload))

    # patch the coroutine the create_task call wraps — tasks run on the same loop, so a
    # flush of pending tasks is enough for assertions
    monkeypatch.setattr(webhooks, "_deliver", fake_deliver)
    return calls


async def _set_webhooks(db, urls, public_url=None, monkeypatch=None, capture_secret=None):
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1)
        db.add(row)
    row.config_json = {**(row.config_json or {}), "alarms": {"webhooks": urls}}
    if capture_secret is not None:
        row.capture_secret = capture_secret
    await db.commit()
    if public_url is not None and monkeypatch is not None:
        monkeypatch.setattr(settings, "public_url", public_url)


def test_payload_includes_capture_url_only_when_composable(monkeypatch):
    inc = Incident(title="Brand", source="divera", status="offen", auto_opened=True,
                   started_at=datetime.now(UTC))
    monkeypatch.setattr(settings, "public_url", "https://front.example.org")
    p = webhooks.build_incident_payload(inc, "tok123")
    assert p["event"] == "incident.created"
    assert p["capture_url"] == "https://front.example.org/e/tok123"
    assert p["incident"]["title"] == "Brand"

    monkeypatch.setattr(settings, "public_url", "")
    assert webhooks.build_incident_payload(inc, "tok123")["capture_url"] is None
    monkeypatch.setattr(settings, "public_url", "https://front.example.org")
    assert webhooks.build_incident_payload(inc, None)["capture_url"] is None


async def test_generic_intake_schedules_webhooks(client, db_session, monkeypatch, capture_deliveries):
    import asyncio

    monkeypatch.setattr(settings, "alarm_webhook_secret", "s3cret")
    await _set_webhooks(
        db_session, ["https://hook.example.org/a", "ftp://nope.example.org"],
        public_url="https://front.example.org", monkeypatch=monkeypatch, capture_secret="tok",
    )
    r = await client.post(
        "/api/alarms?secret=s3cret",
        json={"source": "leitstelle", "source_id": "X-1", "title": "Brand Dachstock"},
    )
    assert r.status_code == 201
    await asyncio.sleep(0)  # let the scheduled task run (patched to a no-op recorder)
    assert len(capture_deliveries) == 1  # ftp:// dropped
    url, payload = capture_deliveries[0]
    assert url == "https://hook.example.org/a"
    assert payload["incident"]["source"] == "leitstelle"
    assert payload["capture_url"] == "https://front.example.org/e/tok"


async def test_manual_create_schedules_webhooks(client, db_session, editor, monkeypatch, capture_deliveries):
    import asyncio

    await _set_webhooks(db_session, ["https://hook.example.org/b"])
    lr = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert lr.status_code == 200
    r = await client.post("/api/incidents", json={"title": "Übung"})
    assert r.status_code == 201
    await asyncio.sleep(0)
    assert [u for u, _ in capture_deliveries] == ["https://hook.example.org/b"]


async def test_no_webhooks_configured_is_a_noop(client, db_session, editor, capture_deliveries):
    lr = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert lr.status_code == 200
    r = await client.post("/api/incidents", json={"title": "Still"})
    assert r.status_code == 201
    assert capture_deliveries == []

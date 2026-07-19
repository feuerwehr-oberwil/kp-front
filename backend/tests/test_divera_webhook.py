"""Divera webhook auth (POST /api/divera/webhook).

The webhook is unauthenticated by nature (Divera calls it), so the secret is the only
gate between the internet and the alarm pool an editor "takes" into a real incident.
Covers the fail-closed contract:
- no DIVERA_WEBHOOK_SECRET configured → 403 for everyone (webhook disabled);
- configured + wrong/missing secret → 401;
- configured + correct secret (header or ?secret=) → alarm lands in the pool.
"""

import pytest

from app.config import settings

PAYLOAD = {"id": 4711, "title": "Zimmerbrand", "address": "Teststrasse 1", "lat": 47.5, "lng": 7.5}


@pytest.fixture
def webhook_secret(monkeypatch):
    monkeypatch.setattr(settings, "divera_webhook_secret", "hook-secret-123")


async def test_webhook_fails_closed_without_configured_secret(client, monkeypatch):
    monkeypatch.setattr(settings, "divera_webhook_secret", "")
    r = await client.post("/api/divera/webhook", json=PAYLOAD)
    assert r.status_code == 403


async def test_webhook_rejects_missing_or_wrong_secret(client, webhook_secret):
    r = await client.post("/api/divera/webhook", json=PAYLOAD)
    assert r.status_code == 401
    r = await client.post("/api/divera/webhook", json=PAYLOAD, headers={"X-Webhook-Secret": "nope"})
    assert r.status_code == 401
    r = await client.post("/api/divera/webhook?secret=nope", json=PAYLOAD)
    assert r.status_code == 401


async def test_webhook_accepts_correct_secret_and_pools_alarm(client, webhook_secret, editor):
    r = await client.post(
        "/api/divera/webhook", json=PAYLOAD, headers={"X-Webhook-Secret": "hook-secret-123"}
    )
    assert r.status_code == 200
    # incident_id stays None: alarms.autoOpen is off by default, the alarm only pools
    assert r.json() == {"ok": True, "new": True, "incident_id": None}
    # duplicate delivery stays 200 but is not "new"
    r = await client.post("/api/divera/webhook?secret=hook-secret-123", json=PAYLOAD)
    assert r.status_code == 200
    assert r.json()["new"] is False

    # the alarm is visible in the editor's pool
    lr = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert lr.status_code == 200
    pool = await client.get("/api/divera/pool")
    assert pool.status_code == 200
    assert any(a["title"] == "Zimmerbrand" for a in pool.json())

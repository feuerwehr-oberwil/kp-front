"""Outbound incident webhooks (alarms.webhooks) — payload shape + scheduling contract.

Delivery itself is fire-and-forget httpx; most tests above patch `_deliver` out entirely
(scheduling is what they're proving). The tests below patch one layer deeper — a
MockTransport-backed AsyncClient (same technique as test_weather.py) — to exercise
`_deliver`'s own retry/backoff/give-up logic, and the `notify_incident_created` guard that
keeps a broken config lookup from ever reaching alarm intake."""

import logging
from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy import select

from app import alarms, webhooks
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
    inc = Incident(title="Brand", source="divera", status="offen", auto_opened=True, started_at=datetime.now(UTC))
    monkeypatch.setattr(settings, "public_url", "https://front.example.org")
    p = webhooks.build_incident_payload(inc, "tok123")
    assert p["event"] == "incident.created"
    assert p["capture_url"] == "https://front.example.org/e/tok123"
    assert p["incident"]["title"] == "Brand"

    monkeypatch.setattr(settings, "public_url", "")
    assert webhooks.build_incident_payload(inc, "tok123")["capture_url"] is None
    monkeypatch.setattr(settings, "public_url", "https://front.example.org")
    assert webhooks.build_incident_payload(inc, None)["capture_url"] is None


def test_payload_carries_source_ref_so_receivers_can_match_the_alarm():
    """The upstream's own alarm id has to ride along.

    The alarm pipeline holds milestones for an alarm that kp-front hasn't opened yet; this
    event is its signal to deliver them NOW. `source` alone says "a Divera incident opened",
    not which one — so without source_ref the flush can only guess.
    """
    inc = Incident(
        title="Feueralarm", source="divera", source_ref="36591264", status="offen", started_at=datetime.now(UTC)
    )
    assert webhooks.build_incident_payload(inc, None)["incident"]["source_ref"] == "36591264"
    # Manually created incidents have no upstream alarm — the key is present, just null.
    manual = Incident(title="Von Hand", source="manual", status="offen", started_at=datetime.now(UTC))
    assert webhooks.build_incident_payload(manual, None)["incident"]["source_ref"] is None


async def test_generic_intake_schedules_webhooks(client, db_session, monkeypatch, capture_deliveries):
    import asyncio

    monkeypatch.setattr(settings, "alarm_webhook_secret", "s3cret")
    await _set_webhooks(
        db_session,
        ["https://hook.example.org/a", "ftp://nope.example.org"],
        public_url="https://front.example.org",
        monkeypatch=monkeypatch,
        capture_secret="tok",
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


# --- _deliver: retry/backoff/give-up against a mocked transport --------------------------


@pytest.fixture
def patch_httpx_client(monkeypatch):
    """Install a MockTransport-backed httpx.AsyncClient for the duration of a test — the
    same technique as test_weather.py's `patch_httpx`. `_deliver` opens a fresh
    AsyncClient per attempt, so this has to survive being applied more than once."""

    def _install(handler):
        transport = httpx.MockTransport(handler)
        orig_init = httpx.AsyncClient.__init__

        def patched_init(self, *args, **kwargs):
            kwargs["transport"] = transport
            orig_init(self, *args, **kwargs)

        monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)

    return _install


async def test_deliver_succeeds_on_first_attempt(patch_httpx_client):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200)

    patch_httpx_client(handler)
    await webhooks._deliver("https://hook.example.org/x", {"event": "incident.created"})
    assert calls == ["https://hook.example.org/x"]  # no retry once the receiver answers 2xx


async def test_deliver_retries_a_bad_status_then_succeeds(patch_httpx_client, monkeypatch, caplog):
    # A real (nonzero) delay for the second slot — shrunk from 2s/8s so the retry-sleep
    # branch (`if delay: await asyncio.sleep(delay)`) is actually exercised, not skipped.
    monkeypatch.setattr(webhooks, "RETRY_DELAYS_S", (0, 0.01, 0.01))
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        return httpx.Response(500) if len(attempts) < 2 else httpx.Response(204)

    patch_httpx_client(handler)
    with caplog.at_level(logging.WARNING, logger="app.webhooks"):
        await webhooks._deliver("https://hook.example.org/x", {})
    assert len(attempts) == 2
    assert "answered 500" in caplog.text


async def test_deliver_retries_past_a_connection_error(patch_httpx_client, monkeypatch, caplog):
    """The `except Exception` branch — an unreachable receiver, not just a bad status."""
    monkeypatch.setattr(webhooks, "RETRY_DELAYS_S", (0, 0, 0))
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        if len(attempts) == 1:
            raise httpx.ConnectError("refused")
        return httpx.Response(200)

    patch_httpx_client(handler)
    with caplog.at_level(logging.WARNING, logger="app.webhooks"):
        await webhooks._deliver("https://hook.example.org/x", {})
    assert len(attempts) == 2
    assert "failed:" in caplog.text


async def test_deliver_gives_up_after_exhausting_every_retry(patch_httpx_client, monkeypatch, caplog):
    monkeypatch.setattr(webhooks, "RETRY_DELAYS_S", (0, 0, 0))
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        return httpx.Response(503)

    patch_httpx_client(handler)
    with caplog.at_level(logging.WARNING, logger="app.webhooks"):
        await webhooks._deliver("https://hook.example.org/x", {})
    assert len(attempts) == 3  # every RETRY_DELAYS_S slot spent, none left
    assert "gave up after 3 attempts" in caplog.text


# --- notify_incident_created: the config lookup itself must not break intake -------------


async def test_a_broken_config_lookup_cannot_break_intake(db_session, monkeypatch, caplog):
    """`get_alarms_config` is the first thing `notify_incident_created` awaits — if the
    config store itself is unreachable, alarm intake (the caller) must still get its normal
    201, just with zero webhooks queued. This is the outer `except Exception` guard."""

    async def boom(db):
        raise RuntimeError("config store unreachable")

    monkeypatch.setattr(alarms, "get_alarms_config", boom)
    inc = Incident(title="Brand", source="manual", status="offen", started_at=datetime.now(UTC))
    with caplog.at_level(logging.ERROR, logger="app.webhooks"):
        queued = await webhooks.notify_incident_created(db_session, inc)
    assert queued == 0
    assert "Scheduling incident webhooks failed" in caplog.text

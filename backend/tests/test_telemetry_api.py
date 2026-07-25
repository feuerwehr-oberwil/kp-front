"""The consent gate, the two channels, and the forwarder.

The tests worth reading here are the negative ones. Anyone can verify that telemetry works
when it is switched on; what a fire station needs verified is that a fresh install sends
nothing, that revoking consent stops payloads that were already queued, and that the
deployer's env kill switch cannot be overridden from the UI.
"""

import logging

import pytest
from sqlalchemy import select

from app.config import settings
from app.models import DeploymentConfig, TelemetryOutbox
from app.telemetry import consent as consent_mod

pytestmark = pytest.mark.asyncio

A_CRASH = {
    "kind": "render",
    "message": "TypeError: cannot read 'lat' of Einsatz Hauptstrasse 12",
    "stack": "at MapView (/Users/beichenberger/kp-front/src/components/MapView.tsx:88)",
    "path": "/incident/3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    "build": "v0.2.0+a1b2c3d",
}


@pytest.fixture(autouse=True)
def _usable_dsn(monkeypatch):
    """A parseable DSN for the duration of each test.

    The DSN shipped in the repo is a placeholder that deliberately does not parse, so without
    this every test here would be testing the "telemetry is off" path by accident.
    """
    monkeypatch.setattr(settings, "telemetry_dsn", "https://pub1ickey@ingest.test/1")
    monkeypatch.setattr(settings, "telemetry_enabled", True)


async def _set_consent(db, value: str) -> None:
    await consent_mod.set_consent(db, value)
    await db.commit()


async def _queued(db) -> list[TelemetryOutbox]:
    return list((await db.execute(select(TelemetryOutbox))).scalars().all())


# --- The default is silence -----------------------------------------------------------


async def test_fresh_install_queues_nothing(client, db_session):
    # No consent row at all — the state every existing deployment upgrades into.
    r = await client.post("/api/diag/client-error", json=A_CRASH)
    assert r.status_code == 204
    assert await _queued(db_session) == []


async def test_fresh_install_mints_no_id(client, db_session):
    # An instance that never opts in should not even carry an identifier for a thing it
    # never did.
    await client.post("/api/diag/client-error", json=A_CRASH)
    assert await consent_mod.get_install_id(db_session) is None


async def test_local_logging_still_happens_without_consent(client, caplog):
    # Consent gates the SECOND hop only. The station's own log is not telemetry and must
    # keep working — that is the feature that was there before this one.
    with caplog.at_level(logging.WARNING, logger="kpfront.clienterror"):
        await client.post("/api/diag/client-error", json=A_CRASH)
    assert "client-error" in "\n".join(r.getMessage() for r in caplog.records)


# --- Opted in -------------------------------------------------------------------------


async def test_consent_queues_a_sanitised_payload(client, db_session):
    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    r = await client.post("/api/diag/client-error", json=A_CRASH)
    assert r.status_code == 204

    rows = await _queued(db_session)
    assert len(rows) == 1
    assert rows[0].channel == "error"
    assert rows[0].sent_at is None
    wire = str(rows[0].payload_json)
    assert "Hauptstrasse 12" not in wire
    assert "beichenberger" not in wire
    assert "3f2504e0" not in wire
    assert "MapView.tsx" in wire  # still a usable report


async def test_the_exact_payload_is_logged_before_it_is_queued(client, db_session, caplog):
    # The transparency requirement: a deployer running default log levels can read what
    # left, in their own log, without being told to enable anything.
    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    with caplog.at_level(logging.INFO, logger="kp.telemetry"):
        await client.post("/api/diag/client-error", json=A_CRASH)
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "exact content follows" in logged
    assert "MapView.tsx" in logged


async def test_install_id_is_minted_once_and_reused(client, db_session):
    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    await client.post("/api/diag/client-error", json={**A_CRASH, "message": "one"})
    first = await consent_mod.get_install_id(db_session)
    await client.post("/api/diag/client-error", json={**A_CRASH, "message": "two"})
    assert await consent_mod.get_install_id(db_session) == first
    assert first is not None


async def test_hourly_cap_stops_a_wedged_client(client, db_session, monkeypatch):
    from app.api import diag

    monkeypatch.setattr(diag, "MAX_QUEUED_PER_HOUR", 3)
    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    for i in range(6):
        await client.post("/api/diag/client-error", json={**A_CRASH, "message": f"boom {i}"})
    assert len(await _queued(db_session)) == 3


# --- Revoking -------------------------------------------------------------------------


async def test_switching_off_discards_what_was_queued(client, db_session, admin_login):
    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    await client.post("/api/diag/client-error", json=A_CRASH)
    assert len(await _queued(db_session)) == 1

    await admin_login(client)
    r = await client.put("/api/diag/telemetry/consent", json={"consent": "off"})
    assert r.status_code == 200
    assert r.json()["discarded"] == 1
    # "Off" has to mean the queue stops, not that it drains.
    assert await _queued(db_session) == []


async def test_env_kill_switch_outranks_stored_consent(client, db_session, monkeypatch):
    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    monkeypatch.setattr(settings, "telemetry_enabled", False)
    assert await consent_mod.get_consent(db_session) == consent_mod.CONSENT_OFF
    await client.post("/api/diag/client-error", json=A_CRASH)
    assert await _queued(db_session) == []


async def test_blank_dsn_is_also_off(client, db_session, monkeypatch):
    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    monkeypatch.setattr(settings, "telemetry_dsn", "")
    assert await consent_mod.get_consent(db_session) == consent_mod.CONSENT_OFF


async def test_consent_column_rejects_invented_values(db_session):
    with pytest.raises(ValueError, match="consent must be one of"):
        await consent_mod.set_consent(db_session, "everything")


async def test_unknown_stored_consent_reads_as_off(db_session):
    # Defence against a hand-edited DB or a future value rolled back: anything unrecognised
    # is off, never "probably fine".
    db_session.add(DeploymentConfig(id=1, telemetry_consent="usage-and-more"))
    await db_session.commit()
    assert await consent_mod.get_consent(db_session) == consent_mod.CONSENT_OFF


# --- The manual channel ---------------------------------------------------------------


async def test_report_requires_a_logged_in_user(client):
    r = await client.post("/api/diag/report", json={"message": "kaputt"})
    assert r.status_code == 401


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200, r.text


async def test_report_is_queued_without_any_admin_opt_in(client, db_session, editor):
    # Pressing send IS the consent — the background switch is irrelevant here, and this is
    # the difference the whole design rests on.
    await _login(client, editor)
    assert await consent_mod.get_consent(db_session) == consent_mod.CONSENT_OFF

    r = await client.post(
        "/api/diag/report",
        json={"message": "Nach dem Speichern war der Bildschirm weg", "troubleKind": "crash"},
    )
    assert r.status_code == 202
    rows = await _queued(db_session)
    assert len(rows) == 1 and rows[0].channel == "report"


async def test_report_echoes_back_exactly_what_was_queued(client, db_session, editor):
    # The sheet shows a client-built preview; this response is the server confirming the
    # preview was honest. If they could differ, the preview would be theatre.
    await _login(client, editor)
    r = await client.post(
        "/api/diag/report",
        json={"message": "Absturz beim Einsatz Bahnhofstrasse 4, Rückruf 079 123 45 67"},
    )
    assert r.status_code == 202
    echoed = r.json()["sent"]
    rows = await _queued(db_session)
    assert echoed == rows[0].payload_json
    wire = str(echoed)
    assert "Bahnhofstrasse 4" not in wire
    assert "079 123 45 67" not in wire


async def test_report_is_refused_when_the_deployer_disabled_outbound(client, editor, monkeypatch):
    # 503 rather than a silent success: the sheet has to know to fall back to mailto:.
    await _login(client, editor)
    monkeypatch.setattr(settings, "telemetry_enabled", False)
    r = await client.post("/api/diag/report", json={"message": "kaputt"})
    assert r.status_code == 503
    assert r.json()["detail"] == "outbound-disabled"


# --- Admin surface --------------------------------------------------------------------


async def test_telemetry_status_needs_admin(client):
    # 401 = no admin session (403 is reserved for "the surface is disabled entirely").
    # Consent is a deployment decision, so an ordinary kiosk login must not reach it either.
    assert (await client.get("/api/diag/telemetry")).status_code == 401
    assert (await client.put("/api/diag/telemetry/consent", json={"consent": "errors"})).status_code == 401
    assert (await client.post("/api/diag/telemetry/install-id")).status_code == 401


async def test_an_editor_login_is_not_enough_to_switch_telemetry_on(client, editor):
    await _login(client, editor)
    r = await client.put("/api/diag/telemetry/consent", json={"consent": "errors"})
    assert r.status_code == 401


async def test_status_shows_the_queue_verbatim(client, db_session, admin_login):
    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    await client.post("/api/diag/client-error", json=A_CRASH)
    await admin_login(client)

    body = (await client.get("/api/diag/telemetry")).json()
    assert body["consent"] == "errors"
    assert body["pending"] == 1
    assert body["outboundAllowed"] is True
    assert body["recent"][0]["payload"]["tags"]["channel"] == "error"


async def test_status_reports_the_env_override_so_the_ui_can_explain_itself(client, admin_login, monkeypatch):
    await admin_login(client)
    monkeypatch.setattr(settings, "telemetry_enabled", False)
    body = (await client.get("/api/diag/telemetry")).json()
    assert body["outboundAllowed"] is False


async def test_regenerating_the_install_id_cuts_the_link(client, db_session, admin_login):
    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    await client.post("/api/diag/client-error", json=A_CRASH)
    before = await consent_mod.get_install_id(db_session)
    await admin_login(client)

    after = (await client.post("/api/diag/telemetry/install-id")).json()["installId"]
    assert after != before
    await db_session.commit()
    assert await consent_mod.get_install_id(db_session) == after


# --- The forwarder --------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, status_code: int):
        self.status_code = status_code

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300


class _FakeClient:
    """Stands in for httpx.AsyncClient, recording what would have gone over the wire."""

    posted: list[tuple[str, bytes]] = []
    responses: list = []
    raises: Exception | None = None

    def __init__(self, *_, **__):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def post(self, url, content=None, headers=None):
        if _FakeClient.raises:
            raise _FakeClient.raises
        _FakeClient.posted.append((url, content))
        return _FakeClient.responses.pop(0) if _FakeClient.responses else _FakeResponse(200)


@pytest.fixture
def fake_http(monkeypatch):
    from app.telemetry import forwarder

    _FakeClient.posted = []
    _FakeClient.responses = []
    _FakeClient.raises = None
    monkeypatch.setattr(forwarder.httpx, "AsyncClient", _FakeClient)
    return _FakeClient


async def test_flush_delivers_and_marks_sent(client, db_session, fake_http):
    from app.telemetry.forwarder import flush

    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    await client.post("/api/diag/client-error", json=A_CRASH)

    assert await flush(db_session) == 1
    await db_session.commit()
    rows = await _queued(db_session)
    assert rows[0].sent_at is not None
    url, body = fake_http.posted[0]
    assert url == "https://ingest.test/api/1/envelope/"
    assert b"MapView.tsx" in body


async def test_unparseable_dsn_sends_nothing(client, db_session, fake_http, monkeypatch):
    # The DSN is live now, so this can no longer lean on the shipped placeholder. The
    # invariant it actually guards is the one that keeps a misconfiguration quiet instead of
    # dangerous: if the configured DSN cannot be parsed, nothing goes out at all — the rows
    # stay queued and the instance carries on.
    from app.telemetry.forwarder import flush

    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    await client.post("/api/diag/client-error", json=A_CRASH)
    monkeypatch.setattr(settings, "telemetry_dsn", "not-a-dsn://broken")

    assert await flush(db_session) == 0
    assert fake_http.posted == []


async def test_offline_keeps_the_row_queued(client, db_session, fake_http):
    from app.telemetry.forwarder import flush

    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    await client.post("/api/diag/client-error", json=A_CRASH)
    fake_http.raises = OSError("network unreachable")

    assert await flush(db_session) == 0
    await db_session.commit()
    row = (await _queued(db_session))[0]
    assert row.sent_at is None and row.attempts == 1
    assert row.last_error == "OSError"


async def test_rate_limit_stops_the_batch_instead_of_hammering(client, db_session, fake_http):
    from app.telemetry.forwarder import flush

    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    for i in range(3):
        await client.post("/api/diag/client-error", json={**A_CRASH, "message": f"boom {i}"})
    fake_http.responses = [_FakeResponse(429), _FakeResponse(200), _FakeResponse(200)]

    assert await flush(db_session) == 0
    # One attempt, then stop — not three attempts against a closed door.
    assert len(fake_http.posted) == 1


async def test_consent_revoked_between_queue_and_flush_sends_nothing(client, db_session, fake_http, editor):
    # The race the design has to survive: an admin switches off while a payload is queued.
    from app.telemetry.forwarder import flush

    await _set_consent(db_session, consent_mod.CONSENT_ERRORS)
    await client.post("/api/diag/client-error", json=A_CRASH)
    await _login(client, editor)
    await client.post("/api/diag/report", json={"message": "von Hand gemeldet"})
    await _set_consent(db_session, consent_mod.CONSENT_OFF)

    sent = await flush(db_session)
    await db_session.commit()
    # The manual report still goes (its consent was the send button); the background one
    # is dropped, not merely delayed.
    assert sent == 1
    channels = [r.channel for r in await _queued(db_session)]
    assert channels == ["report"]


async def test_flush_is_free_when_telemetry_is_off(db_session, fake_http, monkeypatch):
    from app.telemetry.forwarder import flush

    monkeypatch.setattr(settings, "telemetry_enabled", False)
    assert await flush(db_session) == 0
    assert fake_http.posted == []

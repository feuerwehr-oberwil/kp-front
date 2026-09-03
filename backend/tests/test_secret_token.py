"""The shared secret gate (`app.auth.secret_token`) — the rule seven surfaces now share
(the alarm intake, the Divera and FireHub webhooks, the Traccar fake feed, the print relay,
the statistics export, the Erfassungs-Poster — see the module docstring on `SecretGate`;
an earlier commit message miscounted these as eight and the number stuck in prose here).

Worth its own test because the two refusals are not interchangeable: an unconfigured secret
must fail CLOSED with 403 («this surface is off»), and only a configured-but-wrong token is a
401. A gate that answered 401 for both would still look fine in every integration test, while
a deployment that never set a secret quietly accepted whatever a caller sent.
"""

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from starlette.requests import Request

from app.auth.secret_token import SecretGate
from app.config import settings
from app.models import DeploymentConfig

GATE = SecretGate(query_param="t", disabled_detail="Export deaktiviert", invalid_detail="Ungültiger Token")


def _request(query: str = "") -> Request:
    return Request({"type": "http", "method": "GET", "path": "/x", "query_string": query.encode(), "headers": []})


def test_unset_secret_fails_closed() -> None:
    """No secret configured → 403, even when the caller sends something."""
    for expected in (None, ""):
        with pytest.raises(HTTPException) as e:
            GATE.check(expected, "whatever")
        assert e.value.status_code == 403
        assert e.value.detail == "Export deaktiviert"


@pytest.mark.parametrize("provided", [None, "", "nope"])
def test_missing_or_wrong_token_is_401(provided: str | None) -> None:
    with pytest.raises(HTTPException) as e:
        GATE.check("s3cret", provided)
    assert e.value.status_code == 401
    assert e.value.detail == "Ungültiger Token"


def test_token_accepted_from_query_or_header() -> None:
    """Both travel paths work, and the query parameter wins when both are present."""
    GATE.check_request("s3cret", _request("t=s3cret"), None)
    GATE.check_request("s3cret", _request(), "s3cret")
    GATE.check_request("s3cret", _request("t=s3cret"), "wrong-header")


def test_header_only_gate_ignores_the_query_string() -> None:
    """A gate without a query parameter (the print relay) must not read one — a secret in the
    URL is a secret in every proxy log, and declaring none is how a surface refuses that."""
    header_only = SecretGate(disabled_detail="off", invalid_detail="nope")
    header_only.check_request("s3cret", _request(), "s3cret")
    with pytest.raises(HTTPException) as e:
        header_only.check_request("s3cret", _request("secret=s3cret&t=s3cret"), None)
    assert e.value.status_code == 401


# --- wiring: does each real call site actually plug the gate in, the right way round? -----
#
# The tests above pin the class; they would still pass even if a call site swapped its
# arguments, hard-coded a status, or skipped the gate entirely. These hit the real endpoint
# through the app and pin the STRICT status per surface — not `in (401, 403)`, which is
# exactly the ambiguity the module docstring above warns about and which several other test
# files fell into for the ADJACENT admin-secret-management routes (kept out of scope here;
# this file is about the token gate a caller-facing surface answers with, not the admin
# session that mints the token). A wrong wiring at any one of these seven call sites — a
# swapped detail, a 401 where the surface must fail closed with 403 — fails loudly here
# without having to know which of the seven files elsewhere in this suite would catch it.


async def _set_config_secret(db_session, column: str, value: str | None) -> None:
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db_session.add(row)
    setattr(row, column, value)
    await db_session.commit()


async def test_alarm_intake_gate_is_wired(client, monkeypatch):
    from tests.test_alarm_intake import PAYLOAD

    monkeypatch.setattr(settings, "alarm_webhook_secret", "")
    assert (await client.post("/api/alarms", json=PAYLOAD)).status_code == 403
    monkeypatch.setattr(settings, "alarm_webhook_secret", "s3cret")
    assert (await client.post("/api/alarms?secret=wrong", json=PAYLOAD)).status_code == 401


async def test_divera_webhook_gate_is_wired(client, monkeypatch):
    from tests.test_divera_webhook import PAYLOAD

    monkeypatch.setattr(settings, "divera_webhook_secret", "")
    assert (await client.post("/api/divera/webhook", json=PAYLOAD)).status_code == 403
    monkeypatch.setattr(settings, "divera_webhook_secret", "s3cret")
    assert (await client.post("/api/divera/webhook?secret=wrong", json=PAYLOAD)).status_code == 401


async def test_firehub_webhook_gate_is_wired(client, monkeypatch):
    from tests.test_firehub import firehub_payload

    monkeypatch.setattr(settings, "alarm_webhook_secret", "")
    assert (await client.post("/api/firehub/webhook", json=firehub_payload())).status_code == 403
    monkeypatch.setattr(settings, "alarm_webhook_secret", "s3cret")
    assert (await client.post("/api/firehub/webhook?secret=wrong", json=firehub_payload())).status_code == 401


async def test_traccar_fake_gate_is_wired(client, monkeypatch):
    """Double-gated (TRACCAR_FAKE flag, then the secret) — the flag stays on throughout, so
    only the secret half of the answer is under test here."""
    from tests.test_traccar_fake import PAYLOAD

    monkeypatch.setattr(settings, "traccar_fake", True)
    monkeypatch.setattr(settings, "alarm_webhook_secret", "")
    assert (await client.post("/api/traccar/fake", json=PAYLOAD)).status_code == 403
    monkeypatch.setattr(settings, "alarm_webhook_secret", "s3cret")
    assert (await client.post("/api/traccar/fake?secret=wrong", json=PAYLOAD)).status_code == 401


async def test_print_agent_gate_is_wired(client, monkeypatch):
    monkeypatch.setattr(settings, "print_agent_secret", "")
    assert (await client.post("/api/print-agent/claim")).status_code == 403
    monkeypatch.setattr(settings, "print_agent_secret", "s3cret")
    assert (await client.post("/api/print-agent/claim", headers={"X-Print-Agent-Secret": "wrong"})).status_code == 401


async def test_stats_export_gate_is_wired(client, db_session):
    assert (await client.get("/api/stats/incidents")).status_code == 403
    await _set_config_secret(db_session, "stats_secret", "s3cret")
    assert (await client.get("/api/stats/incidents?t=wrong")).status_code == 401


async def test_capture_poster_gate_is_wired(client, db_session):
    assert (await client.get("/api/capture/incidents")).status_code == 403
    await _set_config_secret(db_session, "capture_secret", "s3cret")
    assert (await client.get("/api/capture/incidents?t=wrong")).status_code == 401

"""FireHub (Tercero) webhook adapter — POST /api/firehub/webhook.

Covers:
- Shared-secret authentication (fail-closed), the same `alarm_webhook_secret` the generic
  `POST /api/alarms` path checks — 403 when unset, 401 on a wrong secret.
- Einsatzstart → an auto-opened incident with source="firehub" and the FireHub field mapping,
  the same auto-open flow every intake path uses.
- Idempotent deduplication by opsID (source, source_ref).
- Einsatzende → stamps the Einsatzende (`closed_at`) on the matching incident's Rapport,
  without closing/archiving the card; idempotent; a no-op for an operation we never opened.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.config import settings
from app.models import Incident, JournalEntry

SECRET = "alarm-secret-123"


@pytest.fixture
def alarm_secret(monkeypatch):
    monkeypatch.setattr(settings, "alarm_webhook_secret", SECRET)


@pytest.fixture(autouse=True)
def _no_network_geocode(monkeypatch):
    """Keep intake hermetic: a real geocoder would resolve the composed «street, city» address
    over the network. FireHub sends no coordinates, so these tests want the geocoder out of the
    loop entirely — the pin question is tested where the geocoder is, not here."""
    import app.alarms as alarms_mod

    async def _none(_addr):
        return None

    monkeypatch.setattr(alarms_mod, "geocode", _none)


def firehub_payload(action: str = "start", **op_overrides) -> dict:
    operation = {
        "opsID": 42,
        "opsNumber": 7,
        "category": "firealarm",
        "title": "Oberwil: Feueralarm",
        "street": "Teststrasse 112",
        "city": "Oberwil",
        "created": "2026-08-24T18:25:07.000Z",
    }
    operation.update(op_overrides)
    return {
        "operation": operation,
        "status": "OK",
        "trigger": {"type": "operation", "action": action, "techName": f"operation_{action}"},
    }


def _post(client, payload: dict, secret: str | None = SECRET):
    if secret is None:
        return client.post("/api/firehub/webhook", json=payload)
    return client.post(f"/api/firehub/webhook?secret={secret}", json=payload)


# Authentication ------------------------------------------------------------------------


async def test_firehub_fails_closed_without_configured_secret(client, monkeypatch):
    monkeypatch.setattr(settings, "alarm_webhook_secret", "")
    r = await _post(client, firehub_payload())
    assert r.status_code == 403


async def test_firehub_rejects_wrong_secret(client, alarm_secret):
    r = await _post(client, firehub_payload(), secret="wrong")
    assert r.status_code == 401


# Einsatzstart --------------------------------------------------------------------------


async def test_firehub_start_creates_auto_opened_incident_with_mapping(client, alarm_secret, db_session):
    r = await _post(client, firehub_payload())
    assert r.status_code == 200
    body = r.json()
    assert body["action"] == "start"
    assert body["created"] is True

    inc = (await db_session.execute(select(Incident).where(Incident.id == uuid.UUID(body["incident_id"])))).scalar_one()
    assert inc.source == "firehub"
    assert inc.source_ref == "42"  # opsID, stringified
    assert inc.divera_id is None
    assert inc.title == "Oberwil: Feueralarm"
    # address composed from street + city (the field Tercero is adding)
    assert inc.address == "Teststrasse 112, Oberwil"
    # auto-opened with no human, like every other intake path
    assert inc.auto_opened is True
    assert inc.created_by is None
    # FireHub sends no coordinates today; the pin is geocoded downstream (none configured here)
    assert inc.lat is None and inc.lng is None
    # `created` flows onto the incident as the Alarmierungszeit
    assert inc.started_at_source == "alarm"
    assert inc.started_at is not None
    # not ended yet
    assert inc.closed_at is None


async def test_firehub_start_address_falls_back_to_street_only_without_city(client, alarm_secret, db_session):
    """During the rollout window FireHub still omits `city` — the address stays street-only."""
    payload = firehub_payload()
    del payload["operation"]["city"]
    r = await _post(client, payload)
    assert r.status_code == 200

    inc = (await db_session.execute(select(Incident).where(Incident.source_ref == "42"))).scalar_one()
    assert inc.address == "Teststrasse 112"


async def test_firehub_start_redelivery_is_deduplicated(client, alarm_secret, db_session):
    first = await _post(client, firehub_payload())
    second = await _post(client, firehub_payload())

    assert first.json()["created"] is True
    assert second.json()["created"] is False
    assert second.json()["incident_id"] == first.json()["incident_id"]

    count = len((await db_session.execute(select(Incident))).scalars().all())
    assert count == 1


# Einsatzende ---------------------------------------------------------------------------


async def test_firehub_end_stamps_einsatzende_without_closing_the_card(client, alarm_secret, db_session):
    start = await _post(client, firehub_payload())
    incident_id = start.json()["incident_id"]

    end = await _post(client, firehub_payload(action="end"))
    assert end.status_code == 200
    assert end.json()["stamped"] is True
    assert end.json()["incident_id"] == incident_id
    assert end.json()["ended_at"] is not None

    db_session.expire_all()
    inc = (await db_session.execute(select(Incident).where(Incident.id == uuid.UUID(incident_id)))).scalar_one()
    # the Einsatzende landed on the Rapport (closed_at is the model's «first Einsatzende»)
    assert inc.closed_at is not None
    # …but the card is NOT closed: retiring the Einsatz stays the operator's decision
    assert inc.is_archived is False
    assert inc.is_open is True

    # and it self-documents in the Verlauf
    rows = (
        (await db_session.execute(select(JournalEntry).where(JournalEntry.incident_id == uuid.UUID(incident_id))))
        .scalars()
        .all()
    )
    texts = [r.row_json.get("text", "") for r in rows]
    assert any("Einsatzende von FireHub gemeldet" in t for t in texts)


async def test_firehub_end_is_idempotent(client, alarm_secret, db_session):
    start = await _post(client, firehub_payload())
    incident_id = start.json()["incident_id"]

    first_end = await _post(client, firehub_payload(action="end"))
    assert first_end.json()["stamped"] is True
    stamped_at = first_end.json()["ended_at"]

    second_end = await _post(client, firehub_payload(action="end"))
    assert second_end.status_code == 200
    # closed_at is write-once — a redelivered end does not move the Einsatzende
    assert second_end.json()["stamped"] is False
    assert second_end.json()["ended_at"] == stamped_at

    db_session.expire_all()
    inc = (await db_session.execute(select(Incident).where(Incident.id == uuid.UUID(incident_id)))).scalar_one()
    # tz-robust: SQLite hands datetimes back naive, Postgres tz-aware
    assert inc.closed_at.replace(tzinfo=None) == datetime.fromisoformat(stamped_at).replace(tzinfo=None)


async def test_firehub_end_preserves_an_operator_closed_at(client, alarm_secret, db_session):
    """An operator who already closed the Einsatz owns the Einsatzende — a late FireHub end
    must not overwrite it."""
    start = await _post(client, firehub_payload())
    incident_id = start.json()["incident_id"]

    earlier = datetime.now(UTC) - timedelta(hours=1)
    inc = (await db_session.execute(select(Incident).where(Incident.id == uuid.UUID(incident_id)))).scalar_one()
    inc.closed_at = earlier
    await db_session.commit()

    end = await _post(client, firehub_payload(action="end"))
    assert end.json()["stamped"] is False

    db_session.expire_all()
    inc = (await db_session.execute(select(Incident).where(Incident.id == uuid.UUID(incident_id)))).scalar_one()
    assert inc.closed_at.replace(tzinfo=None) == earlier.replace(tzinfo=None)


async def test_firehub_end_for_unknown_operation_is_noop(client, alarm_secret, db_session):
    end = await _post(client, firehub_payload(action="end", opsID=9999))
    assert end.status_code == 200
    assert end.json()["stamped"] is False
    assert end.json()["incident_id"] is None

    # nothing was created for an operation we never opened
    assert (await db_session.execute(select(Incident))).scalars().all() == []

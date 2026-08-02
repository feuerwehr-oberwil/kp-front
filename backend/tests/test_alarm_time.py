"""Alarmierungszeit — ``incidents.started_at`` and its provenance.

``started_at`` is published as the Alarmierungszeit (docs/STATS-EXPORT.md, the Rapport-PDF's
«Alarmierung» row, the Einsatzdaten panel). Measured against WinFAP on 2026-08-02 it was
none of those things: every Divera path let ``server_default=func.now()`` stand, so the
column held the moment somebody opened the record — off by +193 to −12827 minutes — and the
export published ``alarmiertAt: null`` on every single incident.

Contract pinned here, one case per way an incident is born:

- Divera webhook / poller auto-open → ``ts_create``, marked ``alarm``;
- Divera pool take → ``ts_create``, marked ``alarm`` (what the intake wizard already
  promises when it hides the time field on this path);
- generic ``POST /api/alarms`` → the payload's ``started_at``, marked ``alarm``;
- manual create and Einsatzdaten correction → what the human typed, marked ``manual``;
- a sender that supplies no alarm time → server default, provenance **NULL**, and the export
  answers ``alarmiertAt: null`` rather than passing off an insert time as an alarm time.
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.config import settings
from app.models import DeploymentConfig, DiveraEmergency, Incident

PIN = "135790"

# A fabricated alarm: 2026-03-01 14:00:00 UTC. No real address, name or Divera id anywhere in
# this file — these are product tests, not a replay of anyone's Einsätze.
ALARM_AT = datetime(2026, 3, 1, 14, 0, 0, tzinfo=UTC)
TS_CREATE = int(ALARM_AT.timestamp())

WEBHOOK_PAYLOAD = {
    "id": 990001,
    "title": "Zimmerbrand Musterweg",
    "text": "Rauch aus dem Dachstock",
    "address": "Musterweg 1, Musterdorf",
    "lat": 47.5,
    "lng": 7.5,
    "ts_create": TS_CREATE,
    "ts_update": TS_CREATE,
}


@pytest.fixture
def webhook_secret(monkeypatch):
    monkeypatch.setattr(settings, "divera_webhook_secret", "hook-secret-123")


@pytest.fixture
def alarm_secret(monkeypatch):
    monkeypatch.setattr(settings, "alarm_webhook_secret", "alarm-secret-123")


async def _login(client, editor) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": PIN})
    assert r.status_code == 200, r.text


async def _enable_auto_open(db) -> None:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    cfg = {"autoOpen": True}
    if row is None:
        db.add(DeploymentConfig(id=1, config_json={"alarms": cfg}))
    else:
        row.config_json = {**(row.config_json or {}), "alarms": cfg}
    await db.commit()


def _aware(dt: datetime) -> datetime:
    """SQLite hands datetimes back naive; the stored value is UTC either way."""
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


async def _one_incident(db) -> Incident:
    return (await db.execute(select(Incident))).scalars().one()


# --- the alarm time survives every intake path ----------------------------------------


async def test_auto_open_uses_the_alarm_time_not_the_delivery_time(client, db_session, webhook_secret):
    """The webhook is delivered now; the alarm went out in the past. The incident takes the
    alarm's own stamp, so the gap between the two stops being invisible."""
    await _enable_auto_open(db_session)
    r = await client.post("/api/divera/webhook?secret=hook-secret-123", json=WEBHOOK_PAYLOAD)
    assert r.status_code == 200
    assert r.json()["incident_id"] is not None

    inc = await _one_incident(db_session)
    assert _aware(inc.started_at) == ALARM_AT
    assert inc.started_at_source == "alarm"
    # ...and the record-open time stays available as its own, different, fact.
    assert _aware(inc.created_at) > ALARM_AT


async def test_pool_take_uses_the_alarm_time(client, db_session, editor, webhook_secret):
    """A take happens whenever somebody reaches the tablet — minutes or hours later. The
    intake wizard hides the Alarmierungszeit field on this path because it promises the
    alarm's own time is kept; this is that promise."""
    r = await client.post("/api/divera/webhook?secret=hook-secret-123", json=WEBHOOK_PAYLOAD)
    assert r.status_code == 200

    await _login(client, editor)
    r = await client.post(f"/api/divera/pool/{WEBHOOK_PAYLOAD['id']}/take", json={})
    assert r.status_code == 201, r.text
    assert r.json()["started_at"].startswith("2026-03-01T14:00:00")

    inc = await _one_incident(db_session)
    assert _aware(inc.started_at) == ALARM_AT
    assert inc.started_at_source == "alarm"


async def test_pool_row_keeps_the_alarm_stamp_and_an_update_never_moves_it(client, db_session, webhook_secret):
    r = await client.post("/api/divera/webhook?secret=hook-secret-123", json=WEBHOOK_PAYLOAD)
    assert r.status_code == 200
    # Same alarm, re-sent with a later edit stamp and (wrongly) a later creation stamp.
    later = {**WEBHOOK_PAYLOAD, "text": "Korrigiert", "ts_create": TS_CREATE + 9999, "ts_update": TS_CREATE + 9999}
    r = await client.post("/api/divera/webhook?secret=hook-secret-123", json=later)
    assert r.status_code == 200
    assert r.json()["new"] is False

    em = (await db_session.execute(select(DiveraEmergency))).scalars().one()
    assert em.ts_create == TS_CREATE, "an update refreshes the alarm's content, never its birth time"
    assert em.ts_update == TS_CREATE + 9999


async def test_generic_intake_records_the_senders_alarm_time_as_alarm_sourced(client, db_session, alarm_secret):
    r = await client.post(
        "/api/alarms?secret=alarm-secret-123",
        json={
            "source": "leitstelle",
            "source_id": "E-9001",
            "title": "BMA Musterstrasse",
            "started_at": ALARM_AT.isoformat(),
        },
    )
    assert r.status_code == 201, r.text
    inc = await _one_incident(db_session)
    assert _aware(inc.started_at) == ALARM_AT
    assert inc.started_at_source == "alarm"


async def test_manual_create_and_correction_are_marked_manual(client, db_session, editor):
    await _login(client, editor)
    r = await client.post(
        "/api/incidents",
        json={"title": "Nachgetragener Einsatz", "started_at": ALARM_AT.isoformat()},
    )
    assert r.status_code == 201, r.text
    incident_id = r.json()["id"]
    inc = await _one_incident(db_session)
    assert _aware(inc.started_at) == ALARM_AT
    assert inc.started_at_source == "manual"

    # The Einsatzdaten panel correcting an alarm time keeps it human-asserted.
    corrected = ALARM_AT - timedelta(minutes=7)
    r = await client.patch(f"/api/incidents/{incident_id}", json={"started_at": corrected.isoformat()})
    assert r.status_code == 200, r.text
    await db_session.refresh(inc)
    assert _aware(inc.started_at) == corrected
    assert inc.started_at_source == "manual"


async def test_a_correction_upgrades_an_unknown_alarm_time(client, db_session, editor, webhook_secret):
    """The repair path for every row that predates this: an alarm with no ``ts_create``
    leaves the insert time and NULL provenance, and a human typing the real time fixes both."""
    payload = {k: v for k, v in WEBHOOK_PAYLOAD.items() if k != "ts_create"}
    assert (await client.post("/api/divera/webhook?secret=hook-secret-123", json=payload)).status_code == 200
    await _login(client, editor)
    r = await client.post(f"/api/divera/pool/{payload['id']}/take", json={})
    assert r.status_code == 201, r.text
    incident_id = r.json()["id"]

    inc = await _one_incident(db_session)
    assert inc.started_at_source is None, "no alarm time supplied → the column is the insert time, and says so"

    r = await client.patch(f"/api/incidents/{incident_id}", json={"started_at": ALARM_AT.isoformat()})
    assert r.status_code == 200, r.text
    await db_session.refresh(inc)
    assert _aware(inc.started_at) == ALARM_AT
    assert inc.started_at_source == "manual"


# --- what the export publishes ---------------------------------------------------------

STATS_TOKEN = "stats-token-alarm-time"


@pytest.fixture
async def stats_secret(db_session):
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db_session.add(row)
    row.stats_secret = STATS_TOKEN
    await db_session.commit()
    return STATS_TOKEN


async def _export(client) -> list[dict]:
    r = await client.get("/api/stats/incidents", headers={"X-Stats-Token": STATS_TOKEN})
    assert r.status_code == 200, r.text
    return r.json()


async def test_export_publishes_a_known_alarm_time_as_alarmiert_at(client, db_session, stats_secret):
    """The defect the measurement found: ``alarmiertAt`` was null on 36 of 36 records because
    the export read only the hand-edit override, while every other surface in the product
    falls back to ``started_at``."""
    db_session.add(
        Incident(
            title="Zimmerbrand Musterweg",
            source="divera",
            status="offen",
            started_at=ALARM_AT,
            started_at_source="alarm",
        )
    )
    await db_session.commit()

    rec = (await _export(client))[0]
    assert rec["alarmiertAt"].startswith("2026-03-01T14:00:00")
    assert rec["started_at_source"] == "alarm"
    assert rec["created_at"] is not None


async def test_export_leaves_alarmiert_at_null_when_no_alarm_time_is_known(client, db_session, stats_secret):
    """An honest null beats a plausible guess. With NULL provenance ``started_at`` is the
    record-open time; publishing it as the alarm time is exactly what put street-matched
    pairs 12827 minutes apart against WinFAP."""
    db_session.add(Incident(title="Ohne Alarmzeit", source="manual", status="offen", started_at=ALARM_AT))
    await db_session.commit()

    rec = (await _export(client))[0]
    assert rec["alarmiertAt"] is None
    assert rec["started_at_source"] is None
    # The raw value is still there — nothing is hidden, it is only refused the alarm-time name.
    assert rec["started_at"].startswith("2026-03-01T14:00:00")


async def test_export_prefers_an_explicit_report_meta_override(client, db_session, stats_secret):
    """A human editing the Rapport's Alarmierung outranks the column, with or without
    provenance — that is the precedence the Rapport-PDF and the capture app already use."""
    db_session.add(
        Incident(
            title="Korrigierte Alarmzeit",
            source="manual",
            status="offen",
            started_at=ALARM_AT,
            map_workspace_json={"reportMeta": {"alarmiertAt": "2026-03-01T13:45:00+00:00"}},
        )
    )
    await db_session.commit()

    rec = (await _export(client))[0]
    assert rec["alarmiertAt"] == "2026-03-01T13:45:00+00:00"
    assert rec["started_at_source"] is None

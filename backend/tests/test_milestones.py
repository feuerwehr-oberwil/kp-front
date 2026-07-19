"""Milestone webhook (/api/alarms/milestones) — alarm/vehicle timeline enrichment.

Contract under test:
- fail-closed without ALARM_WEBHOOK_SECRET; wrong secret → 401;
- resolves by divera_id or (source, source_id); no match → 404 (sender retries);
- idempotent upsert into reportMeta.gruppen/fahrzeuge (replay → applied=0, rev unchanged);
- operator entries (manual: true) are never overwritten;
- unknown ids are stored verbatim (never dropped);
- one journal row per NEW value; workspace_rev bumps so clients poll the change.
"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app.models import Incident, JournalEntry

SECRET = "hook-secret-123"


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "alarm_webhook_secret", SECRET)


PAYLOAD = {
    "divera_id": 4711,
    "groups": [{"id": "g2", "alarmedAt": "2026-07-13T01:12:00Z"}],
    "vehicles": [{"id": "tlf", "ausgerueckt": "2026-07-13T01:16:40Z"}],
}


async def _incident(db_session, **kw) -> Incident:
    inc = Incident(title="Brand Dachstock", source="divera", status="offen", divera_id=4711,
                   started_at=datetime(2026, 7, 13, 1, 11, tzinfo=UTC), **kw)
    db_session.add(inc)
    await db_session.commit()
    return inc


async def test_fails_closed_and_bad_secret(client, monkeypatch):
    from app.config import settings

    r = await client.post("/api/alarms/milestones", json=PAYLOAD, headers={"X-Webhook-Secret": "nope"})
    assert r.status_code == 401
    monkeypatch.setattr(settings, "alarm_webhook_secret", None)
    r = await client.post("/api/alarms/milestones", json=PAYLOAD)
    assert r.status_code == 403


async def test_unknown_incident_is_404(client):
    r = await client.post("/api/alarms/milestones", json=PAYLOAD, headers={"X-Webhook-Secret": SECRET})
    assert r.status_code == 404
    r = await client.post("/api/alarms/milestones", json={"groups": []}, headers={"X-Webhook-Secret": SECRET})
    assert r.status_code == 422  # neither divera_id nor source pair


async def test_apply_replay_and_journal(client, db_session):
    inc = await _incident(db_session)
    r = await client.post("/api/alarms/milestones", json=PAYLOAD, headers={"X-Webhook-Secret": SECRET})
    assert r.status_code == 200
    assert r.json()["applied"] == 2

    await db_session.refresh(inc)
    rm = inc.map_workspace_json["reportMeta"]
    assert rm["gruppen"] == [{"id": "g2", "alarmedAt": "2026-07-13T01:12:00+00:00"}]
    assert rm["fahrzeuge"][0]["id"] == "tlf"
    assert rm["fahrzeuge"][0]["ausgerueckt"] == "2026-07-13T01:16:40+00:00"
    assert inc.workspace_rev == 1

    rows = (
        await db_session.execute(select(JournalEntry).where(JournalEntry.incident_id == inc.id))
    ).scalars().all()
    texts = [row.row_json["text"] for row in rows]
    # config lists are empty in tests → labels fall back to the id (vehicles uppercased)
    assert any("g2 alarmiert" in t for t in texts)
    assert any("TLF ausgerückt 03:16" in t for t in texts)  # Europe/Zurich local clock

    # exact replay: nothing applied, rev unchanged, no extra journal rows
    r = await client.post("/api/alarms/milestones", json=PAYLOAD, headers={"X-Webhook-Secret": SECRET})
    assert r.json()["applied"] == 0
    await db_session.refresh(inc)
    assert inc.workspace_rev == 1
    rows2 = (
        await db_session.execute(select(JournalEntry).where(JournalEntry.incident_id == inc.id))
    ).scalars().all()
    assert len(rows2) == len(rows)

    # later milestone on the same vehicle: vorOrt fills in, ausgerueckt untouched
    r = await client.post(
        "/api/alarms/milestones",
        json={"divera_id": 4711, "vehicles": [{"id": "tlf", "vorOrt": "2026-07-13T01:22:00Z"}]},
        headers={"X-Webhook-Secret": SECRET},
    )
    assert r.json()["applied"] == 1
    await db_session.refresh(inc)
    v = inc.map_workspace_json["reportMeta"]["fahrzeuge"][0]
    assert v["ausgerueckt"] == "2026-07-13T01:16:40+00:00" and v["vorOrt"] == "2026-07-13T01:22:00+00:00"


async def test_manual_entries_win(client, db_session):
    inc = await _incident(
        db_session,
        map_workspace_json={"reportMeta": {
            "gruppen": [{"id": "g2", "alarmedAt": "2026-07-13T01:00:00+00:00", "manual": True}],
            "fahrzeuge": [{"id": "tlf", "ausgerueckt": "2026-07-13T01:20:00+00:00", "manual": True}],
        }, "entities": [{"id": "e1"}]},
    )
    r = await client.post("/api/alarms/milestones", json=PAYLOAD, headers={"X-Webhook-Secret": SECRET})
    assert r.json()["applied"] == 0
    await db_session.refresh(inc)
    rm = inc.map_workspace_json["reportMeta"]
    assert rm["gruppen"][0]["alarmedAt"] == "2026-07-13T01:00:00+00:00"
    assert rm["fahrzeuge"][0]["ausgerueckt"] == "2026-07-13T01:20:00+00:00"
    assert inc.map_workspace_json["entities"] == [{"id": "e1"}]  # rest of the blob untouched
    assert inc.workspace_rev == 0  # nothing applied → no rev bump


async def test_unknown_ids_stored_verbatim(client, db_session):
    inc = await _incident(db_session)
    r = await client.post(
        "/api/alarms/milestones",
        json={"divera_id": 4711, "groups": [{"id": "geisterzug", "alarmedAt": "2026-07-13T01:12:00Z"}]},
        headers={"X-Webhook-Secret": SECRET},
    )
    assert r.json()["applied"] == 1
    await db_session.refresh(inc)
    assert inc.map_workspace_json["reportMeta"]["gruppen"][0]["id"] == "geisterzug"


async def test_resolve_by_source_ref(client, db_session):
    inc = Incident(title="Pager", source="pager", source_ref="p-9", status="offen",
                   started_at=datetime(2026, 7, 13, 2, 0, tzinfo=UTC))
    db_session.add(inc)
    await db_session.commit()
    r = await client.post(
        "/api/alarms/milestones",
        json={"source": "pager", "source_id": "p-9",
              "vehicles": [{"id": "pio", "ausgerueckt": "2026-07-13T02:05:00Z"}]},
        headers={"X-Webhook-Secret": SECRET},
    )
    assert r.status_code == 200 and r.json()["applied"] == 1

"""Attach a pool alarm to an existing incident (POST /api/divera/pool/…/attach/…).

The dispatch center can split one physical Einsatz into several Divera alarms
(re-worded group dispatches — real split dispatch, 2026-07-15); taking each one used to create
duplicate incidents with the GPS milestones scattered across them. Contract:
- attach marks the alarm taken against the EXISTING incident, creates no new one;
- the incident's title/address/coords are untouched; the alarm's Meldung lands as a
  Verlauf row (time, title, text, address);
- taken alarm → 409, unknown alarm/incident → 404, archived incident → 409;
- /api/alarms/milestones follows the attachment via taken_incident_id, so a split
  dispatch's vehicle/group times land where the crew actually works.
"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from app.models import DiveraEmergency, Incident, JournalEntry

PIN = "135790"


async def _login(client, editor) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": PIN})
    assert r.status_code == 200, r.text


async def _incident(db_session, **kw) -> Incident:
    inc = Incident(title="Verunreinigung Bachweg", source="divera", status="offen",
                   divera_id=36123165, address="Bachweg 1",
                   started_at=datetime(2026, 7, 15, 3, 54, tzinfo=UTC), **kw)
    db_session.add(inc)
    await db_session.commit()
    return inc


async def _pool_alarm(db_session, divera_id=36123120, **kw) -> DiveraEmergency:
    em = DiveraEmergency(
        divera_id=divera_id, title="Verunreinigung durch Diesel",
        text="Stellenweise, ab BLT Leitstelle", address="Bachweg 1, Musterdorf",
        received_at=datetime(2026, 7, 15, 3, 57, 52, tzinfo=UTC), **kw,
    )
    db_session.add(em)
    await db_session.commit()
    return em


async def test_attach_joins_existing_incident_without_creating_one(client, db_session, editor):
    inc = await _incident(db_session)
    em = await _pool_alarm(db_session)
    await _login(client, editor)

    r = await client.post(f"/api/divera/pool/{em.divera_id}/attach/{inc.id}")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "incident_id": str(inc.id)}

    count = (await db_session.execute(select(func.count()).select_from(Incident))).scalar_one()
    assert count == 1  # no duplicate incident

    await db_session.refresh(em)
    assert em.is_taken is True
    assert em.taken_incident_id == inc.id

    # incident identity untouched — the alarm only adds to the record
    await db_session.refresh(inc)
    assert inc.title == "Verunreinigung Bachweg"
    assert inc.address == "Bachweg 1"
    assert inc.divera_id == 36123165

    rows = (
        await db_session.execute(select(JournalEntry).where(JournalEntry.incident_id == inc.id))
    ).scalars().all()
    texts = [row.row_json["text"] for row in rows]
    assert texts, "no journal rows at all"
    # full Meldung in one Verlauf row: local time, title, text, address
    assert any(
        "Alarm hinzugefügt (05:57): Verunreinigung durch Diesel" in t
        and "Stellenweise, ab BLT Leitstelle" in t
        and "Bachweg 1, Musterdorf" in t
        for t in texts
    ), texts

    # attached alarm is out of the pool
    pool = await client.get("/api/divera/pool")
    assert all(a["divera_id"] != em.divera_id for a in pool.json())


@pytest.mark.parametrize("case", ["taken", "no_alarm", "no_incident", "archived"])
async def test_attach_rejects_invalid_targets(client, db_session, editor, case):
    inc = await _incident(db_session, is_archived=(case == "archived"))
    em = await _pool_alarm(db_session, is_taken=(case == "taken"))
    await _login(client, editor)

    divera_id = 99999 if case == "no_alarm" else em.divera_id
    incident_id = "00000000-0000-0000-0000-000000000000" if case == "no_incident" else inc.id
    r = await client.post(f"/api/divera/pool/{divera_id}/attach/{incident_id}")
    assert r.status_code == {"taken": 409, "no_alarm": 404, "no_incident": 404, "archived": 409}[case]

    if case not in ("taken",):
        await db_session.refresh(em)
        assert em.is_taken is (case == "taken")


async def test_milestones_follow_attached_alarm(client, db_session, editor, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "alarm_webhook_secret", "hook-secret-123")
    inc = await _incident(db_session)
    em = await _pool_alarm(db_session)
    await _login(client, editor)
    r = await client.post(f"/api/divera/pool/{em.divera_id}/attach/{inc.id}")
    assert r.status_code == 200

    # milestones addressed to the ATTACHED alarm's divera_id land on the incident
    r = await client.post(
        "/api/alarms/milestones",
        json={"divera_id": em.divera_id,
              "vehicles": [{"id": "pio", "ausgerueckt": "2026-07-15T04:07:46Z"}]},
        headers={"X-Webhook-Secret": "hook-secret-123"},
    )
    assert r.status_code == 200
    assert r.json() == {"incident_id": str(inc.id), "applied": 1}

    await db_session.refresh(inc)
    fz = inc.map_workspace_json["reportMeta"]["fahrzeuge"]
    assert fz[0]["id"] == "pio"

    # an untaken pool alarm's divera_id still 404s (sender keeps retrying)
    em2 = await _pool_alarm(db_session, divera_id=77777)
    r = await client.post(
        "/api/alarms/milestones",
        json={"divera_id": em2.divera_id, "groups": []},
        headers={"X-Webhook-Secret": "hook-secret-123"},
    )
    assert r.status_code == 404

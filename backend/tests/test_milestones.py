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
    inc = Incident(
        title="Brand Dachstock",
        source="divera",
        status="offen",
        divera_id=4711,
        started_at=datetime(2026, 7, 13, 1, 11, tzinfo=UTC),
        **kw,
    )
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


async def test_uses_database_stored_secret_on_a_cold_cache(client, db_session, monkeypatch):
    """The milestone endpoint must reload browser-set credentials like every other intake."""
    from app import credentials
    from app.config import settings

    monkeypatch.setattr(settings, "alarm_webhook_secret", "")
    await credentials.set_value(db_session, "alarm_webhook_secret", SECRET, actor_id=None)
    await db_session.commit()
    credentials.reset_cache()

    r = await client.post("/api/alarms/milestones", json=PAYLOAD, headers={"X-Webhook-Secret": SECRET})

    assert r.status_code == 404


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

    rows = (await db_session.execute(select(JournalEntry).where(JournalEntry.incident_id == inc.id))).scalars().all()
    texts = [row.row_json["text"] for row in rows]
    # config lists are empty in tests → labels fall back to the id (vehicles uppercased)
    assert any("g2 alarmiert" in t for t in texts)
    assert any("TLF ausgerückt 03:16" in t for t in texts)  # Europe/Zurich local clock

    # exact replay: nothing applied, rev unchanged, no extra journal rows
    r = await client.post("/api/alarms/milestones", json=PAYLOAD, headers={"X-Webhook-Secret": SECRET})
    assert r.json()["applied"] == 0
    await db_session.refresh(inc)
    assert inc.workspace_rev == 1
    rows2 = (await db_session.execute(select(JournalEntry).where(JournalEntry.incident_id == inc.id))).scalars().all()
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
        map_workspace_json={
            "reportMeta": {
                "gruppen": [{"id": "g2", "alarmedAt": "2026-07-13T01:00:00+00:00", "manual": True}],
                "fahrzeuge": [{"id": "tlf", "ausgerueckt": "2026-07-13T01:20:00+00:00", "manual": True}],
            },
            "entities": [{"id": "e1"}],
        },
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
    inc = Incident(
        title="Pager",
        source="pager",
        source_ref="p-9",
        status="offen",
        started_at=datetime(2026, 7, 13, 2, 0, tzinfo=UTC),
    )
    db_session.add(inc)
    await db_session.commit()
    r = await client.post(
        "/api/alarms/milestones",
        json={
            "source": "pager",
            "source_id": "p-9",
            "vehicles": [{"id": "pio", "ausgerueckt": "2026-07-13T02:05:00Z"}],
        },
        headers={"X-Webhook-Secret": SECRET},
    )
    assert r.status_code == 200 and r.json()["applied"] == 1


async def test_concurrent_milestone_is_not_lost(client, db_session, session_factory, monkeypatch):
    """A second milestone landing between our read and our write must not be clobbered.

    2026-07-31: PIO «ausgerückt» and «vor Ort» arrived 5 ms apart; the plain
    read-modify-write dropped one of them (the Verlauf row survived, the Ausrückzeit did
    not). The write is a compare-and-swap now — a lost race re-reads and re-applies.
    """
    from sqlalchemy import update as sa_update

    from app.api import alarms as alarms_api

    inc = await _incident(db_session)

    async def _competing_write() -> None:
        """Someone else's milestone lands (and bumps the rev) while we hold a stale read."""
        async with session_factory() as other:
            await other.execute(
                sa_update(Incident)
                .where(Incident.id == inc.id)
                .values(
                    map_workspace_json={
                        "reportMeta": {"fahrzeuge": [{"id": "pio", "vorOrt": "2026-07-13T01:18:00+00:00"}]}
                    },
                    workspace_rev=Incident.workspace_rev + 1,
                )
            )
            await other.commit()

    # Land the race in the instant between the read and the write: the first CAS attempt
    # goes out against a rev that no longer exists, misses, and the retry has to re-read and
    # merge onto the winner's value instead of overwriting it.
    orig_execute_dml = alarms_api.execute_dml
    attempts = {"n": 0}

    async def _dml(db, stmt):
        attempts["n"] += 1
        if attempts["n"] == 1:
            await _competing_write()
        return await orig_execute_dml(db, stmt)

    monkeypatch.setattr(alarms_api, "execute_dml", _dml)

    r = await client.post(
        "/api/alarms/milestones",
        json={"divera_id": 4711, "vehicles": [{"id": "pio", "ausgerueckt": "2026-07-13T01:16:00Z"}]},
        headers={"X-Webhook-Secret": SECRET},
    )
    assert r.status_code == 200 and r.json()["applied"] == 1
    assert attempts["n"] == 2, "the first CAS must miss and the handler must retry"

    async with session_factory() as check:
        fresh = (await check.execute(select(Incident).where(Incident.id == inc.id))).scalar_one()
    pio = next(v for v in fresh.map_workspace_json["reportMeta"]["fahrzeuge"] if v["id"] == "pio")
    # BOTH survive: the racer's «vor Ort» and our «ausgerückt».
    assert pio["vorOrt"] == "2026-07-13T01:18:00+00:00"
    assert pio["ausgerueckt"] == "2026-07-13T01:16:00+00:00"

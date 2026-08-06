"""`origin` on the milestone webhook — where an alarm came IN from.

Contract under test:
- recorded write-once on `Incident.alarm_origin`; the first milestone carrying it wins and
  no later one rewrites it (provenance is not an editable field);
- omitting it is normal and means *unknown*, never *no* — a sender that cannot know the
  origin, notably a fallback relay running while the main service is unreachable, simply
  leaves it out, and that must not clear a value already recorded;
- it does not count towards `applied` and appends no journal row: it is a property of the
  alarm, not something that happened during the Einsatz;
- it is a slug, never a phone number — the schema rejects anything else, because the whole
  point of a label is that the number never has to travel.
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


async def _incident(db_session, **kw) -> Incident:
    inc = Incident(
        title="BMA Grenzweg 1",
        source="divera",
        status="offen",
        divera_id=4711,
        started_at=datetime(2026, 7, 13, 1, 11, tzinfo=UTC),
        **kw,
    )
    db_session.add(inc)
    await db_session.commit()
    return inc


def _payload(**kw):
    return {"divera_id": 4711, "groups": [{"id": "g2", "alarmedAt": "2026-07-13T01:12:00Z"}], **kw}


async def _post(client, payload):
    return await client.post("/api/alarms/milestones", json=payload, headers={"X-Webhook-Secret": SECRET})


async def test_origin_is_recorded(client, db_session):
    inc = await _incident(db_session)
    r = await _post(client, _payload(origin="alarmzentrale"))
    assert r.status_code == 200

    await db_session.refresh(inc)
    assert inc.alarm_origin == "alarmzentrale"


async def test_origin_is_write_once(client, db_session):
    """A later milestone must not be able to rewrite where an alarm came from."""
    inc = await _incident(db_session)
    await _post(client, _payload(origin="alarmzentrale"))
    await _post(client, _payload(origin="handy"))

    await db_session.refresh(inc)
    assert inc.alarm_origin == "alarmzentrale", "the first origin wins, permanently"


async def test_a_later_milestone_without_origin_does_not_clear_it(client, db_session):
    """The pi-relay case: an outage-handled follow-up knows no origin and must not erase one."""
    inc = await _incident(db_session)
    await _post(client, _payload(origin="alarmzentrale"))
    r = await _post(client, _payload(vehicles=[{"id": "tlf", "zurueck": "2026-07-13T02:00:00Z"}]))
    assert r.status_code == 200

    await db_session.refresh(inc)
    assert inc.alarm_origin == "alarmzentrale"


async def test_absent_origin_stays_null(client, db_session):
    """Null is an ordinary answer: nobody said, so nothing is recorded."""
    inc = await _incident(db_session)
    r = await _post(client, _payload())
    assert r.status_code == 200

    await db_session.refresh(inc)
    assert inc.alarm_origin is None


async def test_origin_is_not_a_milestone(client, db_session):
    """It must not inflate `applied` nor write a Verlauf row."""
    inc = await _incident(db_session)
    await _post(client, _payload(origin="alarmzentrale"))  # group + origin
    before = (await db_session.execute(select(JournalEntry).where(JournalEntry.incident_id == inc.id))).scalars().all()

    # Replay the same group with a DIFFERENT origin: nothing new happened operationally.
    r = await _post(client, _payload(origin="handy"))
    assert r.json()["applied"] == 0, "origin is not a milestone and never counts as applied"

    after = (await db_session.execute(select(JournalEntry).where(JournalEntry.incident_id == inc.id))).scalars().all()
    assert len(after) == len(before), "origin must not appear in the Verlauf"


@pytest.mark.parametrize(
    "bad",
    [
        "+41791234567",  # a phone number — the exact thing a label exists to avoid
        "41791234567 ",
        "Alarmzentrale",  # uppercase
        "alarm zentrale",  # space
        "_leading",
        "",
        "x" * 33,
    ],
)
async def test_schema_rejects_anything_that_is_not_a_slug(client, db_session, bad):
    await _incident(db_session)
    r = await _post(client, _payload(origin=bad))
    assert r.status_code == 422, f"{bad!r} must not be accepted as an origin"


async def test_origin_reaches_the_stats_export(client, db_session):
    """The whole point: a downstream consumer can read it."""
    from sqlalchemy import select as sa_select

    from app.models import DeploymentConfig

    row = (await db_session.execute(sa_select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db_session.add(row)
    row.stats_secret = "stats-token"
    await db_session.commit()

    inc = await _incident(db_session, editor_opened_at=datetime(2026, 7, 13, 1, 20, tzinfo=UTC))
    await _post(client, _payload(origin="alarmzentrale"))

    r = await client.get("/api/stats/incidents", headers={"X-Stats-Token": "stats-token"})
    assert r.status_code == 200
    rows = [row for row in r.json() if row.get("id") == str(inc.id)]
    assert rows, "the incident should be in the export"
    assert rows[0]["alarm_origin"] == "alarmzentrale"

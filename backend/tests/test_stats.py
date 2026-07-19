"""Statistics export (/api/stats/*) — the read-only feed for fwo-stats.

Contract under test:
- fail-closed: no stats secret in the DB → 403 for the export; wrong token → 401;
- the record is FLAT and complete: incident metadata + reportMeta slices + derived
  attendance / current-Mittel / rapport state — never the raw workspace blob;
- `year` filters on the LOCAL (Europe/Zurich) calendar year of started_at;
- the admin endpoints (ADMIN_SECRET session) rotate/disable the token.
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.models import DeploymentConfig, Incident

TOKEN = "stats-token-123"


@pytest.fixture
async def stats_secret(db_session):
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db_session.add(row)
    row.stats_secret = TOKEN
    await db_session.commit()
    return TOKEN


WS = {
    "attendance": {
        "p1": {"status": "left", "checkedInAt": "2026-03-01T14:00:00Z", "leftAt": "2026-03-01T16:30:00Z",
               "displayNameSnapshot": "Meier Anna"},
        "p2": {"status": "present", "checkedInAt": "2026-03-01T14:05:00Z", "displayNameSnapshot": "Huber Beat"},
    },
    # append-only running totals: the LATER Ölbinder entry wins; the zeroed line drops out
    "mittel": [
        {"id": "m1", "label": "Ölbinder", "unit": "Sack", "menge": 2, "at": "2026-03-01T14:10:00Z"},
        {"id": "m2", "label": "Ölbinder", "unit": "Sack", "menge": 5, "at": "2026-03-01T15:00:00Z"},
        {"id": "m3", "label": "Handlöscher", "unit": "Stk", "menge": 1, "at": "2026-03-01T14:20:00Z"},
        {"id": "m4", "label": "Handlöscher", "unit": "Stk", "menge": 0, "at": "2026-03-01T15:30:00Z"},
    ],
    "reportMeta": {
        "endedAt": "2026-03-01T16:45:00Z", "ausgeruecktAt": "2026-03-01T14:03:00Z",
        "einsatzleiter": "Maj Muster", "kontaktperson": "Frau Beispiel", "summary": "Öl gebunden.",
        "partnerContacts": [{"org": "Polizei", "name": "Wm Graf"}],
    },
    "entities": [{"id": "e1"}],  # operational blob content must never leak into the export
}


def _incident(**kw) -> Incident:
    base = dict(title="Ölspur Hauptstrasse", source="manual", status="offen")
    return Incident(**{**base, **kw})


async def test_stats_fails_closed_without_secret(client):
    r = await client.get("/api/stats/incidents")
    assert r.status_code == 403


async def test_stats_rejects_wrong_token(client, stats_secret):
    r = await client.get("/api/stats/incidents?t=nope")
    assert r.status_code == 401
    r = await client.get("/api/stats/incidents", headers={"X-Stats-Token": "nope"})
    assert r.status_code == 401


async def test_stats_record_shape(client, stats_secret, db_session):
    inc = _incident(started_at=datetime(2026, 3, 1, 13, 55, tzinfo=UTC), map_workspace_json=WS,
                    address="Hauptstrasse 1", type="Elementarereignisse")
    db_session.add(inc)
    await db_session.commit()

    r = await client.get(f"/api/stats/incidents?t={TOKEN}")
    assert r.status_code == 200
    recs = r.json()
    assert len(recs) == 1
    rec = recs[0]
    assert rec["title"] == "Ölspur Hauptstrasse"
    assert rec["kategorie"] == "Elementarereignisse"
    assert rec["einsatzleiter"] == "Maj Muster"
    assert rec["endedAt"] == "2026-03-01T16:45:00Z"
    assert rec["rapport"] == "open"
    assert rec["partner"] == [{"org": "Polizei", "name": "Wm Graf"}]
    # derived attendance, alphabetical, von–bis carried through
    assert [a["name"] for a in rec["attendance"]] == ["Huber Beat", "Meier Anna"]
    assert rec["attendance"][1]["bis"] == "2026-03-01T16:30:00Z"
    # derived Mittel: latest-per-key, zeroed line gone
    assert rec["mittel"] == [{"label": "Ölbinder", "menge": 5, "unit": "Sack", "source": None}]
    # the operational blob must not leak
    assert "entities" not in rec and "map_workspace_json" not in rec


async def test_stats_rapport_state_done_vs_changed(client, stats_secret, db_session):
    now = datetime.now(UTC)
    done = _incident(title="Done", started_at=now, report_done_at=now)
    changed = _incident(title="Changed", started_at=now, report_done_at=now - timedelta(hours=2))
    db_session.add_all([done, changed])
    await db_session.commit()  # updated_at = now for both → 'changed' only for the older done-stamp

    r = await client.get(f"/api/stats/incidents?t={TOKEN}")
    by_title = {rec["title"]: rec["rapport"] for rec in r.json()}
    assert by_title["Done"] == "done"
    assert by_title["Changed"] == "changed"


async def test_stats_year_filter_uses_local_year(client, stats_secret, db_session):
    # 31.12.2025 23:30 UTC = 01.01.2026 00:30 local (Europe/Zurich, UTC+1) → belongs to 2026
    sylvester = _incident(title="Silvester", started_at=datetime(2025, 12, 31, 23, 30, tzinfo=UTC))
    summer = _incident(title="Sommer", started_at=datetime(2025, 7, 1, 12, 0, tzinfo=UTC))
    db_session.add_all([sylvester, summer])
    await db_session.commit()

    r = await client.get(f"/api/stats/incidents?t={TOKEN}&year=2026")
    assert [rec["title"] for rec in r.json()] == ["Silvester"]
    r = await client.get(f"/api/stats/incidents?t={TOKEN}&year=2025")
    assert [rec["title"] for rec in r.json()] == ["Sommer"]


async def test_admin_rotate_and_disable(client, admin_login, db_session):
    await admin_login(client)
    r = await client.post("/api/stats/secret/rotate")
    assert r.status_code == 200
    token = r.json()["token"]
    assert token and r.json()["configured"] is True

    lr = await client.get(f"/api/stats/incidents?t={token}")
    assert lr.status_code == 200

    r = await client.delete("/api/stats/secret")
    assert r.status_code == 200
    lr = await client.get(f"/api/stats/incidents?t={token}")
    assert lr.status_code == 403  # fail-closed again


async def test_admin_endpoints_require_admin(client, stats_secret):
    r = await client.get("/api/stats/secret")
    assert r.status_code in (401, 403)
    r = await client.post("/api/stats/secret/rotate")
    assert r.status_code in (401, 403)

"""Übungen (is_exercise) — separation from real Einsätze.

Contract under test:
- the flag round-trips through create / patch / the meta view (default False);
- hard DELETE is exercise-only: a real Einsatz answers 403 and stays, an Übung
  answers 204 and is gone (the append-only record model only bends for Übungen);
- viewers cannot delete at all (editor gate);
- the stats export excludes Übungen by default; ?include_exercises=1 exports them
  and every record carries the is_exercise marker.
"""

import pytest
from sqlalchemy import select

from app.models import DeploymentConfig

pytestmark = pytest.mark.asyncio

STATS_TOKEN = "stats-token-uebung"


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _create(client, title: str, *, exercise: bool = False) -> str:
    r = await client.post("/api/incidents", json={"title": title, "is_exercise": exercise})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["is_exercise"] is exercise
    return body["id"]


@pytest.fixture
async def stats_secret(db_session):
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db_session.add(row)
    row.stats_secret = STATS_TOKEN
    await db_session.commit()
    return STATS_TOKEN


async def test_flag_roundtrip_and_patch(client, editor):
    await _login(client, editor)
    inc_id = await _create(client, "Einsatz echt")  # default: not an exercise

    # retro-tag: patch flips the flag both ways
    r = await client.patch(f"/api/incidents/{inc_id}", json={"is_exercise": True})
    assert r.status_code == 200
    assert r.json()["is_exercise"] is True
    r = await client.patch(f"/api/incidents/{inc_id}", json={"is_exercise": False})
    assert r.json()["is_exercise"] is False

    # the list/meta view carries the flag
    r = await client.get("/api/incidents")
    metas = {m["id"]: m for m in r.json()}
    assert metas[inc_id]["is_exercise"] is False


async def test_delete_real_incident_forbidden(client, editor):
    await _login(client, editor)
    inc_id = await _create(client, "Echter Einsatz")

    r = await client.delete(f"/api/incidents/{inc_id}")
    assert r.status_code == 403

    # still there
    r = await client.get(f"/api/incidents/{inc_id}")
    assert r.status_code == 200


async def test_delete_exercise_removes_it(client, editor):
    await _login(client, editor)
    inc_id = await _create(client, "Übung Magazin", exercise=True)

    r = await client.delete(f"/api/incidents/{inc_id}")
    assert r.status_code == 204

    r = await client.get(f"/api/incidents/{inc_id}")
    assert r.status_code == 404


async def test_viewer_cannot_delete(client, editor, viewer):
    await _login(client, editor)
    inc_id = await _create(client, "Übung Hydrant", exercise=True)

    await _login(client, viewer)
    r = await client.delete(f"/api/incidents/{inc_id}")
    assert r.status_code == 403


async def test_stats_excludes_exercises_by_default(client, editor, stats_secret):
    await _login(client, editor)
    real_id = await _create(client, "Ölspur")
    ex_id = await _create(client, "Übung BMA", exercise=True)

    r = await client.get("/api/stats/incidents", headers={"X-Stats-Token": stats_secret})
    assert r.status_code == 200
    ids = [rec["id"] for rec in r.json()]
    assert real_id in ids
    assert ex_id not in ids

    r = await client.get(
        "/api/stats/incidents?include_exercises=1", headers={"X-Stats-Token": stats_secret}
    )
    recs = {rec["id"]: rec for rec in r.json()}
    assert recs[real_id]["is_exercise"] is False
    assert recs[ex_id]["is_exercise"] is True

"""Übungen (is_exercise) — separation from real Einsätze.

Contract under test:
- the flag round-trips through create / patch / the meta view (default False);
- hard DELETE is exercise-only: a real Einsatz answers 403 and stays, an Übung
  answers 204 and is gone (the append-only record model only bends for Übungen) — and
  «Übung» means created as one: a real Einsatz flipped later keeps the admin door;
- viewers cannot delete at all (editor gate);
- the stats export excludes Übungen by default; ?include_exercises=1 exports them
  and every record carries the is_exercise marker.
"""

import logging

import pytest
from sqlalchemy import select

from app.models import DeploymentConfig
from tests.conftest import _make_user

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
    # Opening the workspace is what the app does next, and it stamps editor_opened_at — the
    # stats export omits incidents no editor ever opened, so a bare POST would be invisible.
    assert (await client.get(f"/api/incidents/{body['id']}/workspace")).status_code == 200
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
    """An EDITOR still cannot delete a real Einsatz — that is an Einsatzakte, not a scratch pad."""
    await _login(client, editor)
    inc_id = await _create(client, "Echter Einsatz")

    r = await client.delete(f"/api/incidents/{inc_id}")
    assert r.status_code == 403

    # still there
    r = await client.get(f"/api/incidents/{inc_id}")
    assert r.status_code == 200


async def test_admin_can_delete_an_archived_real_incident(client, editor, admin_login):
    """The second door: a mistaken duplicate or a test alarm taken in earnest used to be
    undeletable by anybody. It takes the same key as the Verwaltung."""
    await _login(client, editor)
    inc_id = await _create(client, "Doppelt erfasst")
    assert (await client.patch(f"/api/incidents/{inc_id}", json={"is_archived": True})).status_code == 200

    await admin_login(client)
    r = await client.delete(f"/api/incidents/{inc_id}")
    assert r.status_code == 204, r.text
    assert (await client.get(f"/api/incidents/{inc_id}")).status_code == 404


async def test_admin_cannot_delete_a_running_real_incident(client, editor, admin_login):
    """⚠️ Archiving is the operator saying the Einsatz is over, and it is the only moment at which
    «löschen» is a decision rather than an accident."""
    await _login(client, editor)
    inc_id = await _create(client, "Läuft noch")

    await admin_login(client)
    r = await client.delete(f"/api/incidents/{inc_id}")
    assert r.status_code == 409, r.text
    assert (await client.get(f"/api/incidents/{inc_id}")).status_code == 200


async def test_delete_exercise_removes_it(client, editor):
    """An Übung is disposable by any editor, archived or not — no admin key for a scratch pad."""
    await _login(client, editor)
    inc_id = await _create(client, "Übung Magazin", exercise=True)

    r = await client.delete(f"/api/incidents/{inc_id}")
    assert r.status_code == 204

    r = await client.get(f"/api/incidents/{inc_id}")
    assert r.status_code == 404


async def test_create_stamps_exercise_since_creation(client, editor):
    await _login(client, editor)
    ex_id = await _create(client, "Übung Leiter", exercise=True)
    real_id = await _create(client, "Brand")
    metas = {m["id"]: m for m in (await client.get("/api/incidents")).json()}
    assert metas[ex_id]["exercise_since_creation"] is True
    assert metas[real_id]["exercise_since_creation"] is False


@pytest.mark.parametrize("role", ["editor", "el"])
async def test_a_real_einsatz_flipped_to_uebung_is_not_deletable(client, editor, db_session, role):
    """RBAC audit S1: «Übung» is an Einsatzdaten field (editor and el), so «flip, then DELETE»
    hard-deleted a real Einsatzakte without the Verwaltung. The flip stays allowed; the delete
    does not follow it."""
    writer = editor if role == "editor" else await _make_user(db_session, username="el", role="el")
    await _login(client, editor)
    inc_id = await _create(client, "Echter Brand")
    await _login(client, writer)
    assert (await client.patch(f"/api/incidents/{inc_id}", json={"is_exercise": True})).status_code == 200

    await _login(client, editor)
    assert (await client.delete(f"/api/incidents/{inc_id}")).status_code == 403
    r = await client.get(f"/api/incidents/{inc_id}")
    assert r.status_code == 200
    assert r.json()["is_exercise"] is True  # still stats-excluded, just not disposable


async def test_an_uebung_once_marked_real_stays_real_for_the_delete(client, editor):
    """Born an Übung, marked real, flipped back: it was a real Einsatz in between, and the
    cheap door would otherwise be a create-as-Übung loophole."""
    await _login(client, editor)
    inc_id = await _create(client, "Übung wird ernst", exercise=True)
    await client.patch(f"/api/incidents/{inc_id}", json={"is_exercise": False})
    await client.patch(f"/api/incidents/{inc_id}", json={"is_exercise": True})
    assert (await client.delete(f"/api/incidents/{inc_id}")).status_code == 403


async def test_admin_still_deletes_a_flipped_einsatz_and_logs_it(client, editor, admin_login, caplog):
    await _login(client, editor)
    inc_id = await _create(client, "Fehlalarm")
    await client.patch(f"/api/incidents/{inc_id}", json={"is_exercise": True, "is_archived": True})
    await admin_login(client)
    with caplog.at_level(logging.WARNING, logger="app.api.incidents"):
        assert (await client.delete(f"/api/incidents/{inc_id}")).status_code == 204
    assert any("ADMIN DELETE" in r.getMessage() for r in caplog.records)


async def test_viewer_cannot_delete(client, editor, viewer):
    """Disposable is not the same as unguarded: deletion is an EDITOR door, never a viewer's."""
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

    r = await client.get("/api/stats/incidents?include_exercises=1", headers={"X-Stats-Token": stats_secret})
    recs = {rec["id"]: rec for rec in r.json()}
    assert recs[real_id]["is_exercise"] is False
    assert recs[ex_id]["is_exercise"] is True

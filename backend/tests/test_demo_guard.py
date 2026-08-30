"""The public demo is a single living incident everyone edits — lifecycle changes stay blocked
even when a stale config publish clears the display flag."""

import pytest
from sqlalchemy import select

from app.config import settings
from app.models import DeploymentConfig


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200, r.text


async def _set_demo(db_session, on: bool) -> None:
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    identity = {"demoMode": on}
    if row is None:
        db_session.add(DeploymentConfig(id=1, config_json={"identity": identity}))
    else:
        row.config_json = {**(row.config_json or {}), "identity": identity}
    await db_session.commit()


@pytest.mark.asyncio
async def test_demo_blocks_creating_a_new_incident(client, editor, db_session):
    await _login(client, editor)
    await _set_demo(db_session, True)
    r = await client.post("/api/incidents", json={"title": "Neuer Einsatz"})
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_non_demo_allows_creating_a_new_incident(client, editor, db_session):
    await _login(client, editor)
    await _set_demo(db_session, False)
    r = await client.post("/api/incidents", json={"title": "Neuer Einsatz"})
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "patch",
    [
        {"report_done_at": "2026-08-30T18:00:00Z"},
        {"is_archived": True},
        {"status": "geschlossen"},
        {"is_exercise": True},
    ],
)
async def test_demo_blocks_closing_its_prepared_incident(client, editor, db_session, patch):
    await _login(client, editor)
    created = await client.post("/api/incidents", json={"title": "Zimmerbrand"})
    assert created.status_code == 201, created.text
    await _set_demo(db_session, True)

    r = await client.patch(f"/api/incidents/{created.json()['id']}", json=patch)

    assert r.status_code == 403, r.text
    current = await client.get(f"/api/incidents/{created.json()['id']}")
    assert current.json()["is_archived"] is False
    assert current.json()["report_done_at"] is None
    assert current.json()["status"] == "offen"
    assert current.json()["is_exercise"] is False


@pytest.mark.asyncio
async def test_demo_blocks_the_exercise_then_delete_bypass(client, editor, db_session):
    await _login(client, editor)
    created = await client.post("/api/incidents", json={"title": "Zimmerbrand"})
    assert created.status_code == 201, created.text
    incident_id = created.json()["id"]
    await _set_demo(db_session, True)

    marked = await client.patch(f"/api/incidents/{incident_id}", json={"is_exercise": True})
    assert marked.status_code == 403, marked.text
    deleted = await client.delete(f"/api/incidents/{incident_id}")
    assert deleted.status_code == 403, deleted.text
    assert (await client.get(f"/api/incidents/{incident_id}")).status_code == 200


@pytest.mark.asyncio
async def test_reset_schedule_keeps_demo_lifecycle_guard_when_config_flag_is_stale(
    client, editor, db_session, monkeypatch
):
    await _login(client, editor)
    created = await client.post("/api/incidents", json={"title": "Zimmerbrand"})
    assert created.status_code == 201, created.text
    await _set_demo(db_session, False)
    monkeypatch.setattr(settings, "demo_reset_seconds", 60)

    r = await client.patch(f"/api/incidents/{created.json()['id']}", json={"is_archived": True})

    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_reset_schedule_forces_demo_projection_and_rejects_a_station_config(
    client, admin_login, db_session, monkeypatch
):
    await _set_demo(db_session, False)
    monkeypatch.setattr(settings, "demo_reset_seconds", 60)
    await admin_login(client)

    projected = await client.get("/api/config")
    assert projected.status_code == 200, projected.text
    assert projected.json()["identity"]["demoMode"] is True
    assert projected.json()["doctrine"]["alarmBar"] == 0

    rejected = await client.put(
        "/api/config",
        json={"identity": {"demoMode": False}, "doctrine": {"alarmBar": 100}},
        headers={"If-Match": projected.json()["version"]},
    )
    assert rejected.status_code == 409, rejected.text

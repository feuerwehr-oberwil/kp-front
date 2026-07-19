"""Integration tests for business-critical incident paths through the DB.

Covers:
- workspace optimistic-lock concurrency (PUT /workspace stale base_rev → 409),
- permission enforcement (viewer cannot mutate; editor can),
- the audit capture → reconstruct cycle through the DB.

Runs against the test DB (SQLite locally, postgres in CI).
"""

import os
import uuid

import pytest

pytestmark = pytest.mark.asyncio

# Postgres-only: the hash chain re-serialises ``occurred_at``, which needs true
# ``timezone=True`` round-tripping. SQLite stores datetimes naive (harness artifact, not a
# code bug), so this runs in CI (DATABASE_URL set) and is skipped on the local SQLite run.
requires_pg_tz = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="needs timezone=True round-tripping (postgres); set DATABASE_URL to run (CI does)",
)


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _create_incident(client) -> str:
    r = await client.post("/api/incidents", json={"title": "Test Einsatz"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


# --- Workspace optimistic concurrency ----------------------------------------------


async def test_workspace_put_conflict_on_stale_base_rev(client, editor):
    await _login(client, editor)
    inc_id = await _create_incident(client)

    # First save off rev 0 succeeds and bumps to rev 1.
    r1 = await client.put(
        f"/api/incidents/{inc_id}/workspace", json={"base_rev": 0, "workspace": {"objects": [1]}}
    )
    assert r1.status_code == 200
    assert r1.json()["workspace_rev"] == 1

    # A second client still on rev 0 must lose with a 409 carrying the server rev.
    r2 = await client.put(
        f"/api/incidents/{inc_id}/workspace", json={"base_rev": 0, "workspace": {"objects": [2]}}
    )
    assert r2.status_code == 409
    detail = r2.json()["detail"]
    assert detail["server_rev"] == 1
    assert detail["your_base_rev"] == 0

    # Re-basing on the current rev succeeds.
    r3 = await client.put(
        f"/api/incidents/{inc_id}/workspace", json={"base_rev": 1, "workspace": {"objects": [3]}}
    )
    assert r3.status_code == 200
    assert r3.json()["workspace_rev"] == 2


# --- Permission enforcement ---------------------------------------------------------


async def test_viewer_cannot_create_incident(client, viewer):
    await _login(client, viewer)
    r = await client.post("/api/incidents", json={"title": "nope"})
    assert r.status_code == 403


async def test_viewer_cannot_save_workspace_but_can_read(client, editor, viewer):
    # Editor creates the incident.
    await _login(client, editor)
    inc_id = await _create_incident(client)
    await client.post("/api/auth/logout")

    # Viewer can read it but not mutate the workspace.
    await _login(client, viewer)
    assert (await client.get(f"/api/incidents/{inc_id}/workspace")).status_code == 200
    r = await client.put(
        f"/api/incidents/{inc_id}/workspace", json={"base_rev": 0, "workspace": {"x": 1}}
    )
    assert r.status_code == 403


async def test_unauthenticated_is_rejected(client):
    assert (await client.get("/api/incidents")).status_code == 401


# --- Divera take with EL overrides --------------------------------------------------


async def _seed_alarm(db_session, **kw) -> int:
    """Insert a pool alarm and return its divera_id."""
    from app.models import DiveraEmergency

    defaults = dict(divera_id=4711, title="FEUER mittel", text="Rauch aus Fenster", address="Alte Gasse 1")
    em = DiveraEmergency(**{**defaults, **kw})
    db_session.add(em)
    await db_session.commit()
    return em.divera_id


async def test_divera_take_applies_el_overrides(client, editor, db_session):
    """The wizard's reviewed fields win over the mirrored alarm; coords skip geocoding."""
    divera_id = await _seed_alarm(db_session, divera_id=5001, lat=None, lng=None)
    await _login(client, editor)

    r = await client.post(
        f"/api/divera/pool/{divera_id}/take",
        json={
            "title": "Wohnungsbrand Schulstrasse",
            "type": "Brandbekämpfung",
            "address": "Schulstrasse 5, 4104 Musterdorf",
            "lat": 47.51,
            "lng": 7.55,
        },
    )
    assert r.status_code == 201, r.text
    inc = r.json()
    assert inc["title"] == "Wohnungsbrand Schulstrasse"
    assert inc["type"] == "Brandbekämpfung"
    assert inc["address"] == "Schulstrasse 5, 4104 Musterdorf"
    assert inc["lat"] == 47.51 and inc["lng"] == 7.55
    assert inc["source"] == "divera"
    assert inc["divera_id"] == divera_id

    # Alarm is consumed → a second take is rejected.
    r2 = await client.post(f"/api/divera/pool/{divera_id}/take", json={})
    assert r2.status_code == 409


async def test_divera_take_verbatim_uses_alarm_fields(client, editor, db_session):
    """An empty body takes the alarm as-is; type is derived from the Stichwort."""
    divera_id = await _seed_alarm(db_session, divera_id=5002, title="VU mit Personen", lat=47.5, lng=7.5)
    await _login(client, editor)

    r = await client.post(f"/api/divera/pool/{divera_id}/take", json={})
    assert r.status_code == 201, r.text
    inc = r.json()
    assert inc["title"] == "VU mit Personen"
    assert inc["type"] == "Strassenrettung"  # detect_type("VU …")
    assert inc["lat"] == 47.5 and inc["lng"] == 7.5


# --- Audit capture → reconstruct through the DB -------------------------------------


@requires_pg_tz
async def test_audit_chain_capture_and_verify(client, editor, db_session):
    from app import audit

    await _login(client, editor)
    inc_id = await _create_incident(client)  # emits incident.create
    await client.put(
        f"/api/incidents/{inc_id}/workspace", json={"base_rev": 0, "workspace": {"a": 1}}
    )  # emits workspace.save

    incident_uuid = uuid.UUID(inc_id)
    result = await audit.verify_chain(db_session, incident_uuid)
    assert result["intact"] is True
    assert result["count"] >= 2  # incident.create + workspace.save


async def test_audit_reconstruct_returns_latest_workspace(client, editor, db_session):
    from datetime import UTC, datetime

    from app import audit

    await _login(client, editor)
    inc_id = await _create_incident(client)
    await client.put(
        f"/api/incidents/{inc_id}/workspace",
        json={"base_rev": 0, "workspace": {"objects": ["hydrant"]}},
    )

    state = await audit.reconstruct_state(db_session, uuid.UUID(inc_id), datetime.now(UTC))
    assert state["workspace"] == {"objects": ["hydrant"]}
    assert any(e["op_type"] == "workspace.save" for e in state["events"])

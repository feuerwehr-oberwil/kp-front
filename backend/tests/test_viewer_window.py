"""A `viewer` account reads the running Einsätze and the last `access.viewerHistoryDays` (auth/viewer_scope)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app import storage
from app.models import DeploymentConfig, Incident, Media
from tests.conftest import TEST_PIN

NOW = datetime.now(UTC)


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": TEST_PIN})
    assert r.status_code == 200, r.text


async def _incident(db, title: str, **kw) -> Incident:
    inc = Incident(title=title, source="manual", **{"status": "offen", **kw})
    db.add(inc)
    await db.commit()
    await db.refresh(inc)
    return inc


async def _history_days(db, days: int) -> None:
    db.add(DeploymentConfig(id=1, config_json={"access": {"viewerHistoryDays": days}}))
    await db.commit()


@pytest.fixture
async def einsaetze(db_session):
    old = NOW - timedelta(days=30)
    return {
        "running": await _incident(db_session, "läuft", started_at=old),
        # reopened after a close a month ago: running again, so readable
        "reopened": await _incident(db_session, "wieder offen", started_at=old, closed_at=old),
        "last_night": await _incident(
            db_session,
            "gestern",
            status="abgeschlossen",
            started_at=NOW - timedelta(days=1),
            last_closed_at=NOW - timedelta(hours=20),
        ),
        "old": await _incident(db_session, "alt", status="abgeschlossen", started_at=old, last_closed_at=old),
        # closed before `last_closed_at` existed: `closed_at` is the end
        "old_legacy": await _incident(
            db_session, "alt, ohne last_closed_at", status="abgeschlossen", started_at=old, closed_at=old
        ),
        "old_archived": await _incident(
            db_session, "archiviert", status="abgeschlossen", started_at=old, is_archived=True
        ),
    }


async def test_the_viewer_list_holds_the_running_and_the_last_week(client, viewer, einsaetze):
    await _login(client, viewer)
    r = await client.get("/api/incidents")
    assert r.status_code == 200, r.text
    assert {i["title"] for i in r.json()} == {"läuft", "wieder offen", "gestern"}


async def test_an_editor_still_lists_the_whole_archive(client, editor, einsaetze):
    await _login(client, editor)
    r = await client.get("/api/incidents")
    assert len(r.json()) == len(einsaetze)


@pytest.mark.parametrize("which", ["old", "old_legacy", "old_archived"])
@pytest.mark.parametrize("route", ["", "/workspace", "/journal", "/events"])
async def test_an_old_einsatz_does_not_exist_for_a_viewer(client, viewer, einsaetze, which, route):
    await _login(client, viewer)
    r = await client.get(f"/api/incidents/{einsaetze[which].id}{route}")
    assert r.status_code == 404, r.text


@pytest.mark.parametrize("which", ["running", "reopened", "last_night"])
async def test_a_viewer_reads_an_einsatz_inside_the_window(client, viewer, einsaetze, which):
    await _login(client, viewer)
    r = await client.get(f"/api/incidents/{einsaetze[which].id}")
    assert r.status_code == 200, r.text


async def test_an_old_einsatz_media_does_not_exist_for_a_viewer(client, viewer, editor, einsaetze, db_session):
    key = storage.new_key("media", ".bin")
    storage.put_bytes(key, b"not-a-real-photo")
    m = Media(incident_id=einsaetze["old"].id, kind="photo", storage_key=key, content_type="image/jpeg")
    db_session.add(m)
    await db_session.commit()

    await _login(client, viewer)
    assert (await client.get(f"/api/media/{m.id}")).status_code == 404
    await _login(client, editor)
    assert (await client.get(f"/api/media/{m.id}")).status_code == 200


async def test_zero_days_leaves_a_viewer_only_the_running_ones(client, db_session, viewer, einsaetze):
    await _history_days(db_session, 0)
    await _login(client, viewer)
    assert {i["title"] for i in (await client.get("/api/incidents")).json()} == {"läuft", "wieder offen"}
    assert (await client.get(f"/api/incidents/{einsaetze['last_night'].id}")).status_code == 404


async def test_a_longer_window_reaches_further_back(client, db_session, viewer, einsaetze):
    await _history_days(db_session, 60)
    await _login(client, viewer)
    assert len((await client.get("/api/incidents")).json()) == len(einsaetze)
    assert (await client.get(f"/api/incidents/{einsaetze['old'].id}")).status_code == 200

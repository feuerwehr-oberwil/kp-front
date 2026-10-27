"""Full workspace saves preserve legacy records while refusing new malformed alarm data."""

from copy import deepcopy

import pytest

from app.models import Incident


@pytest.mark.parametrize(
    "legacy",
    [
        {"timeline": [{"id": "old", "reminder": "broken"}]},
        {"timeline": [None, {"id": "old", "reminder": {"id": "r", "op": "created", "dueAt": 42}}]},
        {"trupps": [{"id": "old", "entryTime": 123, "color": 'red" onload="bad()'}]},
        {"trupps": {"old": "broken"}},
        {"settings": {"contactIntervalMin": "five", "contactGraceSec": "sixty"}},
        {"settings": "broken"},
    ],
)
async def test_unrelated_full_workspace_edit_preserves_malformed_legacy_alarm_data(client, editor, db_session, legacy):
    incident = Incident(title="Synthetic legacy incident", source="manual", map_workspace_json=deepcopy(legacy))
    db_session.add(incident)
    await db_session.commit()
    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    workspace = {**deepcopy(legacy), "entities": [{"id": "new-map-note", "name": "New note"}]}
    if isinstance(workspace.get("settings"), dict):
        workspace["settings"]["radioChannel"] = "new channel"
    response = await client.put(f"/api/incidents/{incident.id}/workspace", json={"base_rev": 0, "workspace": workspace})
    assert response.status_code == 200, response.text
    saved = (await client.get(f"/api/incidents/{incident.id}/workspace")).json()["workspace"]
    if isinstance(workspace.get("trupps"), list):
        del workspace["trupps"][0]["color"]  # The independent drawing sanitizer still applies.
    assert saved == workspace


@pytest.mark.parametrize("change", ["new", "edited", "duplicate"])
async def test_full_workspace_cannot_introduce_or_multiply_malformed_rows(client, editor, db_session, change):
    old = {"id": "old", "reminder": "broken"}
    incident = Incident(title="Synthetic legacy incident", source="manual", map_workspace_json={"timeline": [old]})
    db_session.add(incident)
    await db_session.commit()
    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    rows = {
        "new": [old, {"id": "new", "reminder": "broken"}],
        "edited": [{"id": "old", "reminder": "different broken value"}],
        "duplicate": [old, old],
    }[change]
    response = await client.put(
        f"/api/incidents/{incident.id}/workspace", json={"base_rev": 0, "workspace": {"timeline": rows}}
    )
    assert response.status_code == 422, response.text
    saved = (await client.get(f"/api/incidents/{incident.id}/workspace")).json()
    assert saved == {"workspace": {"timeline": [old]}, "workspace_rev": 0}


async def test_valid_rows_can_be_added_beside_legacy_rows_and_legacy_rows_can_be_corrected(client, editor, db_session):
    old = {"id": "old", "reminder": "broken"}
    good = {"id": "new", "text": "New note"}
    incident = Incident(title="Synthetic legacy incident", source="manual", map_workspace_json={"timeline": [old]})
    db_session.add(incident)
    await db_session.commit()
    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    response = await client.put(
        f"/api/incidents/{incident.id}/workspace", json={"base_rev": 0, "workspace": {"timeline": [good, old]}}
    )
    assert response.status_code == 200, response.text
    corrected = {"id": "old", "reminder": {"id": "r", "op": "created", "dueAt": "2026-09-06T10:00:00Z"}}
    response = await client.put(
        f"/api/incidents/{incident.id}/workspace", json={"base_rev": 1, "workspace": {"timeline": [good, corrected]}}
    )
    assert response.status_code == 200, response.text
    assert response.json()["workspace"]["timeline"] == [good, corrected]
    stale = await client.put(
        f"/api/incidents/{incident.id}/workspace", json={"base_rev": 1, "workspace": {"timeline": [good, old]}}
    )
    assert stale.status_code == 409, stale.text
    reintroduced = await client.put(
        f"/api/incidents/{incident.id}/workspace", json={"base_rev": 2, "workspace": {"timeline": [good, old]}}
    )
    assert reintroduced.status_code == 422, reintroduced.text


def test_legacy_reminder_warning_identifies_the_row_and_reason_without_logging_contents(caplog):
    from app.push import due_reminders

    row = {"id": "old\nrow", "text": "private operational note", "reminder": "broken"}
    assert due_reminders([row], now_ms=0, closed_at=None) == []
    assert "old\\nrow" in caplog.text
    assert "Wiedervorlage muss ein Objekt sein" in caplog.text
    assert "private operational note" not in caplog.text


async def test_observed_revision_mismatch_cannot_skip_validation_when_database_matches_client(
    client, editor, db_session, monkeypatch
):
    from types import SimpleNamespace

    from app import incident_service

    incident = Incident(title="Synthetic concurrent incident", source="manual", workspace_rev=1, map_workspace_json={})
    db_session.add(incident)
    await db_session.commit()
    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})

    async def stale_incident(*args, **kwargs):
        # Another transaction already advanced PostgreSQL beyond the identity-map copy.
        return SimpleNamespace(workspace_rev=0, map_workspace_json={})

    monkeypatch.setattr(incident_service, "get_incident_or_404", stale_incident)
    response = await client.put(
        f"/api/incidents/{incident.id}/workspace",
        json={"base_rev": 1, "workspace": {"timeline": [{"id": "new", "reminder": "broken"}]}},
    )
    assert response.status_code == 409, response.text


async def test_the_trupps_slice_keeps_a_legacy_row_but_refuses_a_new_unknown_word(client, editor, db_session):
    """The slice route validates against the stored list like the full PUT: an old row with a word
    the server now refuses must not lock a tablet out of its saves, a new one is refused (F01)."""
    legacy = {"id": "old", "kind": "atemschut", "status": "aktiv"}
    incident = Incident(title="Synthetic legacy incident", source="manual", map_workspace_json={"trupps": [legacy]})
    db_session.add(incident)
    await db_session.commit()
    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    url = f"/api/incidents/{incident.id}/workspace/trupps"
    ok = await client.put(url, json={"base_rev": 0, "trupps": [legacy, {"id": "new", "kind": "einfach"}]})
    assert ok.status_code == 200, ok.text
    bad = await client.put(url, json={"base_rev": 1, "trupps": [legacy, {"id": "new", "kind": "atemschut"}]})
    assert bad.status_code == 422, bad.text
    dup = await client.put(url, json={"base_rev": 1, "trupps": [legacy, {"id": "old"}]})
    assert dup.status_code == 422, dup.text

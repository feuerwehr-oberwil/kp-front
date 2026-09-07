"""The ``el`` role (Einsatzleiter function, 07.09.2026): may write the RECORD domains through
the scoped ``workspace/record`` slice — Anwesenheit (+ Zeitplan), Mittel, Checklisten,
Rapport (+ Beilagen) — and append journal rows / record-vocabulary events. The tactical
picture stays editor-only: the full workspace PUT, the trupps slice and the tactical event
vocabulary all refuse an ``el`` session, and a plain viewer stays read-only everywhere."""

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from tests.conftest import _make_user

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def el(db_session: AsyncSession):
    return await _make_user(db_session, username="el", role="el")


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _create_incident(client) -> str:
    r = await client.post("/api/incidents", json={"title": "Test Einsatz"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _as_el_on_editor_incident(client, editor, el) -> str:
    await _login(client, editor)
    inc_id = await _create_incident(client)
    r = await client.put(
        f"/api/incidents/{inc_id}/workspace",
        json={"base_rev": 0, "workspace": {"entities": [{"id": "e1"}], "attendance": {"p1": {"status": "present"}}}},
    )
    assert r.status_code == 200
    await client.post("/api/auth/logout")
    await _login(client, el)
    return inc_id


async def test_el_record_slice_applies_only_the_record_keys(client, editor, el):
    inc_id = await _as_el_on_editor_incident(client, editor, el)
    r = await client.put(
        f"/api/incidents/{inc_id}/workspace/record",
        json={
            "base_rev": 1,
            "workspace": {
                "attendance": {"p2": {"status": "present"}},
                "mittel": [{"id": "m1", "kind": "use"}],
                "checklists": {"t1": {"ticked": {"i1": True}}},
                "reportMeta": {"einsatzort": "Dorfplatz 1"},
                # tactical keys ride along in the payload and MUST be dropped by the server
                "entities": [],
                "drawings": [{"id": "d1"}],
                "trupps": [{"name": "X"}],
            },
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["workspace_rev"] == 2
    assert r.json()["workspace"] is None  # slice callers read nothing but the rev

    ws = (await client.get(f"/api/incidents/{inc_id}/workspace")).json()["workspace"]
    assert ws["attendance"] == {"p2": {"status": "present"}}
    assert ws["mittel"] == [{"id": "m1", "kind": "use"}]
    assert ws["checklists"] == {"t1": {"ticked": {"i1": True}}}
    assert ws["reportMeta"] == {"einsatzort": "Dorfplatz 1"}
    # the tactical picture is the server's own, untouched by the el payload
    assert ws["entities"] == [{"id": "e1"}]
    assert "drawings" not in ws or ws["drawings"] == []
    assert "trupps" not in ws


async def test_el_cannot_write_the_tactical_picture(client, editor, el):
    inc_id = await _as_el_on_editor_incident(client, editor, el)
    full = await client.put(f"/api/incidents/{inc_id}/workspace", json={"base_rev": 1, "workspace": {"x": 1}})
    assert full.status_code == 403
    trupps = await client.put(f"/api/incidents/{inc_id}/workspace/trupps", json={"base_rev": 1, "trupps": []})
    assert trupps.status_code == 403


async def test_viewer_is_still_read_only_on_the_record_slice(client, editor, viewer):
    await _login(client, editor)
    inc_id = await _create_incident(client)
    await client.post("/api/auth/logout")
    await _login(client, viewer)
    r = await client.put(
        f"/api/incidents/{inc_id}/workspace/record",
        json={"base_rev": 0, "workspace": {"attendance": {}}},
    )
    assert r.status_code == 403


async def test_el_record_slice_shares_the_optimistic_409(client, editor, el):
    inc_id = await _as_el_on_editor_incident(client, editor, el)
    r = await client.put(
        f"/api/incidents/{inc_id}/workspace/record",
        json={"base_rev": 0, "workspace": {"attendance": {}}},  # stale base_rev
    )
    assert r.status_code == 409


async def test_el_appends_journal_rows_and_record_events_but_no_tactical_ops(client, editor, el):
    inc_id = await _as_el_on_editor_incident(client, editor, el)
    j = await client.post(
        f"/api/incidents/{inc_id}/journal",
        json={"entries": [{"id": "r1", "t": "22:10", "kind": "note", "text": "EL: Material nachgeführt"}]},
    )
    assert j.status_code == 201, j.text

    ok = await client.post(
        f"/api/incidents/{inc_id}/events",
        json={
            "events": [{"op_type": "checklist.tick", "payload": {"item": "i1"}, "occurred_at": "2026-09-07T22:10:00Z"}]
        },
    )
    assert ok.status_code == 201, ok.text

    denied = await client.post(
        f"/api/incidents/{inc_id}/events",
        json={"events": [{"op_type": "entity.edit", "payload": {}, "occurred_at": "2026-09-07T22:10:00Z"}]},
    )
    assert denied.status_code == 403

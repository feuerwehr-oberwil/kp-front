"""A closed Einsatz keeps its RECORD, not its operation (api/incidents · `incident_closed`).

Staging walk-through 25.09.2026 (N3): after «Einsatz abschliessen» on one phone, the other phone
and the tablet ran the Einsatz live for minutes, and a «Kontakt» tap and two «Atemschutz-Alarm …
Überfällig» rows were written INTO the closed record. Contract under test:

- once closed, the live writes are refused with 409 `{code: "incident_closed"}` — Atemschutz
  events and rows, the trupps slice, a full save that changes the Tafel/Karte/Pläne;
- the record stays writable exactly as before: record-vocabulary events, Meldungen and patch
  rows (they print as Nachträge), the record slice, a full save that only touches record keys,
  the Einsatzdaten PATCH, and «Wieder öffnen», after which everything is writable again;
- an OPEN Einsatz is untouched by any of it;
- every workspace read says whether the Einsatz is open (`X-Incident-Open`), the 304 included,
  and a close wakes the followers parked on the workspace so they hear it at once.
"""

import asyncio
import time

import pytest

from app import live_wait
from tests.conftest import _make_user

pytestmark = pytest.mark.asyncio


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _incident(client) -> str:
    r = await client.post("/api/incidents", json={"title": "Abschluss Test"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _close(client, inc: str) -> None:
    """The Abschluss exactly as the app runs it (App · completeRapport)."""
    assert (
        await client.patch(f"/api/incidents/{inc}", json={"report_done_at": "2026-09-25T12:45:00Z"})
    ).status_code == 200
    assert (await client.patch(f"/api/incidents/{inc}", json={"is_archived": True})).status_code == 200


def _assert_closed_refusal(r) -> None:
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "incident_closed"
    assert detail["message"]
    assert detail["closed_at"]  # the device that learns of the close from this answer says when


TRUPP = {"id": "tr1", "name": "Trupp 1", "status": "drin", "entryTime": "2026-09-25T12:00:00Z"}
KONTAKT_ROW = {"id": "r-kontakt", "t": "14:46", "icon": "radio", "text": "Trupp 2 – Kontakt bestätigt", "kind": "team"}
ALARM_ROW = {
    "id": "azal-tr1-3",
    "t": "14:46",
    "icon": "warn",
    "text": "Atemschutz-Alarm: Trupp 1 – Überfällig",
    "kind": "team",
}


async def _seeded(client) -> tuple[str, int]:
    """An Einsatz with a Trupp inside and a Rapport — then closed."""
    inc = await _incident(client)
    ws = {"trupps": [TRUPP], "reportMeta": {"kurzbericht": "Brand gelöscht"}, "entities": []}
    r = await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": ws, "base_rev": 0})
    assert r.status_code == 200, r.text
    await _close(client, inc)
    return inc, r.json()["workspace_rev"]


# --- refused once closed ----------------------------------------------------------------------


async def test_atemschutz_events_are_refused_after_the_close(client, editor):
    await _login(client, editor)
    inc, _ = await _seeded(client)
    for op in ("atemschutz.contact", "atemschutz.alarm", "atemschutz.alarm.cleared", "entity.add"):
        r = await client.post(
            f"/api/incidents/{inc}/events", json={"events": [{"op_type": op, "payload": {"id": "tr1"}}]}
        )
        _assert_closed_refusal(r)
    # a mixed batch is refused whole — the client isolates the record events one by one
    r = await client.post(
        f"/api/incidents/{inc}/events",
        json={"events": [{"op_type": "report.edit", "payload": {}}, {"op_type": "atemschutz.contact", "payload": {}}]},
    )
    _assert_closed_refusal(r)


async def test_live_journal_rows_are_refused_after_the_close(client, editor):
    await _login(client, editor)
    inc, _ = await _seeded(client)
    before = (await client.get(f"/api/incidents/{inc}/journal")).json()["latest_seq"]
    for row in (
        KONTAKT_ROW,
        ALARM_ROW,
        {"id": "r-sym", "t": "14:47", "icon": "pin", "text": "TLF gesetzt", "kind": "symbol"},
    ):
        _assert_closed_refusal(await client.post(f"/api/incidents/{inc}/journal", json={"entries": [row]}))
    page = (await client.get(f"/api/incidents/{inc}/journal")).json()
    assert page["latest_seq"] == before, "a refused row reached the record"
    assert not [e for e in page["entries"] if e["row"]["id"] in {"r-kontakt", "azal-tr1-3"}]


async def test_the_trupps_slice_is_refused_after_the_close(client, editor):
    await _login(client, editor)
    inc, rev = await _seeded(client)
    kontakt = {**TRUPP, "lastContactTime": "2026-09-25T12:46:00Z"}
    r = await client.put(f"/api/incidents/{inc}/workspace/trupps", json={"trupps": [kontakt], "base_rev": rev})
    _assert_closed_refusal(r)
    ws = (await client.get(f"/api/incidents/{inc}/workspace")).json()
    assert ws["workspace_rev"] == rev and ws["workspace"]["trupps"] == [TRUPP]


async def test_a_full_save_that_changes_the_tafel_or_the_karte_is_refused(client, editor):
    await _login(client, editor)
    inc, rev = await _seeded(client)
    stored = (await client.get(f"/api/incidents/{inc}/workspace")).json()["workspace"]
    kontakt = {**stored, "trupps": [{**TRUPP, "lastContactTime": "2026-09-25T12:46:00Z"}]}
    _assert_closed_refusal(
        await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": kontakt, "base_rev": rev})
    )
    moved = {**stored, "entities": [{"id": "e1", "kind": "symbol", "coord": [7.6, 47.5]}]}
    _assert_closed_refusal(
        await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": moved, "base_rev": rev})
    )
    # …and a save a revision behind is still the ordinary conflict FIRST, so the client merges
    r = await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": kontakt, "base_rev": rev - 1})
    assert r.status_code == 409 and r.json()["detail"].get("code") is None


# --- the record stays writable ----------------------------------------------------------------


async def test_record_writes_still_land_after_the_close(client, editor):
    await _login(client, editor)
    inc, rev = await _seeded(client)
    # the record vocabulary
    r = await client.post(
        f"/api/incidents/{inc}/events",
        json={
            "events": [
                {"op_type": op, "payload": {}} for op in ("report.edit", "attendance.set", "journal.add", "mittel.add")
            ]
        },
    )
    assert r.status_code == 201, r.text
    # a Meldung, and a patch row (an upload finishing, a transcript) — both Nachträge on paper
    rows = [
        {"id": "r-note", "t": "15:10", "icon": "type", "text": "Nachtrag: Hauswart informiert", "kind": "journal"},
        {"id": "tp1-r-note", "t": "", "icon": "", "text": "", "patchOf": "r-note", "transcript": "…"},
    ]
    r = await client.post(f"/api/incidents/{inc}/journal", json={"entries": rows})
    assert r.status_code == 201 and len(r.json()["entries"]) == 2
    # a full save that only corrects the Rapport
    stored = (await client.get(f"/api/incidents/{inc}/workspace")).json()["workspace"]
    fixed = {**stored, "reportMeta": {"kurzbericht": "Brand gelöscht, Nachkontrolle 16:00"}}
    r = await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": fixed, "base_rev": rev})
    assert r.status_code == 200, r.text
    rev = r.json()["workspace_rev"]
    # the record slice
    r = await client.put(
        f"/api/incidents/{inc}/workspace/record",
        json={"workspace": {"mittel": [{"id": "m1", "name": "Schaummittel"}]}, "base_rev": rev},
    )
    assert r.status_code == 200, r.text
    # the Einsatzdaten
    assert (
        await client.patch(f"/api/incidents/{inc}", json={"title": "Abschluss Test (korrigiert)"})
    ).status_code == 200


async def test_the_el_role_keeps_its_record_slice_after_the_close(client, editor, db_session):
    el = await _make_user(db_session, username="el-closed", role="el")
    await _login(client, editor)
    inc, rev = await _seeded(client)
    await _login(client, el)
    r = await client.put(
        f"/api/incidents/{inc}/workspace/record",
        json={"workspace": {"reportMeta": {"kurzbericht": "vom EL ergänzt"}}, "base_rev": rev},
    )
    assert r.status_code == 200, r.text


async def test_reopening_makes_the_live_writes_land_again(client, editor):
    await _login(client, editor)
    inc, rev = await _seeded(client)
    assert (await client.patch(f"/api/incidents/{inc}", json={"is_archived": False})).status_code == 200
    r = await client.post(f"/api/incidents/{inc}/journal", json={"entries": [KONTAKT_ROW]})
    assert r.status_code == 201, r.text
    r = await client.post(
        f"/api/incidents/{inc}/events", json={"events": [{"op_type": "atemschutz.contact", "payload": {}}]}
    )
    assert r.status_code == 201, r.text
    r = await client.put(f"/api/incidents/{inc}/workspace/trupps", json={"trupps": [TRUPP], "base_rev": rev})
    assert r.status_code == 200, r.text


async def test_an_open_einsatz_is_untouched(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    assert (
        await client.post(f"/api/incidents/{inc}/journal", json={"entries": [KONTAKT_ROW, ALARM_ROW]})
    ).status_code == 201
    r = await client.post(
        f"/api/incidents/{inc}/events", json={"events": [{"op_type": "atemschutz.alarm", "payload": {}}]}
    )
    assert r.status_code == 201
    r = await client.put(f"/api/incidents/{inc}/workspace/trupps", json={"trupps": [TRUPP], "base_rev": 0})
    assert r.status_code == 200


async def test_a_status_off_the_active_ones_closes_it_too(client, editor):
    """«Closed» is `Incident.is_open` — the one definition the Einsatz-Link already dies by."""
    await _login(client, editor)
    inc = await _incident(client)
    assert (await client.patch(f"/api/incidents/{inc}", json={"status": "abgeschlossen"})).status_code == 200
    r = await client.post(f"/api/incidents/{inc}/journal", json={"entries": [KONTAKT_ROW]})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "incident_closed"


# --- every device hears it --------------------------------------------------------------------


async def test_every_workspace_read_says_whether_the_einsatz_is_open(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    r = await client.get(f"/api/incidents/{inc}/workspace")
    assert r.headers["X-Incident-Open"] == "1" and "X-Incident-Closed-At" not in r.headers
    r = await client.get(f"/api/incidents/{inc}/workspace?since=0")
    assert r.status_code == 304 and r.headers["X-Incident-Open"] == "1"
    await _close(client, inc)
    # the 304 is the only answer a quiet Einsatz ever gives — it has to carry the news
    r = await client.get(f"/api/incidents/{inc}/workspace?since=0")
    assert r.status_code == 304
    assert r.headers["X-Incident-Open"] == "0" and r.headers["X-Incident-Closed-At"]
    r = await client.get(f"/api/incidents/{inc}/workspace")
    assert r.headers["X-Incident-Open"] == "0"


async def test_a_closed_einsatz_still_parks_a_long_poll(client, editor, monkeypatch):
    """No hot loop: the closed view keeps following (a Nachtrag, «Wieder öffnen»), and an answer
    at once would send it straight into the next round, forever."""
    monkeypatch.setattr(live_wait, "LONG_POLL_TIMEOUT_S", 0.2)
    await _login(client, editor)
    inc = await _incident(client)
    await _close(client, inc)
    started = time.perf_counter()
    r = await client.get(f"/api/incidents/{inc}/workspace?since=0&wait=1")
    assert time.perf_counter() - started >= 0.2
    assert r.status_code == 304 and r.headers["X-Incident-Open"] == "0"


async def test_the_close_wakes_the_devices_parked_on_the_workspace(client, editor, monkeypatch):
    """The other phone and the tablet: parked on `wait=1`, woken by the close on phone A."""
    monkeypatch.setattr(live_wait, "LONG_POLL_TIMEOUT_S", 30.0)
    await _login(client, editor)
    inc = await _incident(client)
    poll = asyncio.create_task(client.get(f"/api/incidents/{inc}/workspace?since=0&wait=1"))
    deadline = time.perf_counter() + 2.0
    while not live_wait._waiters:
        assert time.perf_counter() < deadline, "the poll never parked"
        await asyncio.sleep(0.005)
    assert (await client.patch(f"/api/incidents/{inc}", json={"is_archived": True})).status_code == 200
    r = await asyncio.wait_for(poll, timeout=2)
    assert r.status_code == 304
    assert r.headers["X-Incident-Open"] == "0"
    assert not live_wait._waiters


async def test_the_reopen_wakes_them_too_and_says_open(client, editor, monkeypatch):
    """«Wieder öffnen» on phone A reaches the closed views the same way the close did."""
    monkeypatch.setattr(live_wait, "LONG_POLL_TIMEOUT_S", 30.0)
    await _login(client, editor)
    inc = await _incident(client)
    await _close(client, inc)
    poll = asyncio.create_task(client.get(f"/api/incidents/{inc}/workspace?since=0&wait=1"))
    deadline = time.perf_counter() + 2.0
    while not live_wait._waiters:
        assert time.perf_counter() < deadline, "the poll never parked"
        await asyncio.sleep(0.005)
    assert (await client.patch(f"/api/incidents/{inc}", json={"is_archived": False})).status_code == 200
    r = await asyncio.wait_for(poll, timeout=2)
    assert r.status_code == 304
    assert r.headers["X-Incident-Open"] == "1" and "X-Incident-Closed-At" not in r.headers


async def test_a_poll_that_believes_otherwise_is_answered_at_once(client, editor, monkeypatch):
    """A reopen (or close) committed between a device's last answer and its next poll: that poll
    must not park for the full timeout on a state the device does not show."""
    monkeypatch.setattr(live_wait, "LONG_POLL_TIMEOUT_S", 30.0)
    await _login(client, editor)
    inc = await _incident(client)
    await _close(client, inc)
    r = await asyncio.wait_for(client.get(f"/api/incidents/{inc}/workspace?since=0&wait=1&open=1"), timeout=2)
    assert r.status_code == 304 and r.headers["X-Incident-Open"] == "0"
    assert (await client.patch(f"/api/incidents/{inc}", json={"is_archived": False})).status_code == 200
    r = await asyncio.wait_for(client.get(f"/api/incidents/{inc}/workspace?since=0&wait=1&open=0"), timeout=2)
    assert r.status_code == 304 and r.headers["X-Incident-Open"] == "1"


# --- judged by WHEN IT HAPPENED, not by arrival (review of #235) ---------------------------------


async def _closed_at(client, inc: str):
    from datetime import datetime

    return datetime.fromisoformat((await client.get(f"/api/incidents/{inc}")).json()["closed_at"])


async def test_a_live_write_made_before_the_close_is_recorded(client, editor):
    """A Kontakt tapped at 14:44 on a phone whose uplink came back at 14:47 is a true fact of the
    Einsatz closed at 14:45 — recorded (a Nachtrag on paper), not refused."""
    from datetime import timedelta

    await _login(client, editor)
    inc, rev = await _seeded(client)
    closed = await _closed_at(client, inc)
    before = (closed - timedelta(minutes=1)).isoformat()
    within = (closed + timedelta(seconds=60)).isoformat()  # inside the clock-skew tolerance
    after = (closed + timedelta(minutes=5)).isoformat()

    r = await client.post(f"/api/incidents/{inc}/journal", json={"entries": [{**KONTAKT_ROW, "at": before}]})
    assert r.status_code == 201, r.text
    r = await client.post(f"/api/incidents/{inc}/journal", json={"entries": [{**ALARM_ROW, "at": within}]})
    assert r.status_code == 201, r.text
    _assert_closed_refusal(
        await client.post(
            f"/api/incidents/{inc}/journal", json={"entries": [{**KONTAKT_ROW, "id": "r-late", "at": after}]}
        )
    )

    ev = {"op_type": "atemschutz.contact", "payload": {"id": "tr1"}}
    r = await client.post(f"/api/incidents/{inc}/events", json={"events": [{**ev, "occurred_at": before}]})
    assert r.status_code == 201, r.text
    _assert_closed_refusal(
        await client.post(f"/api/incidents/{inc}/events", json={"events": [{**ev, "occurred_at": after}]})
    )

    stored = (await client.get(f"/api/incidents/{inc}/workspace")).json()["workspace"]
    kontakt = {**stored, "trupps": [{**TRUPP, "lastContactTime": before}]}
    _assert_closed_refusal(
        await client.put(
            f"/api/incidents/{inc}/workspace", json={"workspace": kontakt, "base_rev": rev, "edited_at": after}
        )
    )
    r = await client.put(
        f"/api/incidents/{inc}/workspace", json={"workspace": kontakt, "base_rev": rev, "edited_at": before}
    )
    assert r.status_code == 200, r.text
    rev = r.json()["workspace_rev"]
    _assert_closed_refusal(
        await client.put(
            f"/api/incidents/{inc}/workspace/trupps", json={"trupps": [TRUPP], "base_rev": rev, "edited_at": after}
        )
    )
    r = await client.put(
        f"/api/incidents/{inc}/workspace/trupps", json={"trupps": [TRUPP], "base_rev": rev, "edited_at": before}
    )
    assert r.status_code == 200, r.text


async def test_a_row_the_verlauf_already_holds_is_still_the_idempotent_success(client, editor):
    """A retry whose answer was lost, arriving after the close: the row is in the record — the
    answer is the success it always was, not a refusal that would park a row the Verlauf has."""
    await _login(client, editor)
    inc = await _incident(client)
    assert (await client.post(f"/api/incidents/{inc}/journal", json={"entries": [KONTAKT_ROW]})).status_code == 201
    ev = {"client_id": "ev-1", "op_type": "atemschutz.contact", "payload": {"id": "tr1"}}
    assert (await client.post(f"/api/incidents/{inc}/events", json={"events": [ev]})).status_code == 201
    await _close(client, inc)
    r = await client.post(f"/api/incidents/{inc}/journal", json={"entries": [KONTAKT_ROW]})
    assert r.status_code == 201 and r.json()["entries"] == []
    assert (await client.post(f"/api/incidents/{inc}/events", json={"events": [ev]})).status_code == 201


async def test_a_conflict_row_is_record_keeping_closed_or_not(client, editor):
    await _login(client, editor)
    inc, _ = await _seeded(client)
    row = {
        "id": "tc-tr1-1",
        "t": "15:00",
        "icon": "warn",
        "text": "Trupp 1 – gleichzeitig geändert",
        "kind": "team",
        "conflict": {"op": "resolved", "sig": "s1", "choice": 0},
    }
    r = await client.post(f"/api/incidents/{inc}/journal", json={"entries": [row]})
    assert r.status_code == 201, r.text


async def test_a_view_change_beside_a_rapport_edit_is_not_refused(client, editor):
    """Which plan is open, the Ebenen, the saved views: a save carrying one of those beside a
    Rapport correction must not take the correction down with it."""
    await _login(client, editor)
    inc, rev = await _seeded(client)
    stored = (await client.get(f"/api/incidents/{inc}/workspace")).json()["workspace"]
    view_only = {**stored, "activePlanId": "modul2", "layerState": [{"id": "hydranten", "visible": False}]}
    r = await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": view_only, "base_rev": rev})
    assert r.status_code == 200, r.text
    rev = r.json()["workspace_rev"]
    mixed = {**view_only, "recent": ["VKF Feuer"], "reportMeta": {"kurzbericht": "korrigiert"}}
    r = await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": mixed, "base_rev": rev})
    assert r.status_code == 200, r.text
    assert (await client.get(f"/api/incidents/{inc}/workspace")).json()["workspace"]["reportMeta"] == {
        "kurzbericht": "korrigiert"
    }

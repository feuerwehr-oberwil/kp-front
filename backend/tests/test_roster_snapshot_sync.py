"""KP Front's roster-snapshot ingestion against a real schema (app/roster_snapshot_sync.py).

The matching rules are tested pure in ``test_roster_snapshot_ingest.py`` (byte-identical with
KP Rück's). This file is the part that is KP Front's own: that a plan lands in ``personnel`` and
``personnel_external_identities`` the way it says, that a failure leaves the roster AND the last
good snapshot untouched, that the report is on ``GET /api/system``, that the cap holds until an
admin releases it — and that nothing at all happens on a station that never set a source, which
is every station that does not use this.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select

from app import connector_state, roster_snapshot_sync, scheduler
from app.credentials import CredentialRefusedError, validate
from app.models import ConnectorState, Personnel, PersonnelExternalIdentity
from app.roster_snapshot import EXAMPLE_SNAPSHOT, medical_shaped


class _SessionCtx:
    def __init__(self, session):
        self._session = session

    async def __aenter__(self):
        return self._session

    async def __aexit__(self, *exc):
        return False


@pytest.fixture(autouse=True)
def _memo():
    connector_state.reset_memo()
    yield
    connector_state.reset_memo()


@pytest.fixture
def source(tmp_path: Path, monkeypatch) -> Path:
    """A snapshot file on disk, configured as the source the way a self-hoster would."""
    path = tmp_path / "roster.json"
    path.write_text(json.dumps(EXAMPLE_SNAPSHOT), encoding="utf-8")
    monkeypatch.setenv("ROSTER_SNAPSHOT_SOURCE", str(path))
    return path


def _write(path: Path, doc: dict[str, Any]) -> None:
    path.write_text(json.dumps(doc), encoding="utf-8")


async def _people(db) -> list[Personnel]:
    return list((await db.execute(select(Personnel).order_by(Personnel.display_name))).scalars())


async def _identities(db) -> set[tuple[str, str, str]]:
    rows = (await db.execute(select(PersonnelExternalIdentity))).scalars()
    by_id = {p.id: p.display_name for p in await _people(db)}
    return {(by_id[r.personnel_id], r.provider, r.external_id) for r in rows}


async def _state(db) -> ConnectorState:
    row = (
        await db.execute(select(ConnectorState).where(ConnectorState.name == connector_state.ROSTER_SNAPSHOT))
    ).scalar_one()
    await db.refresh(row)
    return row


async def test_without_a_source_nothing_runs_and_nothing_is_recorded(db_session, monkeypatch):
    """Every station that does not use this: the tick is a no-op, the roster untouched."""
    monkeypatch.delenv("ROSTER_SNAPSHOT_SOURCE", raising=False)
    monkeypatch.setattr(scheduler, "async_session_maker", lambda: _SessionCtx(db_session))
    db_session.add(Personnel(display_name="Hand Eingetragen", is_active=True))
    await db_session.commit()

    await scheduler._roster_snapshot_tick()

    assert [p.display_name for p in await _people(db_session)] == ["Hand Eingetragen"]
    assert (await db_session.execute(select(ConnectorState))).scalars().all() == []


async def test_a_first_run_creates_the_people_with_their_identities(db_session, source):
    status = await roster_snapshot_sync.run(db_session, trigger="manual")

    assert status["outcome"]["created"] == 3  # the fourth is inactive and a stranger: reported, not created
    assert [u["reason"] for u in status["outcome"]["unmatched"]] == ["inactive_in_snapshot"]
    people = {p.display_name: p for p in await _people(db_session)}
    assert set(people) == {"Muster Hans", "Beispiel Anna", "Dorfmatt Peter"}
    assert people["Muster Hans"].rank == "maj" and people["Muster Hans"].first_name == "Hans"
    assert ("Muster Hans", "alarmierung", "4711") in await _identities(db_session)
    assert ("Muster Hans", "musterdorf-personalstamm", "pers-0001") in await _identities(db_session)

    state = await _state(db_session)
    assert state.last_success_at is not None and state.last_error is None
    assert state.detail["lastGood"]["count"] == 4


async def test_the_same_file_twice_changes_nothing(db_session, source):
    await roster_snapshot_sync.run(db_session, trigger="manual")
    before = [(p.id, p.display_name, p.rank, p.is_active) for p in await _people(db_session)]
    idents = await _identities(db_session)

    status = await roster_snapshot_sync.run(db_session, trigger="manual")

    assert status["outcome"]["created"] == 0 and status["outcome"]["updated"] == 0
    assert status["outcome"]["matched"] == 3
    assert [(p.id, p.display_name, p.rank, p.is_active) for p in await _people(db_session)] == before
    assert await _identities(db_session) == idents
    # …and the scheduled run does not even reconcile an unchanged file
    assert (await roster_snapshot_sync.run(db_session, trigger="scheduled", skip_unchanged=True))["unchanged"]


async def test_a_divera_synced_person_keeps_their_divera_link(db_session, source):
    """A station that ran on Divera adopts the snapshot: the person is found by the Divera id
    the snapshot lists, gets the snapshot key beside it, and the Divera row is untouched."""
    doc = copy.deepcopy(EXAMPLE_SNAPSHOT)
    doc["people"][0]["identities"] = [{"provider": "divera", "external_id": "4711"}]
    _write(source, doc)
    hans = Personnel(display_name="Muster Hans", is_active=True)
    db_session.add(hans)
    await db_session.flush()
    db_session.add(PersonnelExternalIdentity(personnel_id=hans.id, provider="divera", external_id="4711"))
    await db_session.commit()

    await roster_snapshot_sync.run(db_session, trigger="manual")

    hanses = [p for p in await _people(db_session) if p.display_name == "Muster Hans"]
    assert len(hanses) == 1 and hanses[0].id == hans.id  # the same row: a stable person id
    idents = await _identities(db_session)
    assert ("Muster Hans", "divera", "4711") in idents
    assert ("Muster Hans", "musterdorf-personalstamm", "pers-0001") in idents


async def test_a_failed_fetch_keeps_the_roster_and_the_last_good_snapshot(db_session, source):
    await roster_snapshot_sync.run(db_session, trigger="manual")
    good = (await _state(db_session)).detail["lastGood"]
    roster = [(p.display_name, p.is_active) for p in await _people(db_session)]

    source.unlink()
    status = await roster_snapshot_sync.run(db_session, trigger="scheduled")

    assert status["outcome"]["refused"] == "file not found"
    state = await _state(db_session)
    assert state.last_error == "file not found"
    assert state.detail["lastGood"] == good
    assert [(p.display_name, p.is_active) for p in await _people(db_session)] == roster


async def test_an_invalid_file_is_refused_and_reported(db_session, source):
    await roster_snapshot_sync.run(db_session, trigger="manual")
    roster = [(p.display_name, p.is_active) for p in await _people(db_session)]
    _write(source, {**EXAMPLE_SNAPSHOT, "count": 99})

    status = await roster_snapshot_sync.run(db_session, trigger="manual")

    assert "count" in status["outcome"]["refused"]
    assert (await _state(db_session)).last_error
    assert [(p.display_name, p.is_active) for p in await _people(db_session)] == roster


async def test_a_medical_key_writes_nothing_and_stores_nothing_medical(db_session, source):
    """The no-medical-fields guarantee, end to end: file → run → database → status card."""
    doc = copy.deepcopy(EXAMPLE_SNAPSHOT)
    doc["people"][0]["impfstatus"] = "vollständig"
    _write(source, doc)

    status = await roster_snapshot_sync.run(db_session, trigger="manual")

    assert "medical" in status["outcome"]["refused"]
    assert await _people(db_session) == []

    def keys(node: Any) -> list[str]:
        if isinstance(node, dict):
            return [str(k) for k in node] + [k for v in node.values() for k in keys(v)]
        if isinstance(node, list):
            return [k for v in node for k in keys(v)]
        return []

    stored = (await _state(db_session)).detail
    assert [k for k in keys(stored) if medical_shaped(k)] == []
    assert "vollständig" not in json.dumps(stored)
    # The columns a snapshot can reach are these and no others — the contract has nothing else.
    assert {c.name for c in Personnel.__table__.columns} >= {"display_name", "first_name", "last_name", "rank"}
    assert not [c.name for c in Personnel.__table__.columns if medical_shaped(c.name)]


async def test_the_cap_holds_a_mass_departure_until_an_admin_releases_it(
    db_session, client, editor, admin_login, source
):
    people = [
        {"external_id": f"p{i}", "display_name": f"Person{i:02d} Vorname", "active": True, "identities": []}
        for i in range(10)
    ]
    _write(source, {**EXAMPLE_SNAPSHOT, "people": people, "count": 10})
    await roster_snapshot_sync.run(db_session, trigger="manual")
    _write(source, {**EXAMPLE_SNAPSHOT, "people": people[:6], "count": 6, "generated_at": "2026-08-03T04:00:00+00:00"})

    status = await roster_snapshot_sync.run(db_session, trigger="scheduled")

    assert status["held"] is True and status["pendingDeactivations"] == 4
    assert sum(p.is_active for p in await _people(db_session)) == 10  # nothing written
    assert (await _state(db_session)).last_error.startswith("held")

    # The System card shows it…
    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    await admin_login(client)
    body = (await client.get("/api/system")).json()
    row = next(c for c in body["connectors"] if c["id"] == "roster_snapshot")
    assert row["configured"] is True and row["state"] == "offline"
    assert row["counts"]["held"] is True and row["counts"]["pendingDeactivations"] == 4

    # …and «Abgänge übernehmen» releases it.
    r = await client.post("/api/personnel/snapshot/sync", json={"force": True})
    assert r.status_code == 200, r.text
    assert r.json()["outcome"]["deactivated"] == 4
    db_session.expire_all()
    assert sum(p.is_active for p in await _people(db_session)) == 6


async def test_the_sync_endpoint_is_admin_only_and_says_when_nothing_is_set_up(
    db_session, client, editor, admin_login, monkeypatch
):
    monkeypatch.delenv("ROSTER_SNAPSHOT_SOURCE", raising=False)
    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert (await client.post("/api/personnel/snapshot/sync")).status_code in (401, 403)
    await admin_login(client)
    assert (await client.post("/api/personnel/snapshot/sync")).status_code == 503


async def test_the_tick_runs_when_due_and_waits_for_the_interval(db_session, source, monkeypatch):
    monkeypatch.setattr(scheduler, "async_session_maker", lambda: _SessionCtx(db_session))
    await scheduler._roster_snapshot_tick()
    assert len(await _people(db_session)) == 3
    first = (await _state(db_session)).last_attempt_at

    await scheduler._roster_snapshot_tick()  # within the hour: not due, not even attempted
    assert (await _state(db_session)).last_attempt_at == first


@pytest.mark.parametrize(
    ("value", "ok"),
    [
        ("https://hr.example.ch/roster.json", True),
        ("http://intranet.local/roster.json", True),  # own network: plain http allowed
        ("/srv/kp/roster.json", True),
        ("file:///srv/kp/roster.json", True),
        ("http://hr.example.ch/roster.json", False),  # the internet in the clear
        ("roster.json", False),
        ("ftp://hr.example.ch/roster.json", False),
    ],
)
def test_the_source_credential_takes_a_url_or_an_absolute_path(value, ok):
    if ok:
        assert validate("roster_snapshot_source", value)
    else:
        with pytest.raises(CredentialRefusedError):
            validate("roster_snapshot_source", value)


# --- review round (08.10.2026) ------------------------------------------------------------


def _ten(source: Path, n: int = 10, *, at: str = "2026-08-02T04:00:00+00:00", keep: int | None = None) -> None:
    people = [
        {"external_id": f"p{i}", "display_name": f"Person{i:02d} Vorname", "active": True, "identities": []}
        for i in range(n)
    ]
    listed = people[: keep if keep is not None else n]
    _write(source, {**EXAMPLE_SNAPSHOT, "people": listed, "count": len(listed), "generated_at": at})


async def test_a_run_that_crashes_writes_nothing_and_says_so(db_session, source, monkeypatch):
    await roster_snapshot_sync.run(db_session, trigger="manual")
    good = (await _state(db_session)).detail["lastGood"]
    roster = sorted((p.display_name, p.is_active) for p in await _people(db_session))
    doc = copy.deepcopy(EXAMPLE_SNAPSHOT)
    doc["people"][0]["display_name"] = "Muster-Keller Hans"
    doc["generated_at"] = "2026-08-03T04:00:00+00:00"
    _write(source, doc)

    async def boom(*args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(roster_snapshot_sync, "apply", boom)
    status = await roster_snapshot_sync.run(db_session, trigger="scheduled")

    assert status["outcome"]["refused"].startswith("run failed")
    state = await _state(db_session)
    assert state.last_error == "RuntimeError" and state.detail["lastGood"] == good
    db_session.expire_all()
    assert sorted((p.display_name, p.is_active) for p in await _people(db_session)) == roster


async def test_nobody_on_an_open_einsatz_is_deactivated_until_it_is_archived(db_session, source):
    from app.models import Incident

    _ten(source)
    await roster_snapshot_sync.run(db_session, trigger="manual")
    leaver = next(p for p in await _people(db_session) if p.display_name == "Person09 Vorname")
    einsatz = Incident(
        title="Brand", source="manual", map_workspace_json={"attendance": {str(leaver.id): {"present": True}}}
    )
    db_session.add(einsatz)
    await db_session.commit()

    _ten(source, keep=9, at="2026-08-03T04:00:00+00:00")
    status = await roster_snapshot_sync.run(db_session, trigger="scheduled", skip_unchanged=True)
    assert status["outcome"]["deactivated"] == 0
    assert [p["display_name"] for p in status["postponed"]] == ["Person09 Vorname"]
    await db_session.refresh(leaver)
    assert leaver.is_active is True

    einsatz.is_archived = True
    await db_session.commit()
    # the file has not changed — the postponed person is still picked up
    status = await roster_snapshot_sync.run(db_session, trigger="scheduled", skip_unchanged=True)
    assert status["outcome"]["deactivated"] == 1 and status["postponed"] == []
    await db_session.refresh(leaver)
    assert leaver.is_active is False


async def test_while_divera_syncs_its_people_keep_their_names(db_session, source, monkeypatch):
    doc = copy.deepcopy(EXAMPLE_SNAPSHOT)
    doc["people"][0]["identities"] = [{"provider": "divera", "external_id": "4711"}]
    doc["people"][0]["display_name"] = "Hans Muster"
    _write(source, doc)
    hans = Personnel(display_name="Muster Hans", is_active=True)
    db_session.add(hans)
    await db_session.flush()
    db_session.add(PersonnelExternalIdentity(personnel_id=hans.id, provider="divera", external_id="4711"))
    await db_session.commit()
    monkeypatch.setenv("DIVERA_ACCESS_KEY", "k")
    from app.config import settings

    monkeypatch.setattr(settings, "divera_access_key", "k")

    await roster_snapshot_sync.run(db_session, trigger="manual")

    await db_session.refresh(hans)
    assert hans.display_name == "Muster Hans"  # the Divera sync owns it
    assert ("Muster Hans", "musterdorf-personalstamm", "pers-0001") in await _identities(db_session)

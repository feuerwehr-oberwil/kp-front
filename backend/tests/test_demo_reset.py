"""The pre-filled demo workspace builder is pure, so it's unit-tested without a DB."""

import json
from datetime import UTC, datetime

import pytest
from sqlalchemy import text

import app.demo_reset as dr
from app.demo_reset import build_demo_workspace

NOW = datetime(2026, 7, 19, 12, 0, 0, tzinfo=UTC)

SCENE = {
    "entities": [{"id": "brand", "kind": "symbol", "coord": [7.57, 47.52]}],
    "drawings": [{"id": "d1", "kind": "line", "coords": [[7.57, 47.52]]}],
    "board": {"gebaeude": [{"id": "r1", "t": "16:24", "truppId": "trupp1",
                            "trail": [{"t": "16:24", "x": 0.4, "y": 0.5, "floor": 1}]}]},
}


def _ws():
    return build_demo_workspace(SCENE, [("pid-1", "Hans Müller"), ("pid-2", "Anna Meier")], NOW)


def test_adds_live_collections():
    ws = _ws()
    assert len(ws["trupps"]) == 3
    assert len(ws["mittel"]) == 4
    # two in the field (aktiv), one Sicherheitstrupp angemeldet with no clock running
    assert [t["status"] for t in ws["trupps"]] == ["aktiv", "aktiv", "angemeldet"]
    assert ws["trupps"][2]["entryTime"] == "" and ws["trupps"][2]["lastContactTime"] == ""
    # every Trupp is 3 people: a leader (name) + two members
    assert all(len(t["members"]) == 2 for t in ws["trupps"])


def test_trupp_clocks_are_reset_relative():
    ws = _ws()
    # the field Trupps' contact is recent (< the 5-min interval) so they read "Kontakt OK"
    t0 = ws["trupps"][0]
    assert t0["entryTime"].endswith("Z") and t0["lastContactTime"].endswith("Z")
    assert datetime.fromisoformat(t0["lastContactTime"].replace("Z", "+00:00")) < NOW


def test_attendance_keyed_by_person_id():
    ws = _ws()
    assert set(ws["attendance"]) == {"pid-1", "pid-2"}
    assert ws["attendance"]["pid-1"] == {
        "status": "present",
        "checkedInAt": ws["attendance"]["pid-1"]["checkedInAt"],
        "displayNameSnapshot": "Hans Müller",
    }


def test_mittel_key_to_catalogue_ids():
    ws = _ws()
    assert {m["materialId"] for m in ws["mittel"]} == {"schaummittel", "schlauch-c", "oelbindemittel", "luefter"}
    assert all(m["menge"] > 0 and m["at"].endswith("Z") for m in ws["mittel"])


def test_board_chip_times_refreshed():
    ws = _ws()
    res = ws["board"]["gebaeude"][0]
    assert res["t"] != "16:24"  # rebased to a fresh HH:MM
    assert res["trail"][0]["t"] == res["t"]


def test_scene_geometry_preserved():
    ws = _ws()
    assert ws["entities"][0]["coord"] == [7.57, 47.52]
    assert ws["drawings"][0]["coords"] == [[7.57, 47.52]]


@pytest.mark.asyncio
async def test_demo_reset_job_gated_on_setting(monkeypatch):
    """The destructive in-process demo auto-reset is fail-closed: no job unless
    demo_reset_seconds > 0 (a real station never wipes itself), and when enabled it registers
    on the configured cadence."""
    from fastapi import FastAPI

    import app.scheduler as sched
    from app.config import settings

    monkeypatch.setattr(settings, "demo_reset_seconds", 0)
    await sched.start_scheduler(FastAPI())
    assert sched._scheduler.get_job("demo_reset") is None
    await sched.stop_scheduler()

    monkeypatch.setattr(settings, "demo_reset_seconds", 7200)
    await sched.start_scheduler(FastAPI())
    job = sched._scheduler.get_job("demo_reset")
    assert job is not None
    assert job.trigger.interval.total_seconds() == 7200
    await sched.stop_scheduler()


@pytest.mark.asyncio
async def test_reset_seeds_resolvable_attendance(session_factory, monkeypatch):
    """Regression: Personnel.id is a uuid4 COLUMN default, assigned at flush — reading it before
    flush yielded None, so Anwesenheit was keyed "None" (one ghost entry). reset() must flush
    first so every attendance key is a real Personnel id."""
    monkeypatch.setattr(dr, "async_session_maker", session_factory)
    await dr.reset()
    async with session_factory() as db:
        pids = set((await db.execute(text("select cast(id as text) from personnel"))).scalars().all())
        ws = (await db.execute(text(
            "select map_workspace_json from incidents order by started_at desc limit 1"
        ))).scalar_one()
    if isinstance(ws, str):  # sqlite (test default) returns JSONB as text via raw SQL; pg gives a dict
        ws = json.loads(ws)
    att = ws["attendance"]
    assert "None" not in att
    assert len(att) == 10
    # every present person resolves to a real roster row (normalize UUID text: sqlite's raw-SQL
    # cast can drop hyphens vs Python's str(uuid), so compare hyphen-insensitively)
    def _norm(s: str) -> str:
        return s.replace("-", "").lower()
    assert {_norm(k) for k in att} <= {_norm(p) for p in pids}


@pytest.mark.asyncio
async def test_reset_keeps_objects_when_not_wiping(session_factory, monkeypatch):
    """Regression: the in-process scheduler calls reset(wipe_objects=False) and never reloads the
    reference Einsatzobjekte — so reset() must LEAVE them in place. Wiping them (as the CLI path
    does) stripped the Schloss's Modul plans from the demo's plan rail for most of each cycle."""
    from app.models import ObjectSite

    monkeypatch.setattr(dr, "async_session_maker", session_factory)
    async with session_factory() as db:
        db.add(ObjectSite(name="Schloss Bottmingen", address="Schlossgasse 9, 4103 Bottmingen",
                          lat=47.5237186, lng=7.5703454))
        await db.commit()

    # in-process cadence: incident/roster reseeded, objects retained
    await dr.reset(wipe_objects=False)
    async with session_factory() as db:
        kept = (await db.execute(text("select count(*) from objects"))).scalar_one()
    assert kept == 1, "in-process reset must keep the reference objects (nothing reloads them)"

    # CLI cadence (default): objects cleared so the re-pushed manifest is authoritative
    await dr.reset()
    async with session_factory() as db:
        cleared = (await db.execute(text("select count(*) from objects"))).scalar_one()
    assert cleared == 0, "CLI reset clears objects (the reset script reloads them next step)"

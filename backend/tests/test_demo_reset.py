"""The pre-filled demo workspace builder is pure, so it's unit-tested without a DB."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import text

import app.demo_reset as dr
from app.demo_reset import build_demo_workspace

NOW = datetime(2026, 7, 19, 12, 0, 0, tzinfo=UTC)

SCENE = {
    "entities": [{"id": "brand", "kind": "symbol", "coord": [7.57, 47.52]}],
    "drawings": [{"id": "d1", "kind": "line", "coords": [[7.57, 47.52]]}],
    "board": {
        "gebaeude": [
            {"id": "r1", "t": "16:24", "truppId": "trupp1", "trail": [{"t": "16:24", "x": 0.4, "y": 0.5, "floor": 1}]}
        ]
    },
}


def _ws():
    return build_demo_workspace(SCENE, [("pid-1", "Hans Müller"), ("pid-2", "Anna Meier")], NOW)


def test_adds_live_collections():
    ws = _ws()
    assert len(ws["trupps"]) == 3
    assert len(ws["mittel"]) == 5
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


def test_everybody_present_is_on_the_clock_from_the_alarm():
    """«ab Einsatzbeginn» is the button the operator presses, and a Wehr turning out to a
    Zimmerbrand is counted from the alarm. A fixed offset started everyone 14 minutes after the
    incident did — 14 minutes of unaccounted time on every person, on a demo whose whole job is
    to show what a filled-in Einsatz looks like."""
    ws = _ws()
    started = NOW - timedelta(minutes=dr.DEMO_ELAPSED_MIN)
    for a in ws["attendance"].values():
        assert datetime.fromisoformat(a["checkedInAt"].replace("Z", "+00:00")) == started


def test_mittel_key_to_catalogue_ids():
    ws = _ws()
    # no "oelbindemittel": the demo incident is a Zimmerbrand, and the Umwelt group belongs to a spill
    assert {m["materialId"] for m in ws["mittel"]} == {
        "schaummittel",
        "schlauch-c",
        "schlauch-b",
        "luefter",
        "leitkegel",
    }
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
    monkeypatch.setenv("KP_DEMO_RESET", "1")  # this is the throwaway test database
    monkeypatch.setattr(dr, "async_session_maker", session_factory)
    await dr.reset()
    async with session_factory() as db:
        pids = set((await db.execute(text("select cast(id as text) from personnel"))).scalars().all())
        ws = (
            await db.execute(text("select map_workspace_json from incidents order by started_at desc limit 1"))
        ).scalar_one()
    if isinstance(ws, str):  # sqlite (test default) returns JSONB as text via raw SQL; pg gives a dict
        ws = json.loads(ws)
    att = ws["attendance"]
    assert "None" not in att
    assert len(att) == len(dr.DEMO_PRESENT)

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

    monkeypatch.setenv("KP_DEMO_RESET", "1")  # this is the throwaway test database
    monkeypatch.setattr(dr, "async_session_maker", session_factory)
    async with session_factory() as db:
        db.add(
            ObjectSite(
                name="Schloss Bottmingen", address="Schlossgasse 9, 4103 Bottmingen", lat=47.5237186, lng=7.5703454
            )
        )
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


class TestTheDemoGuardCoversEveryCaller:
    """`reset()` deletes every incident, its journal and the roster.

    The KP_DEMO_RESET check used to sit in the module's `__main__` block, so it only covered
    the CLI. `scheduler.py` imports `reset` and awaits it directly — the unattended, timed
    path — and therefore bypassed the guard entirely, on whatever DATABASE_URL named. The
    module docstring claimed it "can never be pointed at a real station's database".
    """

    @pytest.mark.asyncio
    async def test_reset_refuses_without_the_confirmation_variable(self, monkeypatch):
        monkeypatch.delenv("KP_DEMO_RESET", raising=False)
        with pytest.raises(dr.NotADemoDatabaseError, match="KP_DEMO_RESET"):
            await dr.reset()

    @pytest.mark.asyncio
    async def test_reset_refuses_when_the_variable_is_not_exactly_one(self, monkeypatch):
        monkeypatch.setenv("KP_DEMO_RESET", "true")
        with pytest.raises(dr.NotADemoDatabaseError):
            await dr.reset()

    @pytest.mark.asyncio
    async def test_the_guard_runs_before_anything_is_deleted(self, monkeypatch):
        """It must refuse without ever opening a session, let alone issuing a DELETE."""
        monkeypatch.delenv("KP_DEMO_RESET", raising=False)

        def _explode():  # pragma: no cover - reaching this is the failure
            raise AssertionError("reset() opened a database session before checking the guard")

        monkeypatch.setattr(dr, "async_session_maker", _explode)
        with pytest.raises(dr.NotADemoDatabaseError):
            await dr.reset()

    def test_the_guard_is_importable_by_the_scheduler_path(self):
        """The scheduler awaits `reset` directly, so the check has to be inside it."""
        import inspect

        assert "assert_demo_database()" in inspect.getsource(dr.reset)


def test_the_demo_alarm_predates_everything_it_seeds():
    """⚠️ The demo used to contradict itself: DEMO_ELAPSED_MIN was 14, so the crew checked in
    20 minutes ago — six minutes BEFORE the alarm — and the first Atemschutz-Trupp entered the
    building in the same minute the pager went off. The Rapport's own Zeiten-Plausibilität flags
    that, so the demo was failing the check the app ships. Every seeded `now - timedelta(...)`
    has to sit INSIDE the incident.
    """
    import re
    from pathlib import Path

    from app.demo_reset import DEMO_ELAPSED_MIN

    src = Path(__file__).resolve().parents[1].joinpath("app/demo_reset.py").read_text()
    stamps = {int(m) for m in re.findall(r"timedelta\(minutes=(\d+)\)", src)}
    predating = sorted(m for m in stamps if m > DEMO_ELAPSED_MIN)
    assert not predating, f"seeded stamps older than the alarm (now-{DEMO_ELAPSED_MIN}min): {predating}"


def test_the_zeiten_grid_is_filled_and_plausible():
    """An empty Zeiten grid on a fully worked demo Einsatz reads as a missing feature rather than
    as an unfilled form. The times also have to survive the Rapport's own plausibility check:
    nothing before the alarm, and everything before the first Trupp went in at −14."""
    ws = _ws()
    meta = ws["reportMeta"]
    started = NOW - timedelta(minutes=dr.DEMO_ELAPSED_MIN)
    first_entry = NOW - timedelta(minutes=14)

    stamps = [g["alarmedAt"] for g in meta["gruppen"]]
    stamps += [t for f in meta["fahrzeuge"] for t in (f.get("ausgerueckt"), f.get("vorOrt")) if t]
    assert stamps, "the demo has to carry example Alarmierungs-/Ausrückzeiten"
    for iso in stamps:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        assert started <= t <= first_entry, f"{iso} sits outside the incident's own run-up"

    # a half-filled row is the normal state of this grid mid-Einsatz — the demo shows one
    assert any(f.get("vorOrt") is None for f in meta["fahrzeuge"])
    # these are what the milestone webhook would have prefilled, so none may claim to be a human edit
    assert not any(r.get("manual") for r in [*meta["gruppen"], *meta["fahrzeuge"]])


def test_the_seeded_zeiten_match_configured_rows():
    """A time keyed to an id the station has not configured renders nowhere — the grid is built
    from alarms.groups / fleet.vehicles, and an orphan row is invisible rather than wrong."""
    cfg = json.loads((Path(__file__).resolve().parents[2] / "examples" / "demo-data" / "config.json").read_text())
    group_ids = {g["id"] for g in cfg["alarms"]["groups"]}
    vehicle_ids = {v["id"] for v in cfg["fleet"]["vehicles"]}
    meta = _ws()["reportMeta"]
    assert {g["id"] for g in meta["gruppen"]} <= group_ids
    assert {f["id"] for f in meta["fahrzeuge"]} <= vehicle_ids

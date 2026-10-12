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
    "entities": [
        {"id": "brand", "kind": "symbol", "coord": [7.57, 47.52]},
        {"id": "r1", "kind": "team", "t": "16:24", "coord": [7.57, 47.52], "truppId": "trupp1"},
    ],
    "drawings": [{"id": "d1", "kind": "line", "coords": [[7.57, 47.52]]}],
    "board": {
        "gebaeude": [
            {"id": "r1", "kind": "resource", "t": "16:24", "truppId": "trupp1"},
            {"id": "l1", "kind": "draw", "pts": [[0.4, 0.5, 1]]},
        ]
    },
}


def _ws():
    return build_demo_workspace(SCENE, [("pid-1", "Hans Müller"), ("pid-2", "Anna Meier")], NOW)


def test_adds_live_collections():
    ws = _ws()
    assert len(ws["trupps"]) == 4
    assert len(ws["mittel"]) == 5
    # two in the field (aktiv), one Sicherheitstrupp angemeldet with no clock running, and the
    # Verkehrsdienst (ohne Atemschutz) at work
    assert [t["status"] for t in ws["trupps"]] == ["aktiv", "aktiv", "angemeldet", "aktiv"]
    assert ws["trupps"][2]["entryTime"] == "" and ws["trupps"][2]["lastContactTime"] == ""
    # every Atemschutz-Trupp is 3 people: a leader (name) + two members
    pa = [t for t in ws["trupps"] if t.get("kind", "atemschutz") == "atemschutz"]
    assert len(pa) == 3 and all(len(t["members"]) == 2 for t in pa)


def test_trupp_members_carry_roster_ids():
    """A demo Trupp must LINK to the roster, not merely repeat its names.

    Seeded with names alone, every member was an unlinked hand-typed entry: the Trupp form
    tagged all nine «Gast», and the person picker kept offering people who were already in a
    Trupp — the only thing joining the two was a string that had to match the served display
    name exactly, which it stopped doing the moment the roster's name order differed."""
    present = [(f"pid-{i}", n) for i, n in enumerate(sorted(dr.DEMO_PRESENT))]
    by_name = {name: pid for pid, name in present}
    trupps = build_demo_workspace(SCENE, present, NOW)["trupps"]
    for t in trupps:
        assert t["leaderPersonId"] == by_name[t["name"]]
        assert t["memberPersonIds"] == [by_name[m] for m in t["members"]]
    # …and no two Trupps claim the same person (one person, one Trupp)
    ids = [t["leaderPersonId"] for t in trupps] + [p for t in trupps for p in t["memberPersonIds"]]
    assert len(ids) == len(set(ids))


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
    # the Karte's twin of the chip reads the same time; a line on the storey gets no clock
    assert next(e for e in ws["entities"] if e["kind"] == "team")["t"] == res["t"]
    assert "t" not in ws["board"]["gebaeude"][1]


def test_the_shipped_scene_seeds_no_trail_and_no_absperrkreis():
    """11.10.2026, owner: the Trupp's «last tracked places» and the Absperrkreis are gone from
    the demo — the circle made the Karte open zoomed out and tinted the whole Gebäude view."""
    scene = json.loads(dr.SCENE_PATH.read_text(encoding="utf-8"))
    assert not any(e.get("trail") for e in scene["entities"])
    assert not any(a.get("trail") for a in scene["board"]["gebaeude"])
    assert not any(d["kind"] == "circle" for d in scene["drawings"])
    # the seeded Trupp 1 still points at a Leitung that exists
    line_ids = {d["id"] for d in scene["drawings"]}
    ws = build_demo_workspace(scene, [], NOW)
    assert ws["trupps"][0]["lineId"] in line_ids


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
                name="Schloss Musterdorf", address="Schlossgasse 9, 9999 Musterdorf", lat=47.5237186, lng=7.5703454
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


async def test_reset_wipes_an_object_whose_sheet_has_a_revision(session_factory, monkeypatch):
    """Regression (20.09.2026): `plan_revisions.dataset_id` is ON DELETE RESTRICT, so the cascade
    object → plan dataset aborted the WHOLE reset as soon as one sheet had a revision – which,
    since 0.11.0, every stored sheet has. The nightly demo reset failed for a week on it, and the
    test above never noticed because its object carries no plan."""
    from app.models import ObjectSite, PlanAlignment, PlanPageFloor, PlanRevision, ReferenceDataset

    monkeypatch.setenv("KP_DEMO_RESET", "1")  # this is the throwaway test database
    monkeypatch.setattr(dr, "async_session_maker", session_factory)
    async with session_factory() as db:
        site = ObjectSite(name="Schloss Musterdorf", address="Schlossgasse 9, 9999 Musterdorf")
        db.add(site)
        db.add(ReferenceDataset(id="geo:hydrant", kind="geojson"))
        await db.flush()
        plan_id = f"plan:{site.id}:modul1"
        db.add(ReferenceDataset(id=plan_id, object_id=site.id, module="modul1", kind="pdf"))
        await db.flush()
        db.add(PlanRevision(dataset_id=plan_id, version=1, storage_key="plans/x.pdf"))
        await db.flush()
        db.add(PlanAlignment(dataset_id=plan_id, plan_version=1, page=1))
        db.add(PlanPageFloor(dataset_id=plan_id, plan_version=1, page=1, floor_index=0))
        await db.commit()

    await dr.reset()

    async with session_factory() as db:
        for table in ("objects", "plan_revisions", "plan_alignments", "plan_page_floors"):
            left = (await db.execute(text(f"select count(*) from {table}"))).scalar_one()  # noqa: S608
            assert left == 0, f"{table} survived the CLI reset"
        layers = (await db.execute(text("select id from reference_datasets"))).scalars().all()
    assert layers == ["geo:hydrant"], "the geo: reference layers are not the reset's to delete"


@pytest.mark.asyncio
async def test_reset_removes_the_media_and_snapshot_files_of_the_wiped_incidents(session_factory, monkeypatch):
    """⚠️ The cascade deleted the media and snapshot ROWS and left their files on the volume for
    ever — a nightly reset of a public demo grew without bound (23.09.2026). The files go once the
    wipe commits; the derived thumbnail and waveform go with them."""
    from app import storage
    from app.models import Incident, Media, WorkspaceSnapshot

    monkeypatch.setenv("KP_DEMO_RESET", "1")  # this is the throwaway test database
    monkeypatch.setattr(dr, "async_session_maker", session_factory)
    photo, audio, snap = "media/demo-photo.jpg", "media/demo-memo.webm", "snapshots/demo/s.json"
    files = [photo, photo + ".thumb.jpg", audio, audio + ".peaks.json", snap]
    for key in files:
        storage.put_bytes(key, b"x")
    async with session_factory() as db:
        inc = Incident(title="Besucher-Einsatz", source="manual", map_workspace_json={})
        db.add(inc)
        await db.flush()
        db.add(Media(incident_id=inc.id, kind="photo", storage_key=photo))
        db.add(Media(incident_id=inc.id, kind="audio", storage_key=audio))
        db.add(WorkspaceSnapshot(incident_id=inc.id, seq_at=0, storage_key=snap))
        await db.commit()

    await dr.reset(wipe_objects=False)

    assert [key for key in files if storage.exists(key)] == []


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


def test_seeds_the_job_each_person_is_on_the_list_for():
    """A name on a symbol writes the Anwesenheits-Bemerkung in the app (lib/roleAssignment);
    seeded data never passes through that path, so the builder has to do it — otherwise the
    demo shows an «Einsatzleiter» symbol and a roster row with nothing connecting them."""
    scene = {
        "entities": [
            {
                "id": "el",
                "symbol": "VKF Einsatzleiter",
                "label": "Einsatzleiter",
                "fields": {"Name": "Widmer Céline", "Stv.": "Hans Müller"},
            },
            {"id": "tlf", "symbol": "VKF Fahrzeug", "label": "TLF", "fields": {"Fahrer": "Anna Meier"}},
        ],
    }
    present = [("pid-1", "Widmer Céline"), ("pid-2", "Hans Müller"), ("pid-3", "Anna Meier"), ("pid-4", "Nina Frei")]
    ws = build_demo_workspace(scene, present, NOW)
    assert ws["attendance"]["pid-1"]["note"] == "Einsatzleiter"
    assert ws["attendance"]["pid-2"]["note"] == "Stv. Einsatzleiter"
    assert ws["attendance"]["pid-3"]["note"] == "Fahrer TLF"
    # somebody with no job on the board keeps a bare row — a remark nobody wrote is not a remark
    assert "note" not in ws["attendance"]["pid-4"]


def test_a_symbol_naming_somebody_absent_seeds_nothing():
    """The scene and the present list are edited independently. A remark for a person who is
    not on the Anwesenheit would be a contradiction seeded into the demo, and one nobody spots
    reading a JSON file."""
    scene = {"entities": [{"id": "el", "symbol": "VKF Einsatzleiter", "fields": {"Name": "Wer Anders"}}]}
    ws = build_demo_workspace(scene, [("pid-1", "Widmer Céline")], NOW)
    assert "note" not in ws["attendance"]["pid-1"]


def test_every_person_named_on_a_demo_symbol_is_a_seeded_roster_name():
    """Guards the DATASET: a name typed into a symbol's roster field must be spelled exactly the
    way the roster serves it.

    The scene file is hand-edited and the roster is generated, so the two can drift apart in a
    way nothing notices — «Céline Widmer» on the Einsatzleiter symbol against a Mannschaft full
    of «Widmer Céline» (fixed in b83c8ab, and still on the public demo weeks later). A mismatch
    is not cosmetic: `_scene_roles` joins the two BY NAME, so a symbol whose spelling drifts
    silently stops putting its Bemerkung on anybody's Anwesenheit row.

    Covers every roster field on every symbol (appConfig · symbols.rosterFields), not just the
    two that happen to carry a role today."""
    scene = json.loads((Path(__file__).resolve().parents[2] / "examples/demo-data/incident.workspace.json").read_text())
    roster = {dr.demo_display_name(first, last) for first, last, _rank in dr.DEMO_PEOPLE}
    named = [
        (e.get("symbol"), key, value)
        for e in scene.get("entities") or []
        for key, value in (e.get("fields") or {}).items()
        if key in {"Name", "Fahrer", "Stv."} and (value or "").strip()
    ]
    assert named, "the demo scene should name somebody on at least one symbol"
    unknown = [(sym, key, v) for sym, key, v in named if v.strip() not in roster]
    assert not unknown, f"not spelled the way the roster serves them: {unknown}"


def test_the_shipped_demo_scene_labels_its_einsatzleiter():
    """Guards the dataset, not the builder: the Einsatzleiter symbol in the demo scene must keep
    naming somebody who is seeded present, or the demo silently loses the label again."""
    scene = json.loads((Path(__file__).resolve().parents[2] / "examples/demo-data/incident.workspace.json").read_text())
    present = [(f"pid-{i}", n) for i, n in enumerate(sorted(dr.DEMO_PRESENT))]
    notes = {
        a["displayNameSnapshot"]: a["note"]
        for a in build_demo_workspace(scene, present, NOW)["attendance"].values()
        if a.get("note")
    }
    assert notes == {dr.DEMO_EINSATZLEITER: "Einsatzleiter", dr.demo_display_name("Stefan", "Graf"): "Fahrer TLF"}


def test_every_seeded_rank_exists_in_the_demo_config():
    """The Dienstgrad on a demo person is a KEY into `roster.ranks` in the demo config, and the
    two live in different files. A key with no entry behind it is invisible rather than loud: the
    Grad badge renders empty, the seniority sort files that person last, and «nur Offiziere»
    quietly does not offer them — which is exactly how the demo ran rankless for months."""
    cfg = json.loads((Path(__file__).resolve().parents[2] / "examples/demo-data/config.json").read_text())
    keys = {r["key"] for r in cfg["roster"]["ranks"]}
    seeded = {rank for _first, _last, rank in dr.DEMO_PEOPLE}
    assert seeded <= keys, f"seeded ranks missing from roster.ranks: {sorted(seeded - keys)}"
    # …and a rank nobody holds is a list entry that can never be seen on the demo
    assert keys <= seeded, f"configured ranks nobody on the demo holds: {sorted(keys - seeded)}"


def test_the_demo_has_officers_for_the_officer_filter_to_find():
    """«nur Offiziere» hides itself when no option would match (Combo · hasOfficers), so a demo
    with no officer-tier person shows a picker the real app does not have."""
    cfg = json.loads((Path(__file__).resolve().parents[2] / "examples/demo-data/config.json").read_text())
    officers = {r["key"] for r in cfg["roster"]["ranks"] if r.get("tier") == "officer"}
    held = [rank for _f, _l, rank in dr.DEMO_PEOPLE if rank in officers]
    assert len(held) >= 2, "the demo needs more than one Offizier for the filter to be worth showing"


def test_every_trupp_points_at_something_that_exists():
    """⚠️ Guards the DATASET's cross-references: a Trupp names a Leitung, a plan chip and a map
    marker by id, and all three live in a different file from the Trupp itself.

    A reference to something that is not there is silent in every direction — a `lineNo` nobody
    drew shows a Leitung tag on a card with nothing to jump to, a `lineId` pointing at a deleted
    drawing breaks «Leitung zeigen», and an `annoId` for a chip that no longer exists leaves the
    Trupp untracked on the plan. Nothing errors; the demo just quietly stops demonstrating the
    thing it is there to demonstrate.
    """
    scene = json.loads((Path(__file__).resolve().parents[2] / "examples/demo-data/incident.workspace.json").read_text())
    present = [(f"pid-{i}", n) for i, n in enumerate(sorted(dr.DEMO_PRESENT))]
    ws = build_demo_workspace(scene, present, NOW)

    lines = {d["id"]: d.get("lineNo") for d in ws.get("drawings", []) if d.get("kind") == "line"}
    drawn_numbers = {n for n in lines.values() if n is not None}
    annos = {a["id"] for anns in (ws.get("board") or {}).values() for a in anns}
    entities = {e["id"] for e in ws.get("entities", [])}

    for t in ws["trupps"]:
        if t.get("lineId") is not None:
            assert t["lineId"] in lines, f"{t['id']} works on a Leitung that is not drawn"
            # …and the NUMBER on the card is the number on that hose, not a second opinion
            assert t.get("lineNo") == lines[t["lineId"]], f"{t['id']}'s Leitung number contradicts the drawing"
        if t.get("lineNo") is not None:
            assert t["lineNo"] in drawn_numbers, f"{t['id']} carries Leitung {t['lineNo']}, which nobody drew"
        if t.get("annoId") is not None:
            assert t["annoId"] in annos, f"{t['id']} is placed on a plan chip that does not exist"
        if t.get("entityId") is not None:
            assert t["entityId"] in entities, f"{t['id']} is placed on a map marker that does not exist"

    # …and no numbered Leitung is left over with nobody on it: an orphan number on the Kroki is
    # the same confusion from the other end.
    claimed = {t.get("lineNo") for t in ws["trupps"]}
    assert drawn_numbers <= claimed, f"drawn but unclaimed Leitungen: {drawn_numbers - claimed}"


def _full_ws():
    """The builder over the shipped scene and the whole present crew — what reset() seeds."""
    scene = json.loads((Path(__file__).resolve().parents[2] / "examples/demo-data/incident.workspace.json").read_text())
    present = [(f"pid-{i}", n) for i, n in enumerate(sorted(dr.DEMO_PRESENT))]
    return build_demo_workspace(scene, present, NOW), {name: pid for pid, name in present}


def _at(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def test_the_trupps_carry_the_numbers_the_verlauf_names():
    """The load normaliser numbers an unnumbered Trupp by its first reading, and the angemeldet
    Sicherheitstrupp has none — so it became «Trupp 1» while the Verlauf says «Trupp 1
    (Müller)» and «Trupp 2 (Schmid)». The seed numbers them itself, in registration order."""
    ws, _ = _full_ws()
    assert [(t["no"], t["name"]) for t in ws["trupps"]] == [
        (1, dr.demo_display_name("Hans", "Müller")),
        (2, dr.demo_display_name("Peter", "Schmid")),
        (3, dr.demo_display_name("Marco", "Weber")),
        (4, dr.demo_display_name("Reto", "Bachmann")),
    ]
    rows = dr.demo_journal_rows(NOW)
    assert any("Trupp 1 (Müller)" in r["text"] for r in rows)
    assert any("Trupp 2 (Schmid)" in r["text"] for r in rows)


def test_the_plain_trupp_is_a_work_squad_without_a_cylinder():
    """A Trupp ohne Atemschutz carries no Eingangsdruck and no `registered` reading — a
    measurement nobody took would otherwise open its record (useTruppActions · createTrupp)."""
    ws, by_name = _full_ws()
    plain = [t for t in ws["trupps"] if t.get("kind") == "einfach"]
    assert len(plain) == 1
    t = plain[0]
    assert t["auftrag"] == "verkehr"
    assert t["entryPressureBar"] == 0
    assert {r["kind"] for r in t["readings"]} == {"crew", "entry"}
    assert all(r["bar"] == 0 for r in t["readings"])
    assert t["leaderPersonId"] == by_name[dr.demo_display_name("Reto", "Bachmann")]
    assert t["memberPersonIds"] == [by_name[dr.demo_display_name("Fabienne", "Steiner")]]
    # …and no equipment on a crew that carries none in
    assert "equipment" not in t


def test_the_trupp_equipment_is_on_the_shipped_list():
    """`Trupp.equipment` holds ids off the station's list; the demo config sets none, so it is the
    shipped default (src/config/appConfig.ts · atemschutz.equipment). An unknown id prints raw."""
    cfg = json.loads((Path(__file__).resolve().parents[2] / "examples/demo-data/config.json").read_text())
    assert not cfg.get("doctrine", {}).get("equipment"), "a station list would replace the default"
    ws, _ = _full_ws()
    pa = [t for t in ws["trupps"] if t.get("kind", "atemschutz") == "atemschutz"]
    assert all(t.get("equipment") for t in pa)
    assert {e for t in pa for e in t["equipment"]} <= {"retthaube", "wbk", "multiwarn"}


def test_the_verlauf_stays_inside_the_incident_and_in_order():
    rows = dr.demo_journal_rows(NOW)
    started = NOW - timedelta(minutes=dr.DEMO_ELAPSED_MIN)
    stamps = [_at(r["at"]) for r in rows]
    assert stamps == sorted(stamps), "the Verlauf is seeded oldest first"
    assert all(started <= t <= NOW for t in stamps)
    assert len({r["id"] for r in rows}) == len(rows)


def test_the_verlauf_shows_every_art_and_both_pendenz_states():
    """The Art discs and the Verlauf filter have one word per kind of row (lib/journalFilter);
    a demo of plain rows only showed «Manuell». Typed rows carry their tag IN the text, the way
    the composer writes them (lib/journalEntry · composeJournalText)."""
    rows = dr.demo_journal_rows(NOW)
    types = {r.get("entryType") for r in rows}
    assert {"auftrag", "sofort"} <= types
    for r in rows:
        if r.get("entryType"):
            assert r["text"].startswith(dr._ENTRY_TYPE_TAG[r["entryType"]] + " · ")

    created = {r["reminder"]["id"]: r for r in rows if r.get("reminder", {}).get("op") == "created"}
    done = {r["reminder"]["id"]: r for r in rows if r.get("reminder", {}).get("op") == "done"}
    assert done and set(done) < set(created), "one Pendenz ticked off, at least one still open"
    for pid, row in done.items():
        assert _at(row["at"]) > _at(created[pid]["at"])
        assert row["text"] == dr._PENDENZ_DONE.format(text=created[pid]["reminder"]["text"])
        assert row["kind"] == "reminder"
    # a Pendenz never carries a due time: that would make it an alarming Erinnerung
    assert not any(r.get("reminder", {}).get("dueAt") for r in rows)


def test_every_ticked_milestone_has_its_verlauf_row():
    """Guards the DATASET: the ticks name items of the demo checklist file, and every ticked
    milestone wrote its ☑ row at the minute of the tick — a ☑ in the Verlauf for an item the
    Checklisten view shows open (or the reverse) is the contradiction the seed must not ship."""
    tpl = json.loads(
        (Path(__file__).resolve().parents[2] / "examples/demo-data/checklists/musterdorf-fu.json").read_text()
    )
    assert tpl["id"] == dr.DEMO_CHECKLIST_ID
    items = {i["id"]: i for p in tpl["phases"] for i in p["items"]}
    assert set(dr.DEMO_CHECKLIST_TICKS) <= set(items)

    ws, _ = _full_ws()
    ticks = ws["checklists"][dr.DEMO_CHECKLIST_ID]["ticks"]
    assert set(ticks) == set(dr.DEMO_CHECKLIST_TICKS)
    rows = {r["text"]: r for r in dr.demo_journal_rows(NOW) if r["icon"] == "check" and r["kind"] == "journal"}
    ticked_milestones = {i for i in ticks if items[i].get("milestone")}
    assert ticked_milestones, "the demo should tick at least one milestone"
    assert set(rows) == {f"☑ {items[i]['text']}" for i in ticked_milestones}
    for i in ticked_milestones:
        assert rows[f"☑ {items[i]['text']}"]["at"] == ticks[i]["t"]
    # …and something is left to do
    assert set(items) - set(ticks)


def test_the_brandwache_is_planned_in_the_future_for_people_on_site():
    ws, by_name = _full_ws()
    bands = {b["id"]: b for b in ws["bands"]}
    assert len(bands) >= 2
    assert all(_at(b["from"]) >= NOW and _at(b["to"]) > _at(b["from"]) for b in bands.values())
    shifts = ws["shifts"]
    assert {s["personId"] for s in shifts} <= set(by_name.values())
    assert any(s["confirmed"] for s in shifts) and any(not s["confirmed"] for s in shifts)
    assert any("bandId" not in s for s in shifts), "one availability drawn freihändig"
    for s in shifts:
        assert _at(s["from"]) >= NOW
        if "bandId" in s:
            band = bands[s["bandId"]]
            assert (s["from"], s["to"]) == (band["from"], band["to"])
    # nobody on a Trupp is planned for the Brandwache — they are the ones working now
    on_trupps = {p for t in ws["trupps"] for p in [t["leaderPersonId"], *t["memberPersonIds"]]}
    assert not on_trupps & {s["personId"] for s in shifts}


def test_the_demo_report_links_are_https():
    """`report.links` opens from the Rapport; the server refuses anything but http(s) anyway,
    and a demo pointing a visitor at plain http would teach the wrong thing."""
    cfg = json.loads((Path(__file__).resolve().parents[2] / "examples/demo-data/config.json").read_text())
    links = cfg["report"]["links"]
    assert links and all(link["url"].startswith("https://") for link in links)
    assert len({link["id"] for link in links}) == len(links)

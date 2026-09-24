"""The server observes «vor Ort» / «verlassen» (app.vehicle_presence, 24.09.2026 — D2).

What the Übung of 23.09.2026 showed: GPS had the first three vehicles on scene at 19:23–19:24, the Verlauf
said 19:43 for all five — the moment a tablet woke up. What this file pins:

* the RULES are the client hook's, number for number (rings, band, settle, silent baseline);
* the STAMP is the first GPS fix in the new zone, not when anybody (the server included) noticed;
* the Verlauf gets the first arrival and the last departure, the trips between are counted;
* the record CONVERGES: a restart or a second worker writes nothing twice;
* first writer wins against the external geofence, and `manual` times are never touched;
* an older client's own presence rows are acknowledged and dropped.
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app import vehicle_presence as vp
from app.api.alarms import apply_milestones
from app.models import DeploymentConfig, Incident, IncidentEvent, JournalEntry
from app.schemas import MilestonesIn
from app.traccar import VehiclePosition

LAT, LNG = 46.9480, 7.4474
#: ~1 km east — «weg»
AWAY = (LAT, LNG + 0.0133)
#: ~200 m east — the band between the rings
BAND = (LAT, LNG + 0.00266)
T0 = datetime(2026, 9, 23, 17, 20, tzinfo=UTC)


def _pos(where: tuple[float, float], ts: datetime, *, device_id: int = 3, name: str = "TLF") -> VehiclePosition:
    return VehiclePosition(
        device_id=device_id,
        device_name=name,
        unique_id=name.lower(),
        status="online",
        latitude=where[0],
        longitude=where[1],
        last_update=ts,
    )


SCENE = (LAT, LNG)


@pytest.fixture(autouse=True)
def _clean_state():
    vp.reset_state()
    vp._last_seen.clear()
    yield
    vp.reset_state()
    vp._last_seen.clear()


# --- the pure state machine -------------------------------------------------------------


def test_the_rings_are_the_client_hooks_numbers():
    assert (vp.AT_SCENE_M, vp.LEFT_M, vp.SETTLE_S) == (150.0, 300.0, 90)
    assert vp.zone_of(150) == "scene"
    assert vp.zone_of(151) is None and vp.zone_of(299) is None
    assert vp.zone_of(300) == "away"


def test_the_first_reading_is_a_silent_baseline_and_the_band_says_nothing():
    s = vp.step(None, 220, T0, T0)
    assert s.state is None and not s.baseline  # the band starts nothing
    s = vp.step(None, 40, T0, T0)
    assert s.baseline and s.transition is None
    assert s.state is not None and s.state.zone == "scene" and s.state.fahrten == 1
    assert s.state.first_arrival is None  # nobody knows when it came


def test_a_transition_is_stamped_with_the_first_fix_in_the_new_zone():
    st = vp.step(None, 1000, T0, T0).state
    first = T0 + timedelta(seconds=30)
    st = vp.step(st, 40, first, first + timedelta(seconds=5)).state
    # 60 s of fix time — not settled
    s = vp.step(st, 30, first + timedelta(seconds=60), first + timedelta(seconds=65))
    assert s.transition is None
    # 90 s of fix time — settled, stamped with the FIRST fix, not with this one
    s = vp.step(s.state, 30, first + timedelta(seconds=90), first + timedelta(seconds=95))
    assert s.transition == "scene"
    assert s.state is not None
    assert s.state.first_arrival == first and s.state.n == 1 and s.state.fahrten == 1


def test_a_tracker_that_stops_reporting_still_settles_on_the_servers_clock():
    """Traccar re-serves a parked tracker's last fix forever; the fix time never advances."""
    st = vp.step(None, 1000, T0, T0).state
    fix = T0 + timedelta(seconds=30)
    st = vp.step(st, 40, fix, fix).state
    s = vp.step(st, 40, fix, fix + timedelta(seconds=91))
    assert s.transition == "scene" and s.state is not None and s.state.first_arrival == fix


def test_the_band_interrupts_a_settle():
    st = vp.step(None, 1000, T0, T0).state
    st = vp.step(st, 40, T0 + timedelta(seconds=10), T0 + timedelta(seconds=10)).state
    st = vp.step(st, 220, T0 + timedelta(seconds=60), T0 + timedelta(seconds=60)).state  # scatter
    s = vp.step(st, 40, T0 + timedelta(seconds=100), T0 + timedelta(seconds=100))
    assert s.transition is None  # a fresh settle starts here
    assert s.state is not None and s.state.pending_fix == T0 + timedelta(seconds=100)


def _drive(st, zones_and_times):
    """Settle into each zone at each time (first fix = the given time)."""
    transitions = []
    for zone, t in zones_and_times:
        d = 20 if zone == "scene" else 1000
        st = vp.step(st, d, t, t).state
        s = vp.step(st, d, t + timedelta(seconds=90), t + timedelta(seconds=90))
        transitions.append(s.transition)
        st = s.state
    return st, transitions


def test_a_shuttle_is_counted_and_keeps_its_first_arrival_and_last_departure():
    st = vp.step(None, 1000, T0, T0).state
    st, tr = _drive(
        st,
        [
            ("scene", T0 + timedelta(minutes=8)),  # 19:28 in the Übung
            ("away", T0 + timedelta(minutes=20)),
            ("scene", T0 + timedelta(minutes=30)),
            ("away", T0 + timedelta(minutes=40)),
            ("scene", T0 + timedelta(minutes=50)),
            ("away", T0 + timedelta(minutes=77)),
        ],
    )
    assert tr == ["scene", "away", "scene", "away", "scene", "away"]
    assert st.fahrten == 3 and st.n == 6
    assert st.first_arrival == T0 + timedelta(minutes=8)
    assert st.last_departure == T0 + timedelta(minutes=77)
    assert st.departure_owed == T0 + timedelta(minutes=77)  # only the LAST one is owed


def test_a_departure_is_owed_until_the_vehicle_stayed_away_or_the_einsatz_ends():
    st = vp.step(None, 20, T0, T0).state
    st, _ = _drive(st, [("away", T0 + timedelta(minutes=5))])
    assert not vp.departure_due(st, T0 + timedelta(minutes=10))
    assert vp.departure_due(st, T0 + timedelta(minutes=10), closing=True)
    assert vp.departure_due(st, T0 + timedelta(minutes=5, seconds=vp.FINAL_AWAY_S))
    # …and a vehicle that came back owes nothing: that departure was a trip
    st, _ = _drive(st, [("scene", T0 + timedelta(minutes=15))])
    assert st.departure_owed is None


def test_a_vehicle_already_on_scene_at_the_opening_has_no_arrival_time():
    st = vp.step(None, 20, T0, T0).state
    st, _ = _drive(st, [("away", T0 + timedelta(minutes=5)), ("scene", T0 + timedelta(minutes=15))])
    assert st.first_arrival is None and st.fahrten == 2


# --- the blob: first writer wins, manual never touched ---------------------------------


def _presence(**kw) -> vp.Presence:
    base = {"zone": "scene", "n": 1, "fahrten": 1, "first_arrival": T0}
    base.update(kw)
    return vp.Presence(**base)  # type: ignore[arg-type]


def test_the_server_stamps_vor_ort_when_nobody_did():
    ws, changed, ours = vp.apply_gps_presence(None, "tlf", _presence())
    row = ws["reportMeta"]["fahrzeuge"][0]
    assert changed and ours
    assert row["vorOrt"] == T0.isoformat()
    assert row["gps"] == {"zone": "scene", "fahrten": 1, "an": T0.isoformat(), "owns": ["vorOrt"]}


def test_the_external_geofence_was_first_so_its_vor_ort_stands():
    ext = "2026-09-23T17:23:00+00:00"
    ws = {"reportMeta": {"fahrzeuge": [{"id": "tlf", "vorOrt": ext}]}}
    ws, _, ours = vp.apply_gps_presence(ws, "tlf", _presence())
    row = ws["reportMeta"]["fahrzeuge"][0]
    assert row["vorOrt"] == ext and not ours
    assert "owns" not in row["gps"]


def test_the_server_was_first_so_the_webhook_does_not_overwrite_it():
    ws, _, _ = vp.apply_gps_presence(None, "tlf", _presence())
    late = MilestonesIn(divera_id=1, vehicles=[{"id": "tlf", "vorOrt": "2026-09-23T17:43:00Z"}])
    ws2, changed, journal = apply_milestones(ws, late, {}, {"tlf": "TLF"})
    assert ws2["reportMeta"]["fahrzeuge"][0]["vorOrt"] == T0.isoformat()
    assert changed == 0 and journal == []


def test_a_manual_row_keeps_its_times_but_the_table_still_learns():
    ws = {"reportMeta": {"fahrzeuge": [{"id": "tlf", "vorOrt": "2026-09-23T17:30:00+00:00", "manual": True}]}}
    ws, changed, ours = vp.apply_gps_presence(ws, "tlf", _presence(zone="away", n=2, last_departure=T0))
    row = ws["reportMeta"]["fahrzeuge"][0]
    assert row["vorOrt"] == "2026-09-23T17:30:00+00:00" and "zurueck" not in row
    assert changed and row["gps"]["zone"] == "away" and ours  # a person's time: the row is still ours


def test_the_last_departure_moves_with_the_shuttle_while_it_is_the_servers():
    ws, _, _ = vp.apply_gps_presence(None, "mtf", _presence(zone="away", n=2, last_departure=T0))
    later = T0 + timedelta(minutes=30)
    ws, _, _ = vp.apply_gps_presence(ws, "mtf", _presence(zone="away", n=4, fahrten=2, last_departure=later))
    row = ws["reportMeta"]["fahrzeuge"][0]
    assert row["zurueck"] == later.isoformat() and row["gps"]["fahrten"] == 2


# --- the tick, against the database ------------------------------------------------------


@pytest.fixture
async def incident(db_session):
    db_session.add(DeploymentConfig(id=1, config_json={"fleet": {"vehicles": [{"id": "tlf", "label": "TLF"}]}}))
    inc = Incident(
        title="Übung Musterstrasse",
        source="manual",
        status="offen",
        is_exercise=True,  # Übungen are observed too
        lat=LAT,
        lng=LNG,
        started_at=datetime.now(UTC) - timedelta(minutes=30),
    )
    db_session.add(inc)
    await db_session.commit()
    await db_session.refresh(inc)
    return inc


async def _tick(db, where, fix: datetime, now: datetime | None = None, **kw) -> int:
    n = await vp.observe(db, [_pos(where, fix, **kw)], now or fix)
    await db.commit()
    return n


async def _settle(db, where, first: datetime, **kw) -> None:
    for s in (0, 30, 60, 90):
        await _tick(db, where, first + timedelta(seconds=s), **kw)


async def _rows(db, incident) -> list[dict]:
    return [
        r.row_json
        for r in (
            await db.execute(
                select(JournalEntry).where(JournalEntry.incident_id == incident.id).order_by(JournalEntry.seq)
            )
        ).scalars()
    ]


async def _events(db, incident) -> list[IncidentEvent]:
    return list(
        (
            await db.execute(
                select(IncidentEvent)
                .where(IncidentEvent.incident_id == incident.id, IncidentEvent.op_type == vp.OP_TYPE)
                .order_by(IncidentEvent.seq)
            )
        ).scalars()
    )


async def test_an_arrival_reaches_the_verlauf_and_the_rapport_with_the_fix_time(db_session, incident):
    now = datetime.now(UTC)
    await _tick(db_session, AWAY, now - timedelta(minutes=10))
    arrived = now - timedelta(minutes=8)
    await _settle(db_session, SCENE, arrived)

    rows = await _rows(db_session, incident)
    assert [(r["id"], r["text"], r["at"]) for r in rows] == [("vp-1-scene-gps-3", "TLF vor Ort", arrived.isoformat())]
    assert rows[0]["entityId"] == "gps-3"
    events = await _events(db_session, incident)
    assert [e.client_id for e in events] == ["vp:3:0", "vp:3:1"]
    assert events[1].occurred_at.replace(tzinfo=UTC) == arrived
    await db_session.refresh(incident)
    row = incident.map_workspace_json["reportMeta"]["fahrzeuge"][0]
    assert row["id"] == "tlf" and row["vorOrt"] == arrived.isoformat() and row["gps"]["zone"] == "scene"


async def test_a_vehicle_that_never_came_has_no_line_in_the_table(db_session, incident):
    """Every station vehicle starts «away» from every open Einsatz — the second, unrelated one
    too. Only a vehicle that has been on scene gets a row (found on the live check, 24.09.2026)."""
    now = datetime.now(UTC)
    await _tick(db_session, AWAY, now - timedelta(minutes=2))
    await _tick(db_session, AWAY, now)
    await db_session.refresh(incident)
    assert not (incident.map_workspace_json or {}).get("reportMeta")
    assert [e.client_id for e in await _events(db_session, incident)] == ["vp:3:0"]  # the baseline is recorded


async def test_the_trips_between_are_counted_not_written(db_session, incident):
    now = datetime.now(UTC)
    t = now - timedelta(hours=2)
    await _tick(db_session, AWAY, t)
    await _settle(db_session, SCENE, t + timedelta(minutes=5))
    await _settle(db_session, AWAY, t + timedelta(minutes=15))
    await _settle(db_session, SCENE, t + timedelta(minutes=25))
    last = t + timedelta(minutes=35)
    await _settle(db_session, AWAY, last)
    # still owed: the vehicle has been gone for less than FINAL_AWAY_S
    assert [r["id"] for r in await _rows(db_session, incident)] == ["vp-1-scene-gps-3"]
    # …and once it stayed away, the LAST departure is written, stamped when it left
    await _tick(db_session, AWAY, last + timedelta(seconds=vp.FINAL_AWAY_S + 60))
    rows = await _rows(db_session, incident)
    assert [r["id"] for r in rows] == ["vp-1-scene-gps-3", "vp-4-away-gps-3"]
    assert rows[1]["at"] == last.isoformat() and rows[1]["text"] == "TLF hat den Einsatzort verlassen"
    await db_session.refresh(incident)
    gps = incident.map_workspace_json["reportMeta"]["fahrzeuge"][0]["gps"]
    assert gps["fahrten"] == 2 and gps["ab"] == last.isoformat()


async def test_a_restart_rebuilds_from_the_record_and_writes_nothing_twice(db_session, incident):
    now = datetime.now(UTC)
    await _tick(db_session, AWAY, now - timedelta(minutes=10))
    await _settle(db_session, SCENE, now - timedelta(minutes=8))
    before = (len(await _rows(db_session, incident)), len(await _events(db_session, incident)))

    vp.reset_state()  # the deploy
    await _tick(db_session, SCENE, now - timedelta(minutes=1))
    await _tick(db_session, SCENE, now)
    assert (len(await _rows(db_session, incident)), len(await _events(db_session, incident))) == before
    # and the rebuilt state carries on counting from where the record stood
    state = vp._state[(str(incident.id), 3)]
    assert state is not None and state.zone == "scene" and state.n == 1


async def test_a_departure_owed_across_a_restart_is_still_written_once(db_session, incident):
    now = datetime.now(UTC)
    t = now - timedelta(hours=1)
    await _tick(db_session, SCENE, t)
    await _settle(db_session, AWAY, t + timedelta(minutes=5))
    vp.reset_state()
    await _tick(db_session, AWAY, now)  # rebuilt, and 55 min away: due
    vp.reset_state()
    await _tick(db_session, AWAY, now + timedelta(seconds=30))  # rebuilt again: already written
    assert [r["id"] for r in await _rows(db_session, incident)] == ["vp-1-away-gps-3"]


async def test_closing_the_einsatz_writes_the_owed_departure(db_session, incident):
    now = datetime.now(UTC)
    await _tick(db_session, SCENE, now - timedelta(minutes=10))
    left = now - timedelta(minutes=5)
    await _settle(db_session, AWAY, left)
    assert await _rows(db_session, incident) == []
    incident.status = "abgeschlossen"
    incident.is_archived = True
    await db_session.commit()
    await vp.observe(db_session, [], now)
    await db_session.commit()
    rows = await _rows(db_session, incident)
    assert [(r["id"], r["at"]) for r in rows] == [("vp-1-away-gps-3", left.isoformat())]


async def test_the_external_geofence_first_means_no_second_vor_ort_row(db_session, incident):
    incident.map_workspace_json = {"reportMeta": {"fahrzeuge": [{"id": "tlf", "vorOrt": "2026-09-23T17:23:00+00:00"}]}}
    await db_session.commit()
    now = datetime.now(UTC)
    await _tick(db_session, AWAY, now - timedelta(minutes=10))
    await _settle(db_session, SCENE, now - timedelta(minutes=8))
    assert await _rows(db_session, incident) == []  # the webhook's «TLF vor Ort 19:23» is the row
    await db_session.refresh(incident)
    assert incident.map_workspace_json["reportMeta"]["fahrzeuge"][0]["vorOrt"] == "2026-09-23T17:23:00+00:00"


async def test_a_tracker_that_is_not_a_station_vehicle_gets_rows_but_no_rapport_line(db_session, incident):
    now = datetime.now(UTC)
    await _tick(db_session, AWAY, now - timedelta(minutes=10), device_id=9, name="Privat")
    await _settle(db_session, SCENE, now - timedelta(minutes=8), device_id=9, name="Privat")
    assert [r["text"] for r in await _rows(db_session, incident)] == ["Privat vor Ort"]
    await db_session.refresh(incident)
    assert not (incident.map_workspace_json or {}).get("reportMeta")


@pytest.mark.parametrize(
    "change",
    [
        {"lat": 0.0, "lng": 0.0},  # Divera's «no location»
        {"lat": None, "lng": None},
        {"started_at": datetime.now(UTC) - timedelta(hours=25)},
        {"status": "abgeschlossen"},
    ],
)
async def test_only_an_active_einsatz_is_observed(db_session, incident, change):
    for k, v in change.items():
        setattr(incident, k, v)
    await db_session.commit()
    assert await vp.active_incidents(db_session, datetime.now(UTC)) == []
    assert await _tick(db_session, SCENE, datetime.now(UTC)) == 0


# --- the fake fleet reaches the sweep ------------------------------------------------------


async def test_the_fake_fleet_is_what_the_sweep_reads(db_session, incident, monkeypatch):
    """The known gap of the design: `/api/traccar/fake` only ever reached the map."""
    from app import scheduler, traccar
    from app.config import settings

    class _Ctx:
        async def __aenter__(self):
            return db_session

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(settings, "traccar_fake", True)
    monkeypatch.setattr(scheduler, "async_session_maker", lambda: _Ctx())
    monkeypatch.setattr(traccar, "fake_positions", [_pos(SCENE, datetime.now(UTC))])
    scheduler._last_sample.clear()
    await scheduler._vehicle_samples_sweep()
    assert [e.client_id for e in await _events(db_session, incident)] == ["vp:3:0"]


# --- an older client's own rows ------------------------------------------------------------


async def test_an_older_clients_presence_rows_are_acknowledged_and_dropped(client, editor):
    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert r.status_code == 200
    inc = (await client.post("/api/incidents", json={"title": "Mixed"})).json()["id"]
    rows = [
        {"id": "vp-1-scene-gps-3", "t": "19:43", "icon": "truck", "text": "TLF vor Ort"},
        {"id": "t1", "t": "19:44", "icon": "flag", "text": "Lage erkundet"},
    ]
    r = await client.post(f"/api/incidents/{inc}/journal", json={"entries": rows})
    assert r.status_code == 201
    assert [e["row"]["id"] for e in r.json()["entries"]] == ["t1"]
    page = (await client.get(f"/api/incidents/{inc}/journal")).json()
    assert [e["row"]["id"] for e in page["entries"]] == ["t1"]

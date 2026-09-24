"""The server observes the weather and the wind shift (app.observations, 24.09.2026 — D2).

Every device used to emit `weather.observe` per reading (×1–5 in the Übung of 23.09.2026) and
none did while every screen slept. Pinned here: ONE event per reading under
`wx:<incident>:<observed_at>` in the shape the replay reads; the wind-shift rule (≥ 45° at
≥ 10 km/h, held over two observations) and its ONE deterministic Verlauf row; and that an older
client's own `weather.observe` is acknowledged and dropped.
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app import observations as obs
from app.models import Incident, IncidentEvent, JournalEntry
from app.weather import WeatherData


def _r(at: str, deg: float | None, kmh: float | None = 15) -> obs.Reading:
    return obs.Reading(observed_at=at, dir_deg=deg, speed_kmh=kmh)


def test_the_row_reads_like_the_design():
    s = obs.Shift(from_deg=286, to_deg=66, observed_at="2026-09-23T19:40:00+00:00")
    assert s.text() == "Wind dreht: W → NO (286° → 66°) · Lüfter prüfen"


def test_a_turn_held_over_two_observations_is_one_shift():
    shifts = obs.wind_shifts([_r("a", 286), _r("b", 60), _r("c", 66), _r("d", 70), _r("e", 64)])
    assert [(s.from_deg, s.to_deg, s.observed_at) for s in shifts] == [(286, 66, "c")]


def test_a_single_gust_from_elsewhere_is_not_a_shift():
    assert obs.wind_shifts([_r("a", 270), _r("b", 90), _r("c", 275), _r("d", 268)]) == []


def test_a_calm_wind_has_no_direction_worth_reporting():
    assert obs.wind_shifts([_r("a", 270), _r("b", 90, kmh=4), _r("c", 90, kmh=6)]) == []
    # …and calm between the two readings of a turn breaks the hold
    assert obs.wind_shifts([_r("a", 270), _r("b", 90), _r("c", 90, kmh=3), _r("d", 90)]) == []


def test_a_slow_veer_reports_once_it_has_turned_far_enough():
    shifts = obs.wind_shifts([_r("a", 270), _r("b", 300), _r("c", 330), _r("d", 350)])
    assert [(s.from_deg, s.to_deg) for s in shifts] == [(270, 350)]


def test_a_turn_under_45_degrees_is_the_same_wind():
    assert obs.wind_shifts([_r("a", 10), _r("b", 50), _r("c", 54)]) == []
    assert obs.turn(350, 20) == 30 and obs.turn(286, 66) == 140


# --- the tick ----------------------------------------------------------------------------


class _Weather:
    is_configured = True

    def __init__(self):
        self.readings: list[WeatherData] = []
        self.calls = 0

    async def get_weather(self, lat, lng):
        self.calls += 1
        return self.readings[-1] if self.readings else None


@pytest.fixture
def weather(monkeypatch):
    import app.weather as weather_mod

    w = _Weather()
    monkeypatch.setattr(weather_mod, "weather_client", w)
    return w


def _wx(at: datetime, deg: float, kmh: float = 18) -> WeatherData:
    return WeatherData(wind_dir_deg=deg, wind_speed_kmh=kmh, observed_at=at.isoformat(), source="meteoswiss")


@pytest.fixture
async def incident(db_session):
    inc = Incident(
        title="Feueralarm",
        source="manual",
        status="offen",
        lat=47.5163,
        lng=7.5617,
        started_at=datetime.now(UTC) - timedelta(hours=1),
    )
    db_session.add(inc)
    await db_session.commit()
    await db_session.refresh(inc)
    return inc


async def _events(db, inc):
    return list(
        (
            await db.execute(
                select(IncidentEvent)
                .where(IncidentEvent.incident_id == inc.id, IncidentEvent.op_type == "weather.observe")
                .order_by(IncidentEvent.seq)
            )
        ).scalars()
    )


async def test_one_event_per_reading_in_the_shape_the_replay_reads(db_session, incident, weather):
    t = datetime(2026, 9, 23, 17, 20, tzinfo=UTC)
    weather.readings.append(_wx(t, 286))
    now = datetime.now(UTC)
    assert await obs.observe_weather(db_session, now) == 1
    # the provider has not published a new reading — the same id, nothing written
    assert await obs.observe_weather(db_session, now + timedelta(minutes=10)) == 0
    await db_session.commit()
    [ev] = await _events(db_session, incident)
    assert ev.client_id == f"wx:{incident.id}:{t.isoformat()}"
    assert ev.source == "weather" and ev.user_id is None
    assert ev.payload_json["weather"]["wind_dir_deg"] == 286
    assert ev.payload_json["weather"]["observed_at"] == t.isoformat()


async def test_a_wind_shift_writes_one_row_and_the_readings_after_it_none(db_session, incident, weather):
    t = datetime(2026, 9, 23, 17, 20, tzinfo=UTC)
    now = datetime.now(UTC)
    for i, deg in enumerate((286, 60, 66, 70)):
        weather.readings.append(_wx(t + timedelta(minutes=10 * i), deg))
        await obs.observe_weather(db_session, now + timedelta(minutes=10 * i))
    await db_session.commit()
    rows = [
        r.row_json
        for r in (
            await db_session.execute(select(JournalEntry).where(JournalEntry.incident_id == incident.id))
        ).scalars()
    ]
    confirm = t + timedelta(minutes=20)
    assert rows == [
        {
            "id": "wxd-202609231740",
            "t": "",
            "at": confirm.isoformat(),
            "icon": "wind",
            "text": "Wind dreht: W → NO (286° → 66°) · Lüfter prüfen",
        }
    ]


async def test_nothing_is_observed_without_an_active_einsatz(db_session, incident, weather):
    incident.lat, incident.lng = 0, 0
    await db_session.commit()
    weather.readings.append(_wx(datetime.now(UTC), 90))
    assert await obs.observe_weather(db_session, datetime.now(UTC)) == 0
    assert weather.calls == 0


async def test_an_older_clients_weather_event_is_acknowledged_and_dropped(client, editor, db_session):
    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert r.status_code == 200
    inc = (await client.post("/api/incidents", json={"title": "Mixed"})).json()["id"]
    r = await client.post(
        f"/api/incidents/{inc}/events",
        json={
            "events": [
                {"client_id": "c1", "op_type": "weather.observe", "payload": {"weather": {"wind_dir_deg": 90}}},
                {"client_id": "c2", "op_type": "layer.toggle", "payload": {"id": "hydranten"}},
            ]
        },
    )
    assert r.status_code == 201
    assert [e["op_type"] for e in r.json()] == ["layer.toggle"]
    ops = (await client.get(f"/api/incidents/{inc}/events")).json()
    assert "weather.observe" not in [e["op_type"] for e in ops]

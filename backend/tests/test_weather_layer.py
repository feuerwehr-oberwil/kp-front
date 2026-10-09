"""Weather layer: radar conversion, warning selection, staleness and failure isolation.

Ported from kp-rueck (R5, feuerwehr-oberwil/kp-rueck#167) with the same fixtures, so the two apps
are pinned to the same picture of the same rain. KP Front differences: warnings are selected per
request for a point (the Einsatz), not for a station at poll time; the jobs run per process.

Fixtures in `fixtures/weather/` are real payloads fetched 08.10.2026, trimmed:
- `rzc262811700vl.001.h5` – MeteoSwiss RZC precipitation radar, 17:00 UTC (CC BY 4.0,
  «Quelle: MeteoSchweiz»). Oberwil was dry; central/eastern Switzerland was not.
- `meteoalarm_switzerland.json` – two entries of the MeteoAlarm CH feed: a yellow «Starker Regen»
  for Luzern-Alpnach and a green (= lifted) update.
- `alertswiss_{de,fr}.json` – the BL fire-danger alert (covers Oberwil), a Uri alert and the
  technical test message.

Nothing here touches the network: the pollers get an httpx MockTransport.
"""

import io
import json
import logging
import math
import pathlib
from datetime import UTC, datetime, timedelta

import httpx
import numpy as np
import pytest
from PIL import Image

from app import weather_radar as radar
from app import weather_warnings as warnings
from app.geo_util import lv95_to_wgs84, point_in_ring
from app.weather_layer import (
    ALERTSWISS_JSON,
    METEOALARM_ATOM,
    METEOALARM_JSON,
    RADAR_STALE_AFTER,
    WARNINGS_STALE_AFTER,
    WeatherService,
)
from app.weather_radar import lat_to_mercator_y, lon_to_mercator_x, wgs84_to_lv95

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "weather"
RZC = FIXTURES / "rzc262811700vl.001.h5"
OBERWIL = (47.514, 7.556)
# Inside the Luzern-Alpnach warning polygon of the MeteoAlarm fixture.
ALPNACH = (46.9907, 8.3158)
FIXTURE_FRAME_TIME = datetime(2026, 10, 8, 17, 0, tzinfo=UTC)


def _json(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture(scope="module")
def grid() -> radar.RadarGrid:
    return radar.parse_rzc(RZC.read_bytes())


@pytest.fixture(scope="module")
def frame(grid: radar.RadarGrid) -> radar.RenderedFrame:
    return radar.render_frame(grid)


# --- Projection & conversion -------------------------------------------------------------------


def test_lv95_approximation_round_trips_at_oberwil():
    east, north = wgs84_to_lv95(np.array([OBERWIL[0]]), np.array([OBERWIL[1]]))
    # Research reference: Oberwil BL = LV95 2'608'842 / 1'262'591.
    assert abs(east[0] - 2608842) < 2 and abs(north[0] - 1262591) < 2
    lat, lon = lv95_to_wgs84(float(east[0]), float(north[0]))
    # The inverse formula is swisstopo's «~1 m» one too: 3e-5° is about 2 m.
    assert abs(lat - OBERWIL[0]) < 3e-5 and abs(lon - OBERWIL[1]) < 3e-5


def test_parse_recovers_the_lv95_grid_from_the_files_corners(grid: radar.RadarGrid):
    assert grid.time == FIXTURE_FRAME_TIME
    assert grid.values.shape == (640, 710)
    assert (grid.east0, grid.north0) == (2255000.0, 1480000.0)
    # Every stated corner projects onto the grid's edge, to well under a cell, even 300 km
    # outside Switzerland where the approximation is weakest.
    edges = {
        "UL": (2255000, 1480000),
        "UR": (2965000, 1480000),
        "LL": (2255000, 840000),
        "LR": (2965000, 840000),
    }
    for corner, (lat, lon) in grid.corners.items():
        east, north = wgs84_to_lv95(np.array([lat]), np.array([lon]))
        assert abs(east[0] - edges[corner][0]) < 25, corner
        assert abs(north[0] - edges[corner][1]) < 25, corner


def test_rendered_bounds_are_a_mercator_rectangle_around_the_domain(frame: radar.RenderedFrame, grid):
    (tl, tr, br, bl) = frame.coordinates
    assert tl[1] == tr[1] and bl[1] == br[1]  # north and south edges are parallels
    assert tl[0] == bl[0] and tr[0] == br[0]  # west and east edges are meridians
    lats = [c[0] for c in grid.corners.values()]
    lons = [c[1] for c in grid.corners.values()]
    assert tl[0] <= min(lons) and tr[0] >= max(lons)
    assert tl[1] >= max(lats) and bl[1] <= min(lats)
    # …and only just: no more than one output pixel of slack on any side.
    assert tr[0] - max(lons) < 0.02 and min(lats) - bl[1] < 0.02


def _pixel_of(frame: radar.RenderedFrame, size: tuple[int, int], lat: float, lon: float) -> tuple[int, int]:
    (west, north), (east, _), (_, south), _ = frame.coordinates
    width, height = size
    x = (lon_to_mercator_x(lon) - lon_to_mercator_x(west)) / (lon_to_mercator_x(east) - lon_to_mercator_x(west))
    y = (lat_to_mercator_y(north) - lat_to_mercator_y(lat)) / (lat_to_mercator_y(north) - lat_to_mercator_y(south))
    return math.floor(x * width), math.floor(y * height)


def test_each_radar_cell_lands_where_it_is_on_the_map(grid: radar.RadarGrid, frame: radar.RenderedFrame):
    """End to end: take wet LV95 cells, find their centre's lat/lon independently, and check the
    PNG pixel there has that cell's colour class. A projection or orientation error (flipped
    rows, a 4-corner shortcut) fails this by kilometres."""
    image = Image.open(io.BytesIO(frame.png))
    assert image.mode == "P"
    pixels = np.asarray(image)
    thresholds = np.array([step for step, _, _ in radar.PRECIP_RAMP])
    rows, cols = np.nonzero(np.nan_to_num(grid.values) >= 2.0)
    rng = np.random.default_rng(7)
    picks = rng.choice(len(rows), size=300, replace=False)
    hits = 0
    for i in picks:
        row, col = int(rows[i]), int(cols[i])
        lat, lon = lv95_to_wgs84(grid.east0 + (col + 0.5) * grid.xscale, grid.north0 - (row + 0.5) * grid.yscale)
        x, y = _pixel_of(frame, image.size, lat, lon)
        expected = int(np.digitize(grid.values[row, col], thresholds))
        hits += int(pixels[y, x] == expected)
    assert hits / len(picks) > 0.97


def test_dry_and_no_data_are_transparent(grid: radar.RadarGrid, frame: radar.RenderedFrame):
    image = Image.open(io.BytesIO(frame.png)).convert("RGBA")
    assert radar.value_at(grid, *OBERWIL) == 0.0  # dry at 17:00
    x, y = _pixel_of(frame, image.size, *OBERWIL)
    assert image.getpixel((x, y))[3] == 0
    # Outside the radar domain altogether (the Bay of Biscay corner of the output rectangle).
    assert image.getpixel((0, image.size[1] - 1))[3] == 0
    # …and a heavy-rain cell is opaque-ish.
    rows, cols = np.nonzero(np.nan_to_num(grid.values) >= 10.0)
    lat, lon = lv95_to_wgs84(grid.east0 + (cols[0] + 0.5) * 1000, grid.north0 - (rows[0] + 0.5) * 1000)
    assert image.getpixel(_pixel_of(frame, image.size, lat, lon))[3] > 200


def test_parse_rejects_what_is_not_a_radar_file():
    with pytest.raises(ValueError):
        radar.parse_rzc(b"<html>503</html>")


def test_frame_url_follows_the_published_naming():
    assert radar.frame_url(FIXTURE_FRAME_TIME) == (
        "https://data.geo.admin.ch/ch.meteoschweiz.ogd-radar-precip/20261008-ch/rzc262811700vl.001.h5"
    )
    # Day folder and day-of-year are UTC: 23:55 UTC on 31.12. is still the old year.
    late = datetime(2026, 12, 31, 23, 55, tzinfo=UTC)
    assert radar.frame_url(late).endswith("/20261231-ch/rzc263652355vl.001.h5")


# --- Warnings ------------------------------------------------------------------------------------

NOW = datetime(2026, 10, 8, 17, 30, tzinfo=UTC)


def test_meteoalarm_drops_green_lifted_updates_and_keeps_text_verbatim():
    payload = _json("meteoalarm_switzerland.json")
    candidates = warnings.meteoalarm_candidates(payload)
    assert len(candidates) == 1  # the «1; green» update is not a warning
    (warning,) = candidates
    assert warning["level"] == 2 and warning["color"] == "yellow" and warning["kind"] == "rain"
    de = next(i for i in payload["warnings"][0]["alert"]["info"] if i["language"] == "de")
    assert warning["texts"]["de"] == {
        "event": de["event"],
        "headline": de["headline"],
        "description": de["description"],
        "instructions": [de["instruction"]],
    }
    assert set(warning["texts"]) == {"de", "fr", "it", "en"}


def test_warning_filter_by_region():
    meteo = warnings.meteoalarm_candidates(_json("meteoalarm_switzerland.json"))
    swiss = warnings.alertswiss_candidates({"de": _json("alertswiss_de.json"), "fr": _json("alertswiss_fr.json")})
    # Alpnach lies in the yellow-rain region; Oberwil does not.
    (at_alpnach,) = warnings.select(meteo, *ALPNACH, NOW)
    assert at_alpnach["region"] == "Luzern-Alpnach"
    assert "areas" not in at_alpnach  # polygons stay on the server
    assert warnings.select(meteo, *OBERWIL, NOW) == []
    # Oberwil gets the BL fire-danger alert – not Uri's, and never the technical test message.
    (at_oberwil,) = warnings.select(swiss, *OBERWIL, NOW)
    assert at_oberwil["region"] == "Ganzer Kanton Basel-Landschaft"
    assert at_oberwil["sender"] == "Kanton Basel-Landschaft"
    assert set(at_oberwil["texts"]) == {"de", "fr"}
    assert at_oberwil["expires"] is None  # «bis auf Widerruf»
    assert not any("TEST" in c["id"] for c in swiss)


def test_expired_warnings_are_not_shown():
    meteo = warnings.meteoalarm_candidates(_json("meteoalarm_switzerland.json"))
    after = datetime(2026, 10, 9, 6, 0, tzinfo=UTC)  # the fixture's `expires`
    assert warnings.select(meteo, *ALPNACH, after) == []


def test_point_in_ring_handles_concave_rings():
    # A «C» opening east: the notch is outside.
    ring = [(0, 0), (0, 3), (1, 3), (1, 1), (2, 1), (2, 3), (3, 3), (3, 0)]
    assert point_in_ring(0.5, 2, ring)
    assert not point_in_ring(1.5, 2, ring)


# --- Pollers: isolation & staleness ---------------------------------------------------------------


def _router(routes: dict[str, httpx.Response | Exception], default: int = 404):
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        for prefix, answer in routes.items():
            if url.startswith(prefix):
                if isinstance(answer, Exception):
                    raise answer
                return answer
        return httpx.Response(default)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _warning_routes(meteo_status: int = 200, swiss_status: int = 200) -> dict:
    return {
        METEOALARM_ATOM: httpx.Response(meteo_status, content=b"<feed/>"),
        METEOALARM_JSON: httpx.Response(meteo_status, json=_json("meteoalarm_switzerland.json")),
        ALERTSWISS_JSON.format(lang="de"): httpx.Response(swiss_status, json=_json("alertswiss_de.json")),
        ALERTSWISS_JSON.format(lang="fr"): httpx.Response(swiss_status, json=_json("alertswiss_fr.json")),
    }


async def test_radar_poll_fetches_published_frames_and_skips_missing_ones():
    service = WeatherService()
    now = FIXTURE_FRAME_TIME + timedelta(minutes=6)  # 17:06 → slots 17:05 (not yet there) … 16:10
    async with _router({radar.frame_url(FIXTURE_FRAME_TIME): httpx.Response(200, content=RZC.read_bytes())}) as c:
        await service.poll_radar(client=c, now=now)
    snapshot = service.snapshot(*OBERWIL, now)
    assert [f["key"] for f in snapshot["radar"]["frames"]] == ["202610081700"]
    assert snapshot["radar"]["status"]["last_error"] is None
    assert snapshot["radar"]["stale"] is False
    assert service.frame_png("202610081700").startswith(b"\x89PNG")
    # Slots older than the give-up window that 404'd are not asked for again.
    assert radar.frame_key(FIXTURE_FRAME_TIME - timedelta(minutes=30)) in service.state.radar_given_up
    assert radar.frame_key(FIXTURE_FRAME_TIME + timedelta(minutes=5)) not in service.state.radar_given_up


async def test_radar_failure_keeps_last_frames_and_marks_them_stale_later():
    service = WeatherService()
    now = FIXTURE_FRAME_TIME + timedelta(minutes=2)
    async with _router({radar.frame_url(FIXTURE_FRAME_TIME): httpx.Response(200, content=RZC.read_bytes())}) as c:
        await service.poll_radar(client=c, now=now)
    later = FIXTURE_FRAME_TIME + RADAR_STALE_AFTER + timedelta(minutes=1)
    async with _router({"https://": httpx.ConnectError("down")}) as c:
        await service.poll_radar(client=c, now=later)  # must not raise
    snapshot = service.snapshot(*OBERWIL, later)
    assert snapshot["radar"]["status"]["last_error"] == "nicht erreichbar"
    assert snapshot["radar"]["data_time"] == FIXTURE_FRAME_TIME.isoformat()
    assert len(snapshot["radar"]["frames"]) == 1  # last-known data kept…
    assert snapshot["radar"]["stale"] is True  # …but never passed off as current


async def test_one_failing_source_never_empties_another():
    service = WeatherService()
    # Radar down entirely, MeteoAlarm answering 500, Alertswiss fine.
    async with _router({"https://data.geo.admin.ch": httpx.Response(500), **_warning_routes(meteo_status=500)}) as c:
        await service.poll_radar(client=c, now=NOW)
        await service.poll_warnings(client=c, now=NOW)
    snapshot = service.snapshot(*OBERWIL, NOW)
    assert snapshot["radar"]["status"]["last_error"] == "HTTP 500"
    assert snapshot["warnings"]["sources"]["meteoswiss"]["last_error"] == "HTTP 500"
    assert snapshot["warnings"]["sources"]["alertswiss"]["last_error"] is None
    assert [w["source"] for w in snapshot["warnings"]["items"]] == ["alertswiss"]


async def test_last_known_warnings_survive_a_failed_round_and_go_stale():
    service = WeatherService()
    async with _router(_warning_routes()) as c:
        await service.poll_warnings(client=c, now=NOW)
    assert [w["source"] for w in service.snapshot(*ALPNACH, NOW)["warnings"]["items"]] == ["meteoswiss"]

    later = NOW + WARNINGS_STALE_AFTER + timedelta(minutes=1)
    async with _router({"https://": httpx.ReadTimeout("slow")}) as c:
        await service.poll_warnings(client=c, now=later)
    snapshot = service.snapshot(*ALPNACH, later)
    meteo = snapshot["warnings"]["sources"]["meteoswiss"]
    assert meteo["last_error"] == "Zeitüberschreitung" and meteo["stale"] is True
    (item,) = snapshot["warnings"]["items"]
    assert item["fetched_at"] == NOW.isoformat()  # the app labels it «Stand …»


async def test_unchanged_atom_feed_skips_the_big_json():
    service = WeatherService()
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return _warning_routes()[next(p for p in _warning_routes() if str(request.url).startswith(p))]

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        await service.poll_warnings(client=c, now=NOW)
        await service.poll_warnings(client=c, now=NOW + timedelta(minutes=10))
    assert calls.count(METEOALARM_JSON) == 1
    assert calls.count(METEOALARM_ATOM) == 2


async def test_no_point_means_no_warnings_but_radar_still_works():
    """An Einsatz without a coordinate asks without one: the radar comes, warnings do not."""
    service = WeatherService()
    async with _router(_warning_routes()) as c:
        await service.poll_warnings(client=c, now=NOW)
    snapshot = service.snapshot(None, None, NOW)
    assert snapshot["point"] is False
    assert snapshot["warnings"]["items"] == []
    assert snapshot["radar"] is not None


async def test_the_same_round_answers_each_einsatz_with_its_own_warnings():
    """KP Front selects per request: two Einsätze in two regions, one poll, two answers."""
    service = WeatherService()
    async with _router(_warning_routes()) as c:
        await service.poll_warnings(client=c, now=NOW)
    at_alpnach = service.snapshot(*ALPNACH, NOW)["warnings"]["items"]
    at_oberwil = service.snapshot(*OBERWIL, NOW)["warnings"]["items"]
    assert [w["region"] for w in at_alpnach] == ["Luzern-Alpnach"]
    assert [w["sender"] for w in at_oberwil] == ["Kanton Basel-Landschaft"]
    # …and the per-point cache is dropped when a round brings new candidates
    assert service._selections
    service.state.candidates["meteoswiss"] = []
    service.state.generation += 1
    service._selections.clear()
    assert service.snapshot(*ALPNACH, NOW)["warnings"]["items"] == []


async def test_a_warning_that_expires_between_rounds_disappears_at_once():
    service = WeatherService()
    async with _router(_warning_routes()) as c:
        await service.poll_warnings(client=c, now=NOW)
    assert service.snapshot(*ALPNACH, NOW)["warnings"]["items"]  # cached for the point…
    assert service.snapshot(*ALPNACH, datetime(2026, 10, 9, 6, 1, tzinfo=UTC))["warnings"]["items"] == []


def test_jobs_are_not_started_when_the_deployment_switched_the_layer_off(monkeypatch):
    from app import scheduler
    from app.config import settings

    monkeypatch.setattr(settings, "weather_layer_enabled", False)
    monkeypatch.setattr(scheduler, "_process_scheduler", None)
    scheduler._start_process_jobs()
    assert scheduler._process_scheduler is None


async def test_the_layer_jobs_run_in_every_process_not_only_on_the_leader(monkeypatch):
    """A standby replica serves requests too, and the frames live in the serving process: the
    layer's jobs start before (and whatever the outcome of) the leader election."""
    from fastapi import FastAPI

    from app import scheduler
    from app.config import settings

    monkeypatch.setattr(settings, "weather_layer_enabled", True)
    monkeypatch.setattr(scheduler, "_start_scheduler_jobs", lambda: None)
    monkeypatch.setattr(type(settings), "is_production", property(lambda _s: False))
    monkeypatch.setattr(scheduler, "_weather_radar_round", _noop)
    monkeypatch.setattr(scheduler, "_weather_warnings_round", _noop)
    await scheduler.start_scheduler(FastAPI())
    try:
        assert scheduler._process_scheduler is not None
        assert {j.id for j in scheduler._process_scheduler.get_jobs()} == {"weather_radar", "weather_warnings"}
    finally:
        await scheduler.stop_scheduler()
    assert scheduler._process_scheduler is None


async def _noop() -> None:
    return None


def test_snapshot_orders_frames_by_time_whatever_the_insertion_order(frame: radar.RenderedFrame):
    """A poll inserts newest-first; a snapshot taken mid-poll must still call the newest newest."""
    service = WeatherService()
    older = radar.RenderedFrame(
        time=frame.time - timedelta(minutes=5),
        png=frame.png,
        coordinates=frame.coordinates,
        wet_fraction=frame.wet_fraction,
    )
    service.state.frames[frame.key] = frame
    service.state.frames[older.key] = older
    snapshot = service.snapshot(*OBERWIL, frame.time + timedelta(minutes=3))
    assert [f["key"] for f in snapshot["radar"]["frames"]] == [older.key, frame.key]
    assert snapshot["radar"]["data_time"] == frame.time.isoformat()


def test_alertswiss_circle_only_areas_are_matched_by_distance():
    """Uri's «Bristenstrasse» notice (live 09.10.2026) is a 267 m circle with no polygon."""
    swiss = warnings.alertswiss_candidates({"de": _json("alertswiss_de.json"), "fr": _json("alertswiss_fr.json")})
    bristen = next(c for c in swiss if c["id"] == "alertswiss:POA-1368907708-2")
    ((lat, lon, radius),) = bristen["areas"][0]["circles"]
    assert (lat, lon) == (46.7697, 8.67591) and abs(radius - 266.6) < 0.1
    (inside,) = warnings.select([bristen], 46.7697 + 0.001, 8.67591, NOW)  # ~110 m north
    assert inside["region"] == "Bristenstrasse"
    assert warnings.select([bristen], 46.7697 + 0.004, 8.67591, NOW) == []  # ~450 m north
    assert warnings.select(swiss, *OBERWIL, NOW)[0]["sender"] == "Kanton Basel-Landschaft"


async def test_a_dead_feed_warns_once_and_says_when_it_is_back(caplog):
    service = WeatherService()
    caplog.set_level(logging.INFO, logger="app.weather_layer")
    async with _router({"https://": httpx.ConnectError("down")}) as c:
        for minutes in (0, 5, 10):
            await service.poll_radar(client=c, now=NOW + timedelta(minutes=minutes))
    warnings_logged = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings_logged) == 1
    caplog.clear()
    now = FIXTURE_FRAME_TIME + timedelta(minutes=2)
    async with _router({radar.frame_url(FIXTURE_FRAME_TIME): httpx.Response(200, content=RZC.read_bytes())}) as c:
        await service.poll_radar(client=c, now=now)
    assert any("recovered" in r.getMessage() for r in caplog.records)


# --- API --------------------------------------------------------------------------------------


@pytest.fixture
def one_frame(monkeypatch):
    from app.config import settings
    from app.weather_layer import weather_service

    monkeypatch.setattr(settings, "weather_layer_enabled", True)
    weather_service.reset()
    frame = radar.render_frame(radar.parse_rzc(RZC.read_bytes()))
    weather_service.state.frames[frame.key] = frame
    weather_service.state.candidates["alertswiss"] = warnings.alertswiss_candidates(
        {"de": _json("alertswiss_de.json"), "fr": _json("alertswiss_fr.json")}
    )
    yield frame
    weather_service.reset()


async def _login(client, user) -> None:
    from tests.conftest import TEST_PIN

    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": TEST_PIN})
    assert r.status_code == 200, r.text


async def test_layer_needs_a_session(client, one_frame):
    assert (await client.get("/api/weather/layer")).status_code == 401


async def test_a_viewer_reads_radar_and_the_warnings_at_the_einsatz(client, viewer, one_frame):
    await _login(client, viewer)
    response = await client.get("/api/weather/layer", params={"lat": OBERWIL[0], "lng": OBERWIL[1]})
    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is True and body["point"] is True
    assert body["radar"]["frames"] == [{"key": "202610081700", "time": "2026-10-08T17:00:00+00:00"}]
    assert body["radar"]["attribution"] == "MeteoSchweiz"
    assert len(body["radar"]["coordinates"]) == 4
    assert body["radar"]["legend"][0] == {"min_mm_h": 0.1, "color": "#9bd7ff"}
    (warning,) = body["warnings"]["items"]
    assert warning["sender"] == "Kanton Basel-Landschaft"
    assert "areas" not in warning  # the polygons stay on the server
    # …and without a point, no warnings
    bare = (await client.get("/api/weather/layer")).json()
    assert bare["point"] is False and bare["warnings"]["items"] == []


async def test_radar_frame_is_an_immutable_public_png(client, one_frame):
    response = await client.get(f"/api/weather/radar/{one_frame.key}.png")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert "immutable" in response.headers["cache-control"]
    assert response.content == one_frame.png
    assert (await client.get("/api/weather/radar/202001010000.png")).status_code == 404


async def test_layer_switched_off_by_the_deployment(client, editor, one_frame, monkeypatch):
    from app.config import settings

    await _login(client, editor)
    monkeypatch.setattr(settings, "weather_layer_enabled", False)
    response = await client.get("/api/weather/layer", params={"lat": OBERWIL[0], "lng": OBERWIL[1]})
    assert response.json() == {"enabled": False, "point": False, "generated_at": None, "radar": None, "warnings": None}
    assert (await client.get(f"/api/weather/radar/{one_frame.key}.png")).status_code == 404

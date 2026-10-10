"""Weather layer: radar conversion, staleness and failure handling.

Ported from kp-rueck (R5, feuerwehr-oberwil/kp-rueck#167) with the same fixture, so the two apps
are pinned to the same picture of the same rain. KP Front difference: the job runs per process.

`fixtures/weather/rzc262811700vl.001.h5` is a real MeteoSwiss RZC precipitation radar file,
08.10.2026 17:00 UTC (CC BY 4.0, «Quelle: MeteoSchweiz»). Oberwil was dry; central/eastern
Switzerland was not.

Nothing here touches the network: the poller gets an httpx MockTransport.
"""

import io
import logging
import math
import pathlib
from datetime import UTC, datetime, timedelta

import httpx
import numpy as np
import pytest
from PIL import Image

from app import weather_radar as radar
from app.geo_util import lv95_to_wgs84
from app.weather_layer import RADAR_STALE_AFTER, WeatherService
from app.weather_radar import lat_to_mercator_y, lon_to_mercator_x, wgs84_to_lv95

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "weather"
RZC = FIXTURES / "rzc262811700vl.001.h5"
OBERWIL = (47.514, 7.556)
FIXTURE_FRAME_TIME = datetime(2026, 10, 8, 17, 0, tzinfo=UTC)


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


NOW = datetime(2026, 10, 8, 17, 30, tzinfo=UTC)


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


async def test_radar_poll_fetches_published_frames_and_skips_missing_ones():
    service = WeatherService()
    now = FIXTURE_FRAME_TIME + timedelta(minutes=6)  # 17:06 → slots 17:05 (not yet there) … 16:10
    async with _router({radar.frame_url(FIXTURE_FRAME_TIME): httpx.Response(200, content=RZC.read_bytes())}) as c:
        await service.poll_radar(client=c, now=now)
    snapshot = service.snapshot(now)
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
    snapshot = service.snapshot(later)
    assert snapshot["radar"]["status"]["last_error"] == "nicht erreichbar"
    assert snapshot["radar"]["data_time"] == FIXTURE_FRAME_TIME.isoformat()
    assert len(snapshot["radar"]["frames"]) == 1  # last-known data kept…
    assert snapshot["radar"]["stale"] is True  # …but never passed off as current


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
    await scheduler.start_scheduler(FastAPI())
    try:
        assert scheduler._process_scheduler is not None
        assert {j.id for j in scheduler._process_scheduler.get_jobs()} == {"weather_radar"}
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
    snapshot = service.snapshot(frame.time + timedelta(minutes=3))
    assert [f["key"] for f in snapshot["radar"]["frames"]] == [older.key, frame.key]
    assert snapshot["radar"]["data_time"] == frame.time.isoformat()


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
    yield frame
    weather_service.reset()


async def _login(client, user) -> None:
    from tests.conftest import TEST_PIN

    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": TEST_PIN})
    assert r.status_code == 200, r.text


async def test_layer_needs_a_session(client, one_frame):
    assert (await client.get("/api/weather/layer")).status_code == 401


async def test_a_viewer_reads_the_radar(client, viewer, one_frame):
    await _login(client, viewer)
    response = await client.get("/api/weather/layer")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"enabled", "generated_at", "radar"}  # no warnings any more (10.10.2026)
    assert body["enabled"] is True
    assert body["radar"]["frames"] == [{"key": "202610081700", "time": "2026-10-08T17:00:00+00:00"}]
    assert body["radar"]["attribution"] == "MeteoSchweiz"
    assert len(body["radar"]["coordinates"]) == 4
    assert body["radar"]["legend"][0] == {"min_mm_h": 0.1, "color": "#9bd7ff"}


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
    response = await client.get("/api/weather/layer")
    assert response.json() == {"enabled": False, "generated_at": None, "radar": None}
    assert (await client.get(f"/api/weather/radar/{one_frame.key}.png")).status_code == 404

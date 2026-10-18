"""Are the outside APIs the app reads still shaped the way our parsers expect?

These call the real services, so they live outside `tests/` (whose conftest blocks the network)
and never gate a merge: `.github/workflows/upstream-apis.yml` runs them daily and opens an issue
when one goes red. Run by hand with `cd backend && uv run pytest tests_live`.

Why they exist: MeteoSwiss renamed its radar files on 13.10.2026 (`…vl.001.h5` → `…rl.001.h5`)
and the Karte showed no radar for five days without one red test – the unit tests mock the feed.
"""

from datetime import UTC, datetime

from app.weather import weather_client
from app.weather_layer import RADAR_STALE_AFTER, WeatherService

OBERWIL = (47.514, 7.556)


async def test_meteoswiss_radar_frames_are_found_and_decode():
    service = WeatherService()
    now = datetime.now(UTC)
    await service.poll_radar(now=now)
    radar = service.snapshot(now)["radar"]
    assert radar["status"]["last_error"] is None
    assert radar["frames"], "no radar frame in the last hour"
    assert radar["stale"] is False, f"newest frame {radar['data_time']} is older than {RADAR_STALE_AFTER}"
    assert service.frame_png(radar["frames"][-1]["key"]).startswith(b"\x89PNG")


async def test_meteoswiss_station_reading_has_wind():
    reading = await weather_client._from_meteoswiss(*OBERWIL)
    assert reading is not None, "no SMN station near Oberwil with a current row (VQHA80 / station CSV)"
    assert reading.source == "meteoswiss"
    assert reading.wind_dir_deg is not None and reading.station
    assert reading.observed_at is not None


async def test_open_meteo_reading_has_wind_and_a_weather_code():
    reading = await weather_client._from_open_meteo(*OBERWIL)
    assert reading is not None
    assert reading.wind_dir_deg is not None and reading.wind_speed_kmh is not None
    assert reading.weather_code is not None

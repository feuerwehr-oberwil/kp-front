"""Unit tests for the weather client (MeteoSwiss primary, Open-Meteo fallback).

Pure: httpx is mocked via a MockTransport, no live network and no DB. The cache and the
nearest-station join are exercised against small in-memory CSV fixtures. Run with
`uv run pytest`.
"""

import httpx
import pytest

from app.weather import WeatherClient, lv95_to_wgs84

# --- Fixtures: tiny CSVs in the real MeteoSwiss shapes -----------------------------

STATIONS_CSV = (
    "station_abbr;station_name;station_canton;station_coordinates_lv95_east;"
    "station_coordinates_lv95_north;station_coordinates_wgs84_lat;station_coordinates_wgs84_lon\n"
    "BAS;Basel / Binningen;BS;2610900;1265600;47.5413;7.5837\n"
    "TAE;Aadorf / Taenikon;TG;2710500;1259820;47.4797;8.9051\n"
)

VQHA80_CSV = (
    "Station/Location;Date;tre200s0;rre150z0;dkl010z0;fu3010z0;fu3010z1\n"
    "BAS;202606202200;19.90;0.20;225.00;12.50;28.40\n"
    "TAE;202606202200;18.10;0.00;185.00;3.20;5.40\n"
)

OPEN_METEO_JSON = {
    "current_units": {"wind_speed_10m": "km/h"},
    "current": {
        "time": "2026-06-20T22:15",
        "wind_speed_10m": 8.0,
        "wind_direction_10m": 207,
        "wind_gusts_10m": 19.0,
        "temperature_2m": 21.5,
        "precipitation": 0.0,
        "weather_code": 3,
    },
}


@pytest.fixture
def patch_httpx(monkeypatch):
    """Install a MockTransport-backed AsyncClient for the duration of a test."""

    def _install(handler):
        transport = httpx.MockTransport(handler)
        orig_init = httpx.AsyncClient.__init__

        def patched_init(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
            kwargs["transport"] = transport
            orig_init(self, *args, **kwargs)

        monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)

    return _install


# --- LV95 conversion ---------------------------------------------------------------


def test_lv95_to_wgs84_basel():
    lat, lng = lv95_to_wgs84(2610900, 1265600)
    assert abs(lat - 47.541) < 0.01
    assert abs(lng - 7.584) < 0.01


# --- MeteoSwiss path ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_meteoswiss_picks_nearest_station(patch_httpx):
    def handler(request: httpx.Request) -> httpx.Response:
        if "meta_stations" in request.url.path or "stations" in str(request.url):
            return httpx.Response(200, text=STATIONS_CSV)
        return httpx.Response(200, text=VQHA80_CSV)

    patch_httpx(handler)
    wc = WeatherClient()
    wc.provider = "meteoswiss"
    # Near Basel → should pick BAS, not TAE.
    data = await wc.get_weather(47.50, 7.59)
    assert data is not None
    assert data.source == "meteoswiss"
    assert data.station == "Basel / Binningen"
    assert data.wind_dir_deg == 225.0
    assert data.wind_speed_kmh == 12.5
    assert data.wind_gust_kmh == 28.4
    assert data.temp_c == 19.9
    assert data.precip_mm == 0.2
    assert data.observed_at == "2026-06-20T22:00:00+00:00"


@pytest.mark.asyncio
async def test_faraway_coordinate_never_pins_a_swiss_station(patch_httpx):
    """A bogus coordinate (0/0 'no location' once surfaced Grosser St. Bernhard as
    'nearest') must fall through to point-based Open-Meteo — no misleading station."""
    def handler(request: httpx.Request) -> httpx.Response:
        if "stations" in str(request.url):
            return httpx.Response(200, text=STATIONS_CSV)
        if "open-meteo" in str(request.url.host or ""):
            return httpx.Response(200, json=OPEN_METEO_JSON)
        return httpx.Response(200, text=VQHA80_CSV)

    patch_httpx(handler)
    wc = WeatherClient()
    wc.provider = "meteoswiss"
    data = await wc.get_weather(0.0, 0.0)
    assert data is not None
    assert data.source == "open-meteo"
    assert data.station is None


@pytest.mark.asyncio
async def test_cache_avoids_second_fetch(patch_httpx):
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if "stations" in str(request.url):
            return httpx.Response(200, text=STATIONS_CSV)
        return httpx.Response(200, text=VQHA80_CSV)

    patch_httpx(handler)
    wc = WeatherClient()
    wc.provider = "meteoswiss"
    await wc.get_weather(47.50, 7.59)
    first = calls["n"]
    await wc.get_weather(47.50, 7.59)  # same rounded key → cache hit
    assert calls["n"] == first  # no further HTTP calls


# --- Fallback to Open-Meteo --------------------------------------------------------


@pytest.mark.asyncio
async def test_falls_back_to_open_meteo_when_meteoswiss_errors(patch_httpx):
    def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if "geo.admin.ch" in host:
            return httpx.Response(500, text="boom")
        return httpx.Response(200, json=OPEN_METEO_JSON)

    patch_httpx(handler)
    wc = WeatherClient()
    wc.provider = "meteoswiss"
    data = await wc.get_weather(47.50, 7.59)
    assert data is not None
    assert data.source == "open-meteo"
    assert data.wind_dir_deg == 207.0
    assert data.wind_gust_kmh == 19.0
    assert data.station is None


@pytest.mark.asyncio
async def test_open_meteo_primary(patch_httpx):
    def handler(request: httpx.Request) -> httpx.Response:
        assert "open-meteo" in request.url.host
        return httpx.Response(200, json=OPEN_METEO_JSON)

    patch_httpx(handler)
    wc = WeatherClient()
    wc.provider = "open-meteo"
    data = await wc.get_weather(47.50, 7.59)
    assert data is not None
    assert data.source == "open-meteo"
    assert data.weather_code == 3


@pytest.mark.asyncio
async def test_meteoswiss_enriched_with_weather_code(patch_httpx):
    """MeteoSwiss has no present-weather code; it's backfilled from the Open-Meteo point."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "geo.admin.ch" in request.url.host:
            if "stations" in str(request.url):
                return httpx.Response(200, text=STATIONS_CSV)
            return httpx.Response(200, text=VQHA80_CSV)
        return httpx.Response(200, json=OPEN_METEO_JSON)  # open-meteo enrichment

    patch_httpx(handler)
    wc = WeatherClient()
    wc.provider = "meteoswiss"
    data = await wc.get_weather(47.50, 7.59)
    assert data is not None
    assert data.source == "meteoswiss"  # wind/temp still from the station
    assert data.weather_code == 3  # condition backfilled from Open-Meteo


# --- is_configured SSRF guard ------------------------------------------------------


def test_is_configured_requires_https():
    wc = WeatherClient()
    assert wc.is_configured is True
    wc.vqha80_url = "http://data.geo.admin.ch/x.csv"
    assert wc.is_configured is False

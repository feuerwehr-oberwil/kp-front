"""Weather / wind for a coordinate — MeteoSwiss primary, Open-Meteo fallback.

Mirrors the Traccar integration: a stateless client class + a module singleton
(`weather_client`), an `is_configured` https-only SSRF guard, and outbound calls via
`async with httpx.AsyncClient(...) as client:` + `raise_for_status()`.

MeteoSwiss exposes a single combined current-values CSV (VQHA80) carrying every param
per SMN station; we pick the nearest station to the incident coordinate (joining against
the SMN station metadata, which already publishes WGS84 station coords) and read the wind
/ temperature / precipitation columns off its row. Open-Meteo is a point-based fallback
used whenever MeteoSwiss fails or returns nothing for the chosen station.

Results are TTL-cached in-process, keyed by rounded (lat,lng), guarded by an asyncio.Lock
(cache pattern precedent: app/auth/pin_limiter.py).
"""

import asyncio
import csv
import io
import time
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel

from .config import settings
from .geo_util import haversine_m


class WeatherData(BaseModel):
    wind_dir_deg: float | None = None  # meteorological FROM bearing (0=N, 90=E)
    wind_speed_kmh: float | None = None
    wind_gust_kmh: float | None = None
    temp_c: float | None = None
    precip_mm: float | None = None
    weather_code: int | None = None  # WMO present-weather code (clear/cloud/rain/snow/…)
    observed_at: str | None = None  # ISO-8601 UTC
    source: str = "unknown"  # "meteoswiss" | "open-meteo"
    station: str | None = None  # nearest SMN station name (MeteoSwiss only)


def lv95_to_wgs84(east: float, north: float) -> tuple[float, float]:
    """Approximate LV95 (EPSG:2056) → WGS84 (lat, lng), swisstopo's closed-form formula.

    Accurate to a few metres — ample for a nearest-station lookup. The SMN metadata also
    ships WGS84 coords directly, so this is only a fallback for rows that lack them.
    """
    y = (east - 2_600_000.0) / 1_000_000.0
    x = (north - 1_200_000.0) / 1_000_000.0
    lng = (
        2.6779094
        + 4.728982 * y
        + 0.791484 * y * x
        + 0.1306 * y * x * x
        - 0.0436 * y * y * y
    ) * 100.0 / 36.0
    lat = (
        16.9023892
        + 3.238272 * x
        - 0.270978 * y * y
        - 0.002528 * x * x
        - 0.0447 * y * y * x
        - 0.0140 * x * x * x
    ) * 100.0 / 36.0
    return lat, lng


def _f(value: str | None) -> float | None:
    """Parse a MeteoSwiss CSV cell; '-' / '' / non-numeric → None."""
    if value is None:
        return None
    v = value.strip()
    if not v or v == "-":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _vqha80_timestamp(raw: str | None) -> str | None:
    """VQHA80 'Date' is YYYYMMDDHHMM in UTC → ISO-8601 UTC string."""
    if not raw:
        return None
    raw = raw.strip()
    try:
        dt = datetime.strptime(raw, "%Y%m%d%H%M").replace(tzinfo=UTC)
    except ValueError:
        return None
    return dt.isoformat()


class WeatherClient:
    def __init__(self) -> None:
        self.provider = (settings.weather_provider or "meteoswiss").lower()
        self.vqha80_url = settings.meteoswiss_vqha80_url
        self.stations_url = settings.meteoswiss_stations_url
        self.open_meteo_url = settings.open_meteo_url
        self.ttl = settings.weather_cache_ttl_seconds
        # rounded (lat,lng) -> (WeatherData, monotonic_expiry)
        self._cache: dict[tuple[float, float], tuple[WeatherData, float]] = {}
        self._lock = asyncio.Lock()

    @property
    def is_configured(self) -> bool:
        # SSRF defence-in-depth: the URLs are config-driven (not user input), but pin every
        # outbound base to https so a mis-set setting can't be aimed at an internal endpoint.
        for url in (self.vqha80_url, self.stations_url, self.open_meteo_url):
            if not url or urlsplit(url).scheme != "https":
                return False
        return True

    def _providers_in_order(self) -> list[str]:
        """Configured provider first, the other as fallback."""
        primary = self.provider if self.provider in ("meteoswiss", "open-meteo") else "meteoswiss"
        other = "open-meteo" if primary == "meteoswiss" else "meteoswiss"
        return [primary, other]

    async def get_weather(self, lat: float, lng: float) -> WeatherData | None:
        """Current weather near (lat,lng). TTL-cached; None if no provider yields data."""
        key = (round(lat, 2), round(lng, 2))
        async with self._lock:
            hit = self._cache.get(key)
            if hit and hit[1] > time.monotonic():
                return hit[0]

        result: WeatherData | None = None
        for provider in self._providers_in_order():
            try:
                if provider == "meteoswiss":
                    result = await self._from_meteoswiss(lat, lng)
                else:
                    result = await self._from_open_meteo(lat, lng)
            except httpx.HTTPError:
                result = None
            if result is not None:
                break

        # MeteoSwiss VQHA80 carries no present-weather code; backfill the WMO code from the
        # open data point forecast so the UI can show a cloud/rain/… icon. Best-effort.
        if result is not None and result.weather_code is None and result.source != "open-meteo":
            try:
                om = await self._from_open_meteo(lat, lng)
            except Exception:  # noqa: BLE001 — best-effort enrichment must never break the reading
                om = None
            if om is not None and om.weather_code is not None:
                result.weather_code = om.weather_code

        if result is not None:
            async with self._lock:
                self._cache[key] = (result, time.monotonic() + self.ttl)
        return result

    async def _from_meteoswiss(self, lat: float, lng: float) -> WeatherData | None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            meta_r = await client.get(self.stations_url)
            meta_r.raise_for_status()
            data_r = await client.get(self.vqha80_url)
            data_r.raise_for_status()

        stations = self._parse_stations(meta_r.text)
        rows = self._parse_vqha80(data_r.text)
        if not stations or not rows:
            return None

        # Nearest station that also has a current observation row.
        best_abbr: str | None = None
        best_name: str | None = None
        best_d = float("inf")
        for abbr, (slat, slng, name) in stations.items():
            if abbr not in rows:
                continue
            d = haversine_m(lat, lng, slat, slng)
            if d < best_d:
                best_d, best_abbr, best_name = d, abbr, name
        # "Nearest" is only meaningful near the network: a bogus coordinate (0/0 once made
        # Grosser St. Bernhard the "nearest" station) must fall through to the point-based
        # Open-Meteo instead of pinning a misleading Swiss station name on the reading.
        if best_abbr is None or best_d > 60_000:
            return None

        row = rows[best_abbr]
        data = WeatherData(
            wind_dir_deg=_f(row.get("dkl010z0")),
            wind_speed_kmh=_f(row.get("fu3010z0")),
            wind_gust_kmh=_f(row.get("fu3010z1")),
            temp_c=_f(row.get("tre200s0")),
            precip_mm=_f(row.get("rre150z0")),
            observed_at=_vqha80_timestamp(row.get("Date")),
            source="meteoswiss",
            station=best_name,
        )
        # If the nearest station reports no wind at all, the reading is useless for us.
        if data.wind_dir_deg is None and data.wind_speed_kmh is None:
            return None
        return data

    @staticmethod
    def _parse_stations(text: str) -> dict[str, tuple[float, float, str]]:
        """abbr -> (lat, lng, name). Uses published WGS84 coords; LV95 fallback if absent."""
        out: dict[str, tuple[float, float, str]] = {}
        reader = csv.DictReader(io.StringIO(text), delimiter=";")
        for r in reader:
            abbr = (r.get("station_abbr") or "").strip()
            if not abbr:
                continue
            lat = _f(r.get("station_coordinates_wgs84_lat"))
            lng = _f(r.get("station_coordinates_wgs84_lon"))
            if lat is None or lng is None:
                east = _f(r.get("station_coordinates_lv95_east"))
                north = _f(r.get("station_coordinates_lv95_north"))
                if east is None or north is None:
                    continue
                lat, lng = lv95_to_wgs84(east, north)
            out[abbr] = (lat, lng, (r.get("station_name") or abbr).strip())
        return out

    @staticmethod
    def _parse_vqha80(text: str) -> dict[str, dict[str, str]]:
        """station code -> {column: value}. First column is 'Station/Location'."""
        out: dict[str, dict[str, str]] = {}
        reader = csv.DictReader(io.StringIO(text), delimiter=";")
        for r in reader:
            code = (r.get("Station/Location") or "").strip()
            if code:
                out[code] = r
        return out

    async def _from_open_meteo(self, lat: float, lng: float) -> WeatherData | None:
        params = {
            "latitude": lat,
            "longitude": lng,
            "current": "wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,precipitation,weather_code",
            "wind_speed_unit": "kmh",
        }
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(self.open_meteo_url, params=params)
            r.raise_for_status()
            payload = r.json()

        cur = payload.get("current")
        if not isinstance(cur, dict):
            return None
        observed_at = cur.get("time")
        if isinstance(observed_at, str) and observed_at:
            # Open-Meteo returns local-ish naive ISO time without a zone; tag it as best-effort.
            observed_at = observed_at if "T" in observed_at else None
        return WeatherData(
            wind_dir_deg=_num(cur.get("wind_direction_10m")),
            wind_speed_kmh=_num(cur.get("wind_speed_10m")),
            wind_gust_kmh=_num(cur.get("wind_gusts_10m")),
            temp_c=_num(cur.get("temperature_2m")),
            precip_mm=_num(cur.get("precipitation")),
            weather_code=_int(cur.get("weather_code")),
            observed_at=observed_at,
            source="open-meteo",
            station=None,
        )


def _num(value: object) -> float | None:
    if value is None:
        return None
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _int(value: object) -> int | None:
    f = _num(value)
    return None if f is None else int(round(f))


weather_client = WeatherClient()

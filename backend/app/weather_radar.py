"""MeteoSwiss precipitation radar (RZC) → a Web-Mercator PNG the Karte lays over its basemap.

Ported from kp-rueck (R5, feuerwehr-oberwil/kp-rueck#167, 08.10.2026) – same algorithm, same
ramp, same tests, so the two apps show the same picture of the same rain. The state that holds
the frames and the poller that fills it are app/weather_layer.

Source: MeteoSwiss open data, STAC collection `ch.meteoschweiz.ogd-radar-precip`. One ODIM HDF5
file every 5 minutes, 710 × 640 cells of 1 km in LV95, values in mm/h (saturating at ~120).
Licence CC BY 4.0, attribution «Quelle: MeteoSchweiz»; nothing here may suggest that
MeteoSwiss endorses the app. There is no tile service, so the conversion happens here, once
per frame, and every device gets the same cached PNG.

Projection: the grid is LV95, the map is Web Mercator, and the two are not aligned – LV95 is an
oblique Mercator, so its rows bend against the map's parallels. A four-corner image overlay of
the raw grid would put a pixel in the middle of the domain hundreds of metres off. Instead the
PNG is RESAMPLED onto a Mercator-aligned grid: every output pixel centre is projected back to
LV95 and takes the value of the radar cell it falls in. MapLibre then only has to stretch an
axis-aligned rectangle, which it does exactly.

The LV95 ⇄ WGS84 conversion is swisstopo's approximation formula (app/geo_util has the scalar
inverse), vectorised here: accurate to about a metre inside Switzerland and, against the radar
file's own corner coordinates 300+ km outside it, still within ~25 m of the 1 km grid
(tests/test_weather_layer.py pins that) – two orders of magnitude below a radar pixel. pyproj
would be 40 MB for this one conversion.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache

import h5py
import numpy as np
from numpy.typing import NDArray
from PIL import Image

#: WGS84 semi-major axis, the sphere Web Mercator projects onto.
EARTH_RADIUS_M = 6378137.0


def wgs84_to_lv95(
    lat: NDArray[np.float64], lon: NDArray[np.float64]
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """swisstopo approximation, vectorised. Degrees in, LV95 metres (E, N) out."""
    phi = (lat * 3600.0 - 169028.66) / 10000.0
    lam = (lon * 3600.0 - 26782.5) / 10000.0
    east = 2600072.37 + 211455.93 * lam - 10938.51 * lam * phi - 0.36 * lam * phi**2 - 44.54 * lam**3
    north = 1200147.07 + 308807.95 * phi + 3745.25 * lam**2 + 76.63 * phi**2 - 194.56 * lam**2 * phi + 119.79 * phi**3
    return east, north


def lon_to_mercator_x(lon: float) -> float:
    return EARTH_RADIUS_M * math.radians(lon)


def lat_to_mercator_y(lat: float) -> float:
    return EARTH_RADIUS_M * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def mercator_x_to_lon(x: NDArray[np.float64]) -> NDArray[np.float64]:
    return np.degrees(x / EARTH_RADIUS_M)


def mercator_y_to_lat(y: NDArray[np.float64]) -> NDArray[np.float64]:
    return np.degrees(2.0 * np.arctan(np.exp(y / EARTH_RADIUS_M)) - math.pi / 2)


SOURCE_BASE_URL = "https://data.geo.admin.ch/ch.meteoschweiz.ogd-radar-precip"
FRAME_INTERVAL = timedelta(minutes=5)

#: Precipitation colour ramp, mm/h. The usual radar progression – light blue for drizzle, through
#: green and yellow, to red and magenta for cloudbursts – so it reads like every weather app the
#: crew already knows. Below the first step is «dry» and stays transparent. Alpha is lower for
#: the weakest class, so a wide band of drizzle does not veil the map.
#: (lower bound mm/h, hex colour, alpha 0–255)
PRECIP_RAMP: tuple[tuple[float, str, int], ...] = (
    (0.1, "#9bd7ff", 150),
    (0.5, "#4fb0ff", 190),
    (1.0, "#1f6fff", 210),
    (2.0, "#00b85c", 215),
    (4.0, "#86d800", 220),
    (6.0, "#ffe100", 225),
    (10.0, "#ff9a00", 230),
    (20.0, "#ff3d00", 235),
    (40.0, "#c8001e", 240),
    (60.0, "#c400c4", 245),
    (100.0, "#ffb3ff", 250),
)


@dataclass(frozen=True)
class RadarGrid:
    """One decoded RZC file."""

    time: datetime  # nominal (end) time of the 5-minute frame, UTC
    values: NDArray[np.float64]  # (rows, cols), mm/h, NaN = no data; row 0 is the NORTH edge
    east0: float  # LV95 east of the grid's west edge, metres
    north0: float  # LV95 north of the grid's north edge, metres
    xscale: float
    yscale: float
    corners: dict[str, tuple[float, float]]  # UL/UR/LL/LR → (lat, lon), as the file states them


@dataclass(frozen=True)
class RenderedFrame:
    """A frame as the map consumes it: PNG bytes + where they go."""

    time: datetime
    png: bytes
    #: MapLibre image-source order: top-left, top-right, bottom-right, bottom-left, as [lon, lat].
    coordinates: tuple[tuple[float, float], ...]
    wet_fraction: float  # share of the covered domain with ≥ the first ramp step (diagnostics)

    @property
    def key(self) -> str:
        return frame_key(self.time)


def frame_key(time: datetime) -> str:
    return time.astimezone(UTC).strftime("%Y%m%d%H%M")


def frame_url(time: datetime) -> str:
    """The file for a 5-minute slot: `<day>-ch/rzc<yy><day of year><hhmm>vl.001.h5` (UTC)."""
    t = time.astimezone(UTC)
    return f"{SOURCE_BASE_URL}/{t:%Y%m%d}-ch/rzc{t:%y}{t.timetuple().tm_yday:03d}{t:%H%M}vl.001.h5"


def floor_to_slot(time: datetime) -> datetime:
    t = time.astimezone(UTC).replace(second=0, microsecond=0)
    return t - timedelta(minutes=t.minute % 5)


def _attr_str(value: object) -> str:
    return value.decode() if isinstance(value, bytes) else str(value)


def parse_rzc(data: bytes) -> RadarGrid:
    """Decode an ODIM HDF5 RZC file. Raises ValueError on anything that is not one."""
    try:
        with h5py.File(io.BytesIO(data), "r") as f:
            what = f["what"].attrs
            where = f["where"].attrs
            dataset = f["dataset1/data1/data"]
            data_what = f["dataset1/data1/what"].attrs
            raw = np.asarray(dataset[()], dtype=np.float64)
            gain = float(data_what.get("gain", 1.0))
            offset = float(data_what.get("offset", 0.0))
            nodata = data_what.get("nodata")
            quantity = _attr_str(data_what.get("quantity", ""))
            stamp = _attr_str(what["date"]) + _attr_str(what["time"])
            xscale = float(where["xscale"])
            yscale = float(where["yscale"])
            corners = {
                corner: (float(where[f"{corner}_lat"]), float(where[f"{corner}_lon"]))
                for corner in ("UL", "UR", "LL", "LR")
            }
    except (OSError, KeyError) as exc:
        raise ValueError(f"not an ODIM RZC file: {exc}") from exc

    if quantity != "RATE":
        raise ValueError(f"unexpected radar quantity {quantity!r}")
    values = raw * gain + offset
    if nodata is not None and not (isinstance(nodata, float) and math.isnan(nodata)):
        values[raw == float(nodata)] = np.nan
    time = datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=UTC)

    # The file states its corners in lat/lon only. Projecting the upper-left one back to LV95 and
    # snapping it to the cell size recovers the grid origin exactly (2'255'000 / 1'480'000 for
    # today's domain) without hard-coding it, so a re-cut domain keeps working.
    ul_lat, ul_lon = corners["UL"]
    east, north = wgs84_to_lv95(np.array([ul_lat]), np.array([ul_lon]))
    east0 = round(float(east[0]) / xscale) * xscale
    north0 = round(float(north[0]) / yscale) * yscale
    return RadarGrid(
        time=time,
        values=values,
        east0=east0,
        north0=north0,
        xscale=xscale,
        yscale=yscale,
        corners=corners,
    )


def _palette() -> tuple[list[int], bytes]:
    rgb = [0, 0, 0]  # index 0 = dry / no data, fully transparent
    alpha = [0]
    for _, colour, a in PRECIP_RAMP:
        rgb += [int(colour[i : i + 2], 16) for i in (1, 3, 5)]
        alpha.append(a)
    return rgb, bytes(alpha)


@dataclass(frozen=True)
class _ResamplePlan:
    """Where every output pixel takes its value from – the same for every frame of a domain."""

    height: int
    width: int
    inside: NDArray[np.bool_]  # (height, width): pixel lies on the radar grid
    source: NDArray[np.intp]  # flat index into the radar grid, one per `inside` pixel
    coordinates: tuple[tuple[float, float], ...]


@lru_cache(maxsize=2)
def _resample_plan(
    corners: tuple[tuple[str, tuple[float, float]], ...],
    shape: tuple[int, int],
    east0: float,
    north0: float,
    xscale: float,
    yscale: float,
    oversample: float,
) -> _ResamplePlan:
    """The projection work of `render_frame`, done once per domain instead of once per frame:
    projecting ~1.3 M pixel centres allocated some 100 MB of temporaries every 5 minutes."""
    lats = [c[0] for _, c in corners]
    lons = [c[1] for _, c in corners]
    west, east = lon_to_mercator_x(min(lons)), lon_to_mercator_x(max(lons))
    south, north = lat_to_mercator_y(min(lats)), lat_to_mercator_y(max(lats))

    # Mercator stretches distances by 1/cos(lat); size the pixel to the domain's middle latitude.
    mid_lat = math.radians((min(lats) + max(lats)) / 2)
    pixel = xscale / math.cos(mid_lat) / oversample
    width = math.ceil((east - west) / pixel)
    height = math.ceil((north - south) / pixel)
    east = west + width * pixel
    south = north - height * pixel

    xs = west + (np.arange(width, dtype=np.float64) + 0.5) * pixel
    ys = north - (np.arange(height, dtype=np.float64) + 0.5) * pixel
    lon = mercator_x_to_lon(xs)[np.newaxis, :].repeat(height, axis=0)
    lat = mercator_y_to_lat(ys)[:, np.newaxis].repeat(width, axis=1)
    e, n = wgs84_to_lv95(lat, lon)
    col = np.floor((e - east0) / xscale).astype(np.int64)
    row = np.floor((north0 - n) / yscale).astype(np.int64)
    rows, cols = shape
    inside = (col >= 0) & (col < cols) & (row >= 0) & (row < rows)
    source = (row[inside] * cols + col[inside]).astype(np.intp)

    west_lon = float(mercator_x_to_lon(np.array([west]))[0])
    east_lon = float(mercator_x_to_lon(np.array([east]))[0])
    north_lat = float(mercator_y_to_lat(np.array([north]))[0])
    south_lat = float(mercator_y_to_lat(np.array([south]))[0])
    coordinates = (
        (west_lon, north_lat),
        (east_lon, north_lat),
        (east_lon, south_lat),
        (west_lon, south_lat),
    )
    return _ResamplePlan(height=height, width=width, inside=inside, source=source, coordinates=coordinates)


def render_frame(grid: RadarGrid, oversample: float = 1.5) -> RenderedFrame:
    """Resample the LV95 grid onto Web Mercator and colour it.

    `oversample` > 1 makes the output pixel smaller than the 1 km cell, so the nearest-cell
    lookup does not visibly drop or double cells where the two grids drift against each other.
    """
    plan = _resample_plan(
        tuple(sorted(grid.corners.items())),
        (int(grid.values.shape[0]), int(grid.values.shape[1])),
        grid.east0,
        grid.north0,
        grid.xscale,
        grid.yscale,
        oversample,
    )
    thresholds = np.array([step for step, _, _ in PRECIP_RAMP])
    with np.errstate(invalid="ignore"):
        classes = np.digitize(grid.values, thresholds).astype(np.uint8)  # per radar cell, 0 = dry
    classes[np.isnan(grid.values)] = 0
    index = np.zeros((plan.height, plan.width), dtype=np.uint8)
    index[plan.inside] = classes.ravel()[plan.source]

    covered = np.isfinite(grid.values)
    wet = covered & (np.nan_to_num(grid.values) >= thresholds[0])
    wet_fraction = float(wet.sum() / covered.sum()) if covered.any() else 0.0

    image = Image.fromarray(index, mode="P")
    rgb, alpha = _palette()
    image.putpalette(rgb)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True, transparency=alpha)
    return RenderedFrame(time=grid.time, png=buffer.getvalue(), coordinates=plan.coordinates, wet_fraction=wet_fraction)


def value_at(grid: RadarGrid, lat: float, lon: float) -> float | None:
    """The rain rate of the cell a point lies in (None outside the domain / no data)."""
    e, n = wgs84_to_lv95(np.array([lat]), np.array([lon]))
    col = math.floor((float(e[0]) - grid.east0) / grid.xscale)
    row = math.floor((grid.north0 - float(n[0])) / grid.yscale)
    rows, cols = grid.values.shape
    if not (0 <= row < rows and 0 <= col < cols):
        return None
    v = float(grid.values[row, col])
    return None if math.isnan(v) else v


def legend() -> list[dict[str, object]]:
    return [{"min_mm_h": step, "color": colour} for step, colour, _ in PRECIP_RAMP]

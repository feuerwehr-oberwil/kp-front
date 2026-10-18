"""«Unterirdische Bauten» — every underground building and tunnel of the Einsatzgebiet, for the Karte's Ebenen.

Owner, review round 4 (17.10.2026): «can we show all subterraneous objects through our firegis
database?» FireGIS's ``av_gebunterird`` is the official survey's (amtliche Vermessung) underground
buildings. The same features are in the open AV WFS app/object_footprints already reads
(geodienste.ch, Einzelobjekte ``ms:SOSF``): open data, no FireGIS file, so every deployment gets
it. Asked for: ``Art = unterirdisches_Gebaeude`` and — owner's answer on #383 — the underground
traffic structures ``Tunnel_Unterfuehrung_Galerie`` (tunnels, underpasses; the survey's only such
type, and polygons only: its line elements ``ms:SOLI`` carry none). Not ``Unterstand``.

* **The area** (owner on #383: the Einsatzgebiet, not the geocoder's 27 × 18 km box) — the
  municipalities of ``map.serviceArea.municipalities`` (BFS numbers), else the ONE municipality the
  station's map centre (``map.defaultView``) lies in, as their official boundaries (swisstopo
  swissBOUNDARIES3D over the geocoder's own host); united with ``REACH_M`` around every station
  object, so an object outside the brigade's own municipality (the ARA in the next village) still
  has its surroundings. A structure counts when any of its corners lies in that area.
* **Asked** by the scheduler (the footprint job, ``tick``), never by a device and never per view:
  once, then every ``REFRESH_S`` (weekly) or when the area (municipalities, map centre, an object's
  point) or the source changes. A failed ask keeps the set already stored and is tried again after
  ``RETRY_S``. Boxes are asked in cells of ``CELL_M``; a cell that comes back full (``CELL_COUNT``)
  is split in four, so no single request is unbounded, and a structure two cells both return is
  kept once.
* **Stored** as ONE compact GeoJSON MultiPolygon in ``reference/underground.json`` (outer rings,
  coordinates to six decimals ≈ 0.1 m, no properties — the layer draws outlines only).
* **Served** by ``GET /api/reference/underground`` (api/station_reference), which only reads; a
  device that already holds the current set (``?have=<fetchedAt>``) gets no geometry back.
* **Off**: ``UNDERGROUND_WFS=`` (settings.underground_wfs empty).

What leaves the station: the municipality numbers, the map centre and boxes around the station's
objects — what the footprint job and the geocoder already send.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import geocode, storage
from .config import settings
from .geo_util import lv95_to_wgs84
from .object_footprints import _bbox_condition, _equals, _geojson_polygons, in_any

logger = logging.getLogger(__name__)

STORE_KEY = "reference/underground.json"
#: the survey's types drawn (``ms:SOSF`` · ``Art``): underground buildings, tunnels/underpasses
ARTS = ("unterirdisches_Gebaeude", "Tunnel_Unterfuehrung_Galerie")
#: swissBOUNDARIES3D's municipalities (identify by point, feature by BFS number)
MUNICIPALITY_LAYER = "ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill"
#: asked again after a week (the survey changes slowly; the footprint job's cadence is the tick)
REFRESH_S = 7 * 24 * 3600.0
#: a failed ask waits this long before the next try (per process)
RETRY_S = 3600.0
#: one request's cell side, and how many features a cell may return before it is split
CELL_M = 3000.0
CELL_COUNT = 5000
#: a full cell is split at most this many times (3 km → 375 m)
MAX_SPLIT = 3
#: the surroundings of every station object (half the side of the square around its point)
REACH_M = 500.0
#: municipalities wider than this together are a misconfiguration, not a brigade (logged, skipped)
MAX_REGION_M = 60_000.0
TIMEOUT_S = 60.0
#: six decimals ≈ 0.1 m — the survey's own precision is a few centimetres, a screen's far less
DECIMALS = 6

_USER_AGENT = "kp-front (+https://github.com/feuerwehr-oberwil/kp-front)"

Box = tuple[float, float, float, float]  # west, south, east, north (WGS84)
Ring = list[tuple[float, float]]
Polygon = list[Ring]


def enabled() -> bool:
    return bool(settings.underground_wfs.strip())


# --- the area -----------------------------------------------------------------------------------


def box_size_m(box: Box) -> tuple[float, float]:
    w, s, e, n = box
    return ((e - w) * 111_320.0 * math.cos(math.radians((s + n) / 2)), (n - s) * 110_540.0)


def box_around(lng: float, lat: float, half_m: float = REACH_M) -> Box:
    dl = half_m / (111_320.0 * math.cos(math.radians(lat)))
    dp = half_m / 110_540.0
    return (lng - dl, lat - dp, lng + dl, lat + dp)


def bbox_of_polygons(polys: list[Polygon]) -> Box | None:
    pts = [p for poly in polys for p in (poly[0] if poly else [])]
    if not pts:
        return None
    return (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))


def _in_box(p: tuple[float, float], b: Box) -> bool:
    return b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3]


@dataclass
class Area:
    """What is asked for: the configured municipalities (or the map centre to find the one it lies
    in) and the station's object points. ``key`` changes whenever any of them does."""

    municipalities: list[int]
    centre: tuple[float, float] | None
    points: list[tuple[float, float]]
    polygons: list[Polygon] = field(default_factory=list)

    @property
    def key(self) -> str:
        h = hashlib.sha256()
        h.update(json.dumps([sorted(self.municipalities), self.centre if not self.municipalities else None]).encode())
        h.update(json.dumps(sorted((round(x, 6), round(y, 6)) for x, y in self.points)).encode())
        return h.hexdigest()[:16]

    @property
    def boxes(self) -> list[Box]:
        return [box_around(x, y) for x, y in self.points]

    def holds(self, ring: Ring) -> bool:
        """Any corner of the structure in a municipality or in an object's surroundings."""
        boxes = self.boxes
        return any(any(_in_box(p, b) for b in boxes) for p in ring) or any(in_any(self.polygons, p) for p in ring)


def _centre(cfg: dict) -> tuple[float, float] | None:
    view = (cfg.get("map") or {}).get("defaultView") or {}
    c = view.get("center")
    if isinstance(c, list) and len(c) == 2 and all(isinstance(v, int | float) for v in c):
        return (float(c[0]), float(c[1]))
    lv = view.get("centerLv95")
    if isinstance(lv, list) and len(lv) == 2 and all(isinstance(v, int | float) for v in lv):
        lat, lng = lv95_to_wgs84(float(lv[0]), float(lv[1]))
        return (lng, lat)
    return None


async def station_area(db: AsyncSession) -> Area | None:
    """The Einsatzgebiet as the config names it, and every station object's point. No network."""
    from .models import DeploymentConfig, ObjectSite

    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    cfg = (row.config_json or {}) if row and isinstance(row.config_json, dict) else {}
    raw = ((cfg.get("map") or {}).get("serviceArea") or {}).get("municipalities") or []
    municipalities = sorted({int(v) for v in raw if isinstance(v, int) and v > 0})
    pts = (
        await db.execute(
            select(ObjectSite.lng, ObjectSite.lat).where(ObjectSite.lat.is_not(None), ObjectSite.lng.is_not(None))
        )
    ).all()
    area = Area(municipalities, _centre(cfg), [(float(p[0]), float(p[1])) for p in pts])
    if not area.municipalities and area.centre is None and not area.points:
        return None
    return area


def _map_server() -> str:
    if not geocode._GEOCODER_OK:
        raise RuntimeError("no geocoder host")
    return geocode._IDENTIFY_URL.rsplit("/", 1)[0]


async def municipality_at(client: httpx.AsyncClient, lng: float, lat: float) -> int | None:
    """The BFS number of the (current) municipality this point lies in."""
    r = await client.get(
        f"{_map_server()}/identify",
        params={
            "geometry": f"{lng},{lat}",
            "geometryType": "esriGeometryPoint",
            "sr": "4326",
            "tolerance": "0",
            "layers": f"all:{MUNICIPALITY_LAYER}",
            "returnGeometry": "false",
        },
    )
    r.raise_for_status()
    for res in r.json().get("results", []):
        a = res.get("attributes") or res.get("properties") or {}
        if a.get("is_current_jahr") and a.get("gde_nr"):
            return int(a["gde_nr"])
    return None


async def municipality_boundary(client: httpx.AsyncClient, bfs: int) -> list[Polygon]:
    r = await client.get(
        f"{_map_server()}/{MUNICIPALITY_LAYER}/{bfs}",
        params={"geometryFormat": "geojson", "sr": "4326", "returnGeometry": "true"},
    )
    if r.status_code == 404:
        logger.warning("underground: no municipality %s in swissBOUNDARIES3D", bfs)
        return []
    r.raise_for_status()
    return _geojson_polygons((r.json().get("feature") or {}).get("geometry") or {})


async def resolve(client: httpx.AsyncClient, area: Area) -> Area:
    """The area with its municipalities' boundaries (the map centre's one when none is named)."""
    nums = list(area.municipalities)
    if not nums and area.centre is not None:
        home = await municipality_at(client, *area.centre)
        nums = [home] if home else []
    polys: list[Polygon] = []
    for n in nums:
        polys += await municipality_boundary(client, n)
    bb = bbox_of_polygons(polys)
    if bb and max(box_size_m(bb)) > MAX_REGION_M:
        logger.warning(
            "underground: municipalities %s span more than %.0f km — only the objects' surroundings",
            nums,
            MAX_REGION_M / 1000,
        )
        polys = []
    return Area(nums, area.centre, area.points, polys)


def boxes_to_ask(area: Area) -> list[Box]:
    """The municipalities' box, and the surroundings of every object that box does not cover."""
    out: list[Box] = []
    bb = bbox_of_polygons(area.polygons)
    if bb:
        out.append(bb)
    for b in area.boxes:
        if not (bb and bb[0] <= b[0] and bb[1] <= b[1] and b[2] <= bb[2] and b[3] <= bb[3]):
            out.append(b)
    return out


def cells(box: Box, cell_m: float = CELL_M) -> list[Box]:
    """The box cut into cells of about ``cell_m`` on a side (the last row/column takes the rest)."""
    w, s, e, n = box
    width, height = box_size_m(box)
    cols = max(1, math.ceil(width / cell_m))
    rows = max(1, math.ceil(height / cell_m))
    dx, dy = (e - w) / cols, (n - s) / rows
    return [(w + i * dx, s + j * dy, w + (i + 1) * dx, s + (j + 1) * dy) for j in range(rows) for i in range(cols)]


def quarter(box: Box) -> list[Box]:
    w, s, e, n = box
    mx, my = (w + e) / 2, (s + n) / 2
    return [(w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)]


# --- the ask ------------------------------------------------------------------------------------


async def _ask_cell(client: httpx.AsyncClient, box: Box) -> list[dict]:
    flt = (
        '<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2">'
        f"<fes:And><fes:Or>{''.join(_equals('Art', a) for a in ARTS)}</fes:Or>{_bbox_condition(box)}</fes:And>"
        "</fes:Filter>"
    )
    r = await client.get(
        settings.underground_wfs,
        params={
            "SERVICE": "WFS",
            "VERSION": "2.0.0",
            "REQUEST": "GetFeature",
            "TYPENAMES": "ms:SOSF",
            "SRSNAME": "urn:ogc:def:crs:EPSG::4326",
            "OUTPUTFORMAT": "geojson",
            "COUNT": str(CELL_COUNT),
            "FILTER": flt,
        },
    )
    r.raise_for_status()
    return list(r.json().get("features", []))


def rings_of(features: list[dict]) -> list[Ring]:
    """Every feature's outer ring(s), rounded (a structure is drawn as its outline)."""
    out: list[Ring] = []
    for f in features:
        if (f.get("properties") or {}).get("Art") not in (None, *ARTS):
            continue  # the filter asked for ARTS only; a source that ignores it does not sneak walls in
        for poly in _geojson_polygons(f.get("geometry") or {}):
            ring = [(round(x, DECIMALS), round(y, DECIMALS)) for x, y in poly[0]] if poly else []
            if len(ring) >= 3:
                out.append(ring)
    return out


async def fetch(client: httpx.AsyncClient, area: Area) -> list[Ring]:
    """Every underground structure in the area (a resolved one), each once."""
    seen: set[tuple] = set()
    out: list[Ring] = []
    todo: list[tuple[Box, int]] = [(c, 0) for b in boxes_to_ask(area) for c in cells(b)]
    while todo:
        cell, depth = todo.pop(0)
        feats = await _ask_cell(client, cell)
        if len(feats) >= CELL_COUNT and depth < MAX_SPLIT:
            todo.extend((q, depth + 1) for q in quarter(cell))
            continue
        if len(feats) >= CELL_COUNT:
            logger.warning("underground: a %s cell still returns %d features; kept as returned", cell, len(feats))
        for ring in rings_of(feats):
            k = tuple(ring)
            if k not in seen and area.holds(ring):
                seen.add(k)
                out.append(ring)
    return out


def as_geojson(rings: list[Ring]) -> dict:
    return {"type": "MultiPolygon", "coordinates": [[[list(p) for p in [*r, r[0]]]] for r in rings]}


# --- the store ----------------------------------------------------------------------------------

_read: tuple[float, dict | None, bytes | None] | None = None
_READ_S = 600.0
_failed_at: float | None = None


def _load() -> dict | None:
    if not storage.exists(STORE_KEY):
        return None
    try:
        data = json.loads(storage.get_bytes(STORE_KEY))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("geometry"), dict) else None


def stored() -> dict | None:
    """The stored set (``{fetchedAt, area, municipalities, count, geometry}``), ``None`` before the first
    ask. Read from storage at most every ten minutes per process; never asks the source."""
    global _read
    now = time.monotonic()
    if _read and now - _read[0] < _READ_S:
        return _read[1]
    data = _load()
    _read = (now, data, None)
    return data


def payload(have: str | None) -> bytes:
    """The answer of ``GET /api/reference/underground`` as JSON bytes (built once per stored set:
    the full answer is megabytes)."""
    global _read
    if not enabled():
        return json.dumps({"enabled": False}).encode()
    data = stored()
    if data is None:
        return json.dumps({"enabled": True, "fetchedAt": None, "count": 0}).encode()
    head = {"enabled": True, "fetchedAt": data.get("fetchedAt"), "count": data.get("count", 0)}
    if have and have == data.get("fetchedAt"):
        return json.dumps({**head, "unchanged": True}).encode()
    if _read and _read[1] is data and _read[2] is not None:
        return _read[2]
    body = json.dumps({**head, "geometry": data["geometry"]}, separators=(",", ":")).encode()
    if _read and _read[1] is data:
        _read = (_read[0], data, body)
    return body


def _due(data: dict | None, area: Area) -> bool:
    if data is None or data.get("source") != settings.underground_wfs or data.get("area") != area.key:
        return True
    try:
        at = datetime.fromisoformat(str(data.get("fetchedAt")))
    except ValueError:
        return True
    return (datetime.now(UTC) - at).total_seconds() > REFRESH_S


async def tick(db: AsyncSession, *, client: httpx.AsyncClient | None = None) -> int:
    """Ask for the Einsatzgebiet's underground structures when the stored set is missing, a week
    old, or for another area/source. Returns how many were stored (0 = nothing asked or failed)."""
    global _read, _failed_at
    if not enabled():
        return 0
    area = await station_area(db)
    if area is None or not _due(_load(), area):
        return 0
    if _failed_at is not None and time.monotonic() - _failed_at < RETRY_S:
        return 0
    own = client is None
    cli = client or httpx.AsyncClient(timeout=TIMEOUT_S, headers={"User-Agent": _USER_AGENT})
    try:
        resolved = await resolve(cli, area)
        rings = await fetch(cli, resolved)
    except (httpx.HTTPError, ValueError, KeyError, TypeError, RuntimeError) as e:
        _failed_at = time.monotonic()
        logger.warning("underground: could not ask the survey: %s", e)
        return 0
    finally:
        if own:
            await cli.aclose()
    _failed_at = None
    out: dict[str, Any] = {
        "version": 2,
        "fetchedAt": datetime.now(UTC).isoformat(),
        "source": settings.underground_wfs,
        "area": area.key,
        "municipalities": resolved.municipalities,
        "count": len(rings),
        "geometry": as_geojson(rings),
    }
    await asyncio.to_thread(storage.put_bytes, STORE_KEY, json.dumps(out, separators=(",", ":")).encode())
    _read = None
    logger.info(
        "underground: %d structures stored (municipalities %s + %d objects' surroundings)",
        len(rings),
        resolved.municipalities,
        len(area.points),
    )
    return len(rings)


def clear_cache() -> None:
    global _read, _failed_at
    _read = None
    _failed_at = None

"""«Unterirdische Bauten» — every underground building of the station's area, for the Karte's Ebenen.

Owner, review round 4 (17.10.2026): «can we show all subterraneous objects through our firegis
database?» FireGIS's ``av_gebunterird`` is the official survey's (amtliche Vermessung) underground
buildings. The same features are in the open AV WFS app/object_footprints already reads
(geodienste.ch, Einzelobjekte ``ms:SOSF`` with ``Art = unterirdisches_Gebaeude`` — the type a named
row's garages ride along with there): open data, no FireGIS file, so every deployment gets it.

* **The area** — the deployment's region, the geocoder's ``map.geocoder.bboxLv95`` (else the
  ``GEOCODER_BBOX_LV95`` setting, the same pair app/geocode biases on); without one, the box around
  the station's objects plus ``REACH_M``; neither → nothing to ask.
* **Asked** by the scheduler (the footprint job, ``tick``), never by a device and never per view:
  once, then every ``REFRESH_S`` (weekly) or when the area or the source changes. A failed ask
  keeps the set already stored and is tried again after ``RETRY_S``. The box is asked in cells of
  ``CELL_M``; a cell that comes back full (``CELL_COUNT``) is split in four, so no single request
  is unbounded, and a structure two cells both return is kept once.
* **Stored** as ONE compact GeoJSON MultiPolygon in ``reference/underground.json`` (outer rings,
  coordinates to six decimals ≈ 0.1 m, no properties — the layer draws outlines only). Measured
  for FWO's region (27 × 18 km over BL, BS, SO; 17.10.2026): 14 867 structures, 4.9 MB of JSON,
  ~0.95 MB gzipped on the wire — one file, no vector tiles needed.
* **Served** by ``GET /api/reference/underground`` (api/station_reference), which only reads; a
  device that already holds the current set (``?have=<fetchedAt>``) gets no geometry back.
* **Off**: ``UNDERGROUND_WFS=`` (settings.underground_wfs empty).

What leaves the station is the region's box — the same box every geocoder search already sends.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import storage
from .config import settings
from .geo_util import lv95_to_wgs84
from .object_footprints import _bbox_condition, _equals, _geojson_polygons

logger = logging.getLogger(__name__)

STORE_KEY = "reference/underground.json"
#: the survey's type for an underground building (``ms:SOSF`` · ``Art``)
ART = "unterirdisches_Gebaeude"
#: asked again after a week (the survey changes slowly; the footprint job's cadence is the tick)
REFRESH_S = 7 * 24 * 3600.0
#: a failed ask waits this long before the next try (per process)
RETRY_S = 3600.0
#: one request's cell side, and how many features a cell may return before it is split
CELL_M = 3000.0
CELL_COUNT = 5000
#: a full cell is split at most this many times (3 km → 375 m)
MAX_SPLIT = 3
#: no region configured: the box around the station's objects, this much wider on every side
REACH_M = 1500.0
#: a region wider than this is a misconfigured bbox, not a brigade's area (logged, nothing asked)
MAX_REGION_M = 60_000.0
TIMEOUT_S = 60.0
#: six decimals ≈ 0.1 m — the survey's own precision is a few centimetres, a screen's far less
DECIMALS = 6

_USER_AGENT = "kp-front (+https://github.com/feuerwehr-oberwil/kp-front)"

Box = tuple[float, float, float, float]  # west, south, east, north (WGS84)
Ring = list[tuple[float, float]]


def enabled() -> bool:
    return bool(settings.underground_wfs.strip())


# --- the area -----------------------------------------------------------------------------------


def parse_lv95_box(text: str) -> Box | None:
    """``"minE,minN,maxE,maxN"`` (LV95) → a WGS84 box, ``None`` when it is not one."""
    try:
        e0, n0, e1, n1 = (float(v) for v in text.split(","))
    except ValueError:
        return None
    if not (e0 < e1 and n0 < n1):
        return None
    corners = [lv95_to_wgs84(e, n) for e in (e0, e1) for n in (n0, n1)]
    lats = [c[0] for c in corners]
    lngs = [c[1] for c in corners]
    return (min(lngs), min(lats), max(lngs), max(lats))


def box_size_m(box: Box) -> tuple[float, float]:
    w, s, e, n = box
    return ((e - w) * 111_320.0 * math.cos(math.radians((s + n) / 2)), (n - s) * 110_540.0)


async def region_box(db: AsyncSession) -> Box | None:
    """The area to ask for: the geocoder's region, else the station's objects plus REACH_M."""
    from .models import DeploymentConfig, ObjectSite

    text = settings.geocoder_bbox_lv95
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    cfg = (row.config_json or {}) if row else {}
    geo = ((cfg.get("map") or {}).get("geocoder") or {}) if isinstance(cfg, dict) else {}
    if str(geo.get("bboxLv95") or "").strip():
        text = str(geo["bboxLv95"]).strip()
    if text.strip():
        box = parse_lv95_box(text)
        if box:
            return box
        logger.warning("underground: the region bbox %r is not minE,minN,maxE,maxN", text)
    pts = (
        await db.execute(
            select(ObjectSite.lng, ObjectSite.lat).where(ObjectSite.lat.is_not(None), ObjectSite.lng.is_not(None))
        )
    ).all()
    if not pts:
        return None
    lngs = [float(p[0]) for p in pts]
    lats = [float(p[1]) for p in pts]
    mid = math.radians((min(lats) + max(lats)) / 2)
    pad_lat = REACH_M / 110_540.0
    pad_lng = REACH_M / (111_320.0 * math.cos(mid))
    return (min(lngs) - pad_lng, min(lats) - pad_lat, max(lngs) + pad_lng, max(lats) + pad_lat)


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
        f"<fes:And>{_equals('Art', ART)}{_bbox_condition(box)}</fes:And></fes:Filter>"
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


def _ring_key(ring: Ring) -> tuple:
    return tuple(ring)


def rings_of(features: list[dict]) -> list[Ring]:
    """Every feature's outer ring(s), rounded (an underground building is drawn as its outline)."""
    out: list[Ring] = []
    for f in features:
        if (f.get("properties") or {}).get("Art") not in (None, ART):
            continue  # the filter asked for ART only; a source that ignores it does not sneak walls in
        for poly in _geojson_polygons(f.get("geometry") or {}):
            ring = [(round(x, DECIMALS), round(y, DECIMALS)) for x, y in poly[0]] if poly else []
            if len(ring) >= 3:
                out.append(ring)
    return out


async def fetch(client: httpx.AsyncClient, box: Box) -> list[Ring]:
    """Every underground building in the box, each once."""
    seen: set[tuple] = set()
    out: list[Ring] = []
    todo: list[tuple[Box, int]] = [(c, 0) for c in cells(box)]
    while todo:
        cell, depth = todo.pop(0)
        feats = await _ask_cell(client, cell)
        if len(feats) >= CELL_COUNT and depth < MAX_SPLIT:
            todo.extend((q, depth + 1) for q in quarter(cell))
            continue
        if len(feats) >= CELL_COUNT:
            logger.warning("underground: a %s cell still returns %d features; kept as returned", cell, len(feats))
        for ring in rings_of(feats):
            k = _ring_key(ring)
            if k not in seen:
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
    """The stored set (``{fetchedAt, box, source, count, geometry}``), ``None`` before the first
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


def _due(data: dict | None, box: Box) -> bool:
    if data is None:
        return True
    if data.get("source") != settings.underground_wfs or [round(v, 6) for v in data.get("box") or []] != [
        round(v, 6) for v in box
    ]:
        return True
    try:
        at = datetime.fromisoformat(str(data.get("fetchedAt")))
    except ValueError:
        return True
    return (datetime.now(UTC) - at).total_seconds() > REFRESH_S


async def tick(db: AsyncSession, *, client: httpx.AsyncClient | None = None) -> int:
    """Ask for the region's underground buildings when the stored set is missing, a week old, or
    for another area/source. Returns how many were stored (0 = nothing asked or the ask failed)."""
    global _read, _failed_at
    if not enabled():
        return 0
    box = await region_box(db)
    if box is None:
        return 0
    width, height = box_size_m(box)
    if max(width, height) > MAX_REGION_M:
        logger.warning(
            "underground: the region is %.0f × %.0f m, more than one brigade's area — not asked", width, height
        )
        return 0
    if not _due(_load(), box):
        return 0
    if _failed_at is not None and time.monotonic() - _failed_at < RETRY_S:
        return 0
    own = client is None
    cli = client or httpx.AsyncClient(timeout=TIMEOUT_S, headers={"User-Agent": _USER_AGENT})
    try:
        rings = await fetch(cli, box)
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
        _failed_at = time.monotonic()
        logger.warning("underground: could not ask the survey: %s", e)
        return 0
    finally:
        if own:
            await cli.aclose()
    _failed_at = None
    out: dict[str, Any] = {
        "version": 1,
        "fetchedAt": datetime.now(UTC).isoformat(),
        "source": settings.underground_wfs,
        "box": list(box),
        "count": len(rings),
        "geometry": as_geojson(rings),
    }
    await asyncio.to_thread(storage.put_bytes, STORE_KEY, json.dumps(out, separators=(",", ":")).encode())
    _read = None
    logger.info("underground: %d underground buildings stored for the region", len(rings))
    return len(rings)


def clear_cache() -> None:
    global _read, _failed_at
    _read = None
    _failed_at = None

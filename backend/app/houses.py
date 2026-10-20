"""The Einsatzgebiet's houses — one cadastral footprint per house, for a building tap in the Karte.

Owner, Karte Haus round 1 (19.10.2026): «the buildings are all grouped together, meaning that there
is no differentiation between Storchenweg 2, 4, or 6». A tap on a plain building opened the
OpenStreetMap outline under the finger, and OSM maps a terraced row as ONE polygon. The official
survey (amtliche Vermessung, Bodenbedeckung ``ms:LCSF`` · ``Art = Gebaeude``, the layer
app/object_footprints already draws objects with) has one footprint per house.

Same pattern as app/underground (owner-approved, review round 4), and the same area:

* **The area** — the Einsatzgebiet (``map.serviceArea.municipalities``, else the municipality at
  ``map.defaultView``) ∪ ``underground.REACH_M`` around every station object
  (``underground.station_area`` / ``resolve``). A house counts when any corner lies in it.
* **Asked** by the scheduler (the footprint job, ``tick``), never by a device: once, then weekly or
  when the area or the source changes; a failed ask keeps the stored set and waits ``RETRY_S``.
  ONE request at a time in cells of ``CELL_M`` (a full cell is split) — the survey answers a burst
  of parallel asks with 502s / timeouts (kit, 19.10.2026).
* **Stored** as ONE compact GeoJSON MultiPolygon in ``reference/houses.json`` (outer rings, six
  decimals, no properties — the Karte only needs «which house is under the finger»; the register
  is asked at the tap's point, as before).
* **Served** by ``GET /api/reference/houses`` (api/station_reference), read-only, ``?have=``.
* **Off**: ``HOUSES_WFS=`` — the Karte then taps OSM outlines, as before.

What leaves the station: the municipality numbers, the map centre and boxes around the station's
objects — what the footprint job and app/underground already send.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from . import storage
from .config import settings
from .object_footprints import _IS_BUILDING, _bbox_condition, _geojson_polygons
from .underground import (
    CELL_COUNT,
    DECIMALS,
    REFRESH_S,
    RETRY_S,
    TIMEOUT_S,
    Box,
    Ring,
    as_geojson,
    fetch,
    resolve,
    station_area,
)

logger = logging.getLogger(__name__)

STORE_KEY = "reference/houses.json"
#: one request's cell side — a dense quarter holds ~1 700 houses per km² (Oberwil, 19.10.2026),
#: so a cell stays well under ``CELL_COUNT`` and about a megabyte of GeoJSON
CELL_M = 1000.0

_USER_AGENT = "kp-front (+https://github.com/feuerwehr-oberwil/kp-front)"


def enabled() -> bool:
    return bool(settings.houses_wfs.strip())


async def _ask_cell(client: httpx.AsyncClient, box: Box) -> list[dict]:
    flt = (
        '<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2">'
        f"<fes:And>{_IS_BUILDING}{_bbox_condition(box)}</fes:And></fes:Filter>"
    )
    r = await client.get(
        settings.houses_wfs,
        params={
            "SERVICE": "WFS",
            "VERSION": "2.0.0",
            "REQUEST": "GetFeature",
            "TYPENAMES": "ms:LCSF",
            "SRSNAME": "urn:ogc:def:crs:EPSG::4326",
            "OUTPUTFORMAT": "geojson",
            "COUNT": str(CELL_COUNT),
            "FILTER": flt,
        },
    )
    r.raise_for_status()
    return list(r.json().get("features", []))


def rings_of(features: list[dict]) -> list[Ring]:
    """Every house's outer ring, rounded. Bodenbedeckung other than ``Gebaeude`` (a source that
    ignores the filter) is dropped: a garden or a road is not a house."""
    out: list[Ring] = []
    for f in features:
        if (f.get("properties") or {}).get("Art") not in (None, "Gebaeude"):
            continue
        for poly in _geojson_polygons(f.get("geometry") or {}):
            ring = [(round(x, DECIMALS), round(y, DECIMALS)) for x, y in poly[0]] if poly else []
            if len(ring) >= 3:
                out.append(ring)
    return out


# --- the store (as app/underground's) -------------------------------------------------------------

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
    """The stored set, ``None`` before the first ask; re-read at most every ten minutes."""
    global _read
    now = time.monotonic()
    if _read and now - _read[0] < _READ_S:
        return _read[1]
    data = _load()
    _read = (now, data, None)
    return data


def payload(have: str | None) -> bytes:
    """The answer of ``GET /api/reference/houses`` as JSON bytes, built once per stored set."""
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


def _due(data: dict | None, area_key: str) -> bool:
    if data is None or data.get("source") != settings.houses_wfs or data.get("area") != area_key:
        return True
    try:
        at = datetime.fromisoformat(str(data.get("fetchedAt")))
    except ValueError:
        return True
    return (datetime.now(UTC) - at).total_seconds() > REFRESH_S


async def tick(db: AsyncSession, *, client: httpx.AsyncClient | None = None) -> int:
    """Ask for the Einsatzgebiet's houses when the stored set is missing, a week old, or for another
    area/source. Returns how many were stored (0 = nothing asked or failed)."""
    global _read, _failed_at
    if not enabled():
        return 0
    area = await station_area(db)
    if area is None or not _due(_load(), area.key):
        return 0
    if _failed_at is not None and time.monotonic() - _failed_at < RETRY_S:
        return 0
    own = client is None
    cli = client or httpx.AsyncClient(timeout=TIMEOUT_S, headers={"User-Agent": _USER_AGENT})
    try:
        resolved = await resolve(cli, area)
        rings = await fetch(cli, resolved, ask=_ask_cell, shape=rings_of, cell_m=CELL_M)
    except (httpx.HTTPError, ValueError, KeyError, TypeError, RuntimeError) as e:
        _failed_at = time.monotonic()
        logger.warning("houses: could not ask the survey: %s", e)
        return 0
    finally:
        if own:
            await cli.aclose()
    _failed_at = None
    out: dict[str, Any] = {
        "version": 1,
        "fetchedAt": datetime.now(UTC).isoformat(),
        "source": settings.houses_wfs,
        "area": area.key,
        "municipalities": resolved.municipalities,
        "count": len(rings),
        "geometry": as_geojson(rings),
    }
    await asyncio.to_thread(storage.put_bytes, STORE_KEY, json.dumps(out, separators=(",", ":")).encode())
    _read = None
    logger.info(
        "houses: %d stored (municipalities %s + %d objects' surroundings)",
        len(rings),
        resolved.municipalities,
        len(area.points),
    )
    return len(rings)


def clear_cache() -> None:
    global _read, _failed_at
    _read = None
    _failed_at = None

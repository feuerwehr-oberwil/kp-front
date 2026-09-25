"""The station's building outlines, fetched ONCE and kept – the reference every alignment job
clips its own box out of.

Asking a public Overpass mirror once per sheet (450 times at the first prod run, again on every
«Neu berechnen») from a shared cloud egress is exactly what those mirrors throttle: 13.09.2026
prod saw «reference_unreachable» on retry after retry while the same query answered from a
laptop in two seconds. Buildings do not move on the operator's timescale, so the worker fetches
one box around every object the station has, stores it beside the PDFs, and refreshes it after
a week or when the station gained objects outside the box. A sheet's reference is then a clip
of that snapshot – the same «any vertex inside the bbox» rule Overpass applies – and the
per-object request only remains as the fallback for a station without a snapshot at all.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import overpass, storage
from .models import ObjectSite

logger = logging.getLogger(__name__)

SNAPSHOT_KEY = "reference/osm-buildings.json"
SNAPSHOT_TTL = timedelta(days=7)
# Wider than any sheet's own reference box (georef_suggest.RADIUS_MAX_M = 650), so a clip never
# runs off the snapshot's edge for an object that was inside it when it was fetched.
PAD_M = 700.0
# The station-wide query is bigger than a sheet's; give the mirrors room.
FETCH_TIMEOUT_S = 90.0
# Re-reading a multi-MB JSON blob on every 10 s tick would be silly; keep the parsed snapshot
# around for a while, keyed by its own fetch time.
_cache: tuple[float, dict] | None = None
_CACHE_S = 600.0


def bbox_of(points: list[tuple[float, float]], pad_m: float = PAD_M) -> tuple[float, float, float, float] | None:
    """(lat0, lng0, lat1, lng1) around every (lng, lat), padded by `pad_m` metres."""
    if not points:
        return None
    lats = [p[1] for p in points]
    lngs = [p[0] for p in points]
    mid = sum(lats) / len(lats)
    dlat = pad_m / 111_320
    dlng = pad_m / (111_320 * math.cos(math.radians(mid)))
    return (min(lats) - dlat, min(lngs) - dlng, max(lats) + dlat, max(lngs) + dlng)


def covers(outer: tuple[float, float, float, float], inner: tuple[float, float, float, float]) -> bool:
    return outer[0] <= inner[0] and outer[1] <= inner[1] and outer[2] >= inner[2] and outer[3] >= inner[3]


def clip(snapshot: dict, lng: float, lat: float, radius_m: float) -> dict:
    """An Overpass-shaped answer for the box around one object: every element with at least one
    vertex inside it (the bbox filter's own rule), unchanged otherwise."""
    dlat = radius_m / 111_320
    dlng = radius_m / (111_320 * math.cos(math.radians(lat)))
    return clip_bbox(snapshot, (lat - dlat, lng - dlng, lat + dlat, lng + dlng))


def clip_bbox(snapshot: dict, box: tuple[float, float, float, float]) -> dict:
    """`clip` for an explicit (south, west, north, east) box — the shape /overpass/buildings asks in."""
    lat0, lng0, lat1, lng1 = box

    def inside(points: list[dict]) -> bool:
        return any(lat0 <= g.get("lat", 91) <= lat1 and lng0 <= g.get("lon", 181) <= lng1 for g in points)

    def hit(el: dict) -> bool:
        if el.get("type") == "way":
            return inside(el.get("geometry", []))
        return el.get("type") == "relation" and any(inside(m.get("geometry", [])) for m in el.get("members", []))

    return {"elements": [el for el in snapshot.get("elements", []) if hit(el)]}


def _load_stored() -> dict | None:
    if not storage.exists(SNAPSHOT_KEY):
        return None
    try:
        data = json.loads(storage.get_bytes(SNAPSHOT_KEY))
        return data if isinstance(data, dict) and isinstance(data.get("elements"), list) else None
    except (OSError, ValueError):
        return None


async def stored_answer(box: tuple[float, float, float, float]) -> dict | None:
    """The snapshot's answer for (south, west, north, east) when the STORED snapshot covers the whole
    box — or None, and the caller asks the mirrors. Read-only: it never fetches, never refreshes
    (that stays the worker's `ensure_snapshot`), so a browser request costs no Overpass query at
    all for an Einsatz inside the station's area.

    Why it exists (25.09.2026): every Karte/Gebäude open on staging answered 502 about half the
    time — all three public mirrors 504 or stalled from Railway's shared egress — while the very
    outlines sat in this snapshot beside the PDFs. A week-old outline is the same building.
    """
    global _cache
    now = time.monotonic()
    stored: dict | None
    if _cache and now - _cache[0] < _CACHE_S:
        stored = _cache[1]
    else:
        # a multi-MB parse — off the event loop, and kept for the next caller
        stored = await asyncio.to_thread(_load_stored)
        if stored is None:
            return None
        _cache = (now, stored)
    bbox = stored.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4 or not covers(tuple(bbox), box):
        return None
    return clip_bbox(stored, box)


async def station_bbox(db: AsyncSession) -> tuple[float, float, float, float] | None:
    rows = (await db.execute(select(ObjectSite.lng, ObjectSite.lat).where(ObjectSite.lat.is_not(None)))).all()
    return bbox_of([(float(lng), float(lat)) for lng, lat in rows if lng is not None and lat is not None])


async def ensure_snapshot(db: AsyncSession) -> dict | None:
    """The current snapshot, refreshed when stale or too small; the stale one when the mirrors
    refuse; None for a station that has none yet (the caller then asks per object)."""
    global _cache  # one process-wide parsed copy
    now = time.monotonic()
    if _cache and now - _cache[0] < _CACHE_S:
        return _cache[1]
    stored = _load_stored()
    wanted = await station_bbox(db)
    fresh = (
        stored is not None
        and wanted is not None
        and covers(tuple(stored.get("bbox", (0, 0, 0, 0))), wanted)
        and datetime.now(UTC) - datetime.fromisoformat(stored.get("fetched_at", "1970-01-01T00:00:00+00:00"))
        < SNAPSHOT_TTL
    )
    if not fresh and wanted is not None:
        query = overpass.BUILDINGS_QUERY.format(bbox=",".join(f"{v:.6f}" for v in wanted)).replace(
            "timeout:25", "timeout:90"
        )
        try:
            data = await overpass.fetch_buildings(query, timeout_s=FETCH_TIMEOUT_S, cache=False)
            stored = {
                "fetched_at": datetime.now(UTC).isoformat(),
                "bbox": list(wanted),
                "elements": data.get("elements", []),
            }
            storage.put_bytes(SNAPSHOT_KEY, json.dumps(stored).encode())
            logger.info("building snapshot refreshed: %d elements for bbox %s", len(stored["elements"]), wanted)
        except Exception:  # noqa: BLE001 – the stale snapshot (if any) is still the better reference
            logger.warning(
                "building snapshot refresh failed; keeping %s", "the stale one" if stored else "nothing", exc_info=True
            )
    if stored is not None:
        _cache = (now, stored)
    return stored

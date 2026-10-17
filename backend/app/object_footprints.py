"""Every building a station object stands for — derived once, server-side, from official data.

«Karte & Objekte» drew each object as the ONE OpenStreetMap outline its coordinate lies in. A
school campus (Schulhaus Hüslimatt: five buildings on different parcels) then showed one red
house, and a mis-mapped OSM «building» (the BLT Tramdepot's outline runs 150 m up the track
yard) was painted as if it were a building (owner, 17.10.2026). This module answers «which
buildings ARE this object» once per object, from three public, keyless sources:

* **the use area** — swisstopo's swissTLM3D «Nutzungsareal» (Schul- und Hochschulareal,
  Spitalareal, Sportanlage …), read from the ``landuse`` layer of swisstopo's base vector tiles
  (``ch.swisstopo.base.vt``, z14) — no identify service publishes those polygons;
* **the parcel** — the cadastral Liegenschaft at the point (geo.admin identify on
  ``ch.swisstopo-vd.amtliche-vermessung``, the geocoder's own host);
* **the buildings** — the cadastral survey's own footprints (amtliche Vermessung,
  Bodenbedeckung «Gebäude», with their EGID) over geodienste.ch's open AV WFS.

The rule (``derive``): the object's point inside an ALLOWED use area → every building whose
centroid lies in that area; else every building on its parcel; else the one building its point
lies in; else nothing — and the viewer falls back to today's OSM outline by containment. A step
is skipped when it is too big to be one object (``MAX_AREA_M2`` / ``MAX_PARCEL_M2`` /
``MAX_BUILDINGS``: an industrial estate of unrelated firms) or when it holds ANOTHER station
object's point (two catalogue objects on one parcel must never claim each other's buildings —
the «never by proximity» rule of lib/karte/places, kept at the scale of a parcel).

⚠️ Nothing here runs per request. The scheduler (``tick``) asks the sources for a handful of
objects per run and stores the answers in ``reference/object-footprints.json`` beside the
building snapshot; ``GET /api/reference/objects`` only reads that file (``stored``). A device
therefore never makes a geo.admin call to draw the map, and the outlines ride in the catalogue
the viewer keeps for offline (#370). What a source said is kept per COORDINATE (``facts``), so a
catalogue change re-derives without asking anybody again; a failed ask is retried an hour later
and never stored as «nothing there».
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import geocode, mvt, storage
from .config import settings

logger = logging.getLogger(__name__)

STORE_KEY = "reference/object-footprints.json"
#: bump when the derivation changes — every stored footprint is derived again (facts are kept)
ALGO = 1

#: the swissTLM3D use areas that ARE one object's grounds. Residential quarters, parking lots and
#: single pitches are not; a school, a hospital, a sports ground or a cemetery (its chapel) are.
AREA_CLASSES = frozenset(
    {
        "school",
        "college",
        "university",
        "hospital",
        "sports",
        "swimming_pool",
        "cemetery",
        "zoo",
        "power_transformer",
    }
)
#: bigger than this is a district, not an object's grounds (Hüslimatt's school area: 22 000 m²)
MAX_AREA_M2 = 150_000.0
#: a parcel this big is a farm, a forest or a whole estate
MAX_PARCEL_M2 = 60_000.0
#: more buildings than this is not one object any more
MAX_BUILDINGS = 15
#: a shed, a kiosk or a transformer box on the grounds is not one of the object's buildings
#: (Hüslimatt's area holds seven of 7–14 m² beside its five houses); the object's own building
#: always counts, whatever its size
MIN_MEMBER_M2 = 30.0
#: the vector tiles' most detailed level (the source's maxzoom)
TILE_Z = 14
#: the buildings are asked for in the box around the area/parcel, never wider than this
MAX_SPAN_M = 700.0
#: objects asked per scheduler run, and how many at once
BATCH = 20
CONCURRENCY = 4
RETRY_S = 3600.0
TIMEOUT_S = 15.0
TICK_SECONDS = 120

_USER_AGENT = "kp-front (+https://github.com/feuerwehr-oberwil/kp-front)"

LngLat = tuple[float, float]
Ring = list[LngLat]
Polygon = list[Ring]  # [exterior, hole, …]


# --- geometry (WGS84 [lng, lat], small areas: an equirectangular metre scale is plenty) ---------


def _in_ring(r: Ring, p: LngLat) -> bool:
    x, y = p
    inside = False
    j = len(r) - 1
    for i in range(len(r)):
        x1, y1 = r[j]
        x2, y2 = r[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
        j = i
    return inside


def in_polygon(poly: Polygon, p: LngLat) -> bool:
    return bool(poly) and _in_ring(poly[0], p) and not any(_in_ring(h, p) for h in poly[1:])


def in_any(polys: list[Polygon], p: LngLat) -> bool:
    return any(in_polygon(q, p) for q in polys)


def ring_area_m2(r: Ring) -> float:
    if len(r) < 3:
        return 0.0
    lat0 = sum(p[1] for p in r) / len(r)
    kx = 111_320.0 * math.cos(math.radians(lat0))
    ky = 110_540.0
    s = 0.0
    for i in range(len(r)):
        x1, y1 = r[i - 1]
        x2, y2 = r[i]
        s += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
    return abs(s) / 2


def polygons_area_m2(polys: list[Polygon]) -> float:
    return sum(ring_area_m2(q[0]) - sum(ring_area_m2(h) for h in q[1:]) for q in polys if q)


def centroid(r: Ring) -> LngLat:
    """The area centroid (falls back to the vertex mean for a degenerate ring)."""
    a = cx = cy = 0.0
    for i in range(len(r)):
        x1, y1 = r[i - 1]
        x2, y2 = r[i]
        f = x1 * y2 - x2 * y1
        a += f
        cx += (x1 + x2) * f
        cy += (y1 + y2) * f
    if abs(a) < 1e-18:
        return (sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r))
    return (cx / (3 * a), cy / (3 * a))


def bbox_of(rings: list[Ring]) -> tuple[float, float, float, float] | None:
    """(west, south, east, north) around every vertex."""
    pts = [p for r in rings for p in r]
    if not pts:
        return None
    return (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))


# --- the rule -----------------------------------------------------------------------------------


@dataclass
class Facts:
    """What the official sources say at ONE coordinate — depends on nothing else, so it is kept
    across catalogue changes. ``area``/``parcel`` are None when there is none (or it could not
    count, e.g. a residential quarter); ``buildings`` are exterior rings."""

    area_class: str | None
    area: list[Polygon] | None
    parcel: list[Polygon] | None
    buildings: list[Ring]

    def to_json(self) -> dict:
        return {"areaClass": self.area_class, "area": self.area, "parcel": self.parcel, "buildings": self.buildings}

    @classmethod
    def from_json(cls, d: dict) -> Facts:
        def rings(v: Any) -> list[Ring]:
            return [[(float(p[0]), float(p[1])) for p in r] for r in v]

        return cls(
            area_class=d.get("areaClass"),
            area=[rings(q) for q in d["area"]] if d.get("area") else None,
            parcel=[rings(q) for q in d["parcel"]] if d.get("parcel") else None,
            buildings=rings(d.get("buildings") or []),
        )


def main_building(at: LngLat, buildings: list[Ring]) -> Ring | None:
    """The smallest building the point lies in (outlines can nest)."""
    best: Ring | None = None
    best_a = math.inf
    for b in buildings:
        if len(b) >= 3 and _in_ring(b, at):
            a = ring_area_m2(b)
            if a < best_a:
                best, best_a = b, a
    return best


def derive(at: LngLat, facts: Facts, others: list[LngLat]) -> tuple[str, list[Ring]] | None:
    """``(source, buildings)`` for an object at ``at`` — the building its point is in first —
    or None when official data has no building for it. ``others``: every OTHER station object's
    point (key boxes excluded); a step that holds one of them is not this object's alone."""
    main = main_building(at, facts.buildings)

    def members(polys: list[Polygon], max_m2: float) -> list[Ring] | None:
        if polygons_area_m2(polys) > max_m2 or any(in_any(polys, o) for o in others):
            return None
        inside = [
            b
            for b in facts.buildings
            if b is not main and ring_area_m2(b) >= MIN_MEMBER_M2 and in_any(polys, centroid(b))
        ]
        out = ([main] if main is not None else []) + inside
        return out if 1 <= len(out) <= MAX_BUILDINGS and (main is not None or len(out) > 1) else None

    if facts.area:
        got = members(facts.area, MAX_AREA_M2)
        if got:
            return ("area" if len(got) > 1 else "building", got)
    if facts.parcel:
        got = members(facts.parcel, MAX_PARCEL_M2)
        if got:
            return ("parcel" if len(got) > 1 else "building", got)
    return ("building", [main]) if main is not None else None


def as_geojson(rings: list[Ring]) -> dict:
    """The buildings as ONE MultiPolygon (closed rings), the object's own building first."""
    return {
        "type": "MultiPolygon",
        "coordinates": [[[[round(x, 7), round(y, 7)] for x, y in [*r, r[0]]]] for r in rings],
    }


# --- the sources --------------------------------------------------------------------------------


def _tile_xy(lng: float, lat: float, z: int = TILE_Z) -> tuple[int, int]:
    n = 2**z
    x = int((lng + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def _tile_to_lnglat(z: int, tx: int, ty: int, extent: int, px: float, py: float) -> LngLat:
    n = 2**z
    lng = (tx + px / extent) / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + py / extent) / n))))
    return (lng, lat)


class Sources:
    """The three asks, over one client. Tiles are kept for the run (neighbouring objects share
    them); everything else is one request per object."""

    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self.tiles: dict[tuple[int, int], dict[str, list[tuple[str, Polygon, bool]]]] = {}

    async def _tile_areas(self, tx: int, ty: int) -> list[tuple[str, Polygon, bool]]:
        """(class, polygon, reaches the tile edge) for every use area in one tile."""
        if (tx, ty) in self.tiles:
            return self.tiles[(tx, ty)]["landuse"]
        url = f"{settings.footprint_area_tiles.rstrip('/')}/{TILE_Z}/{tx}/{ty}.pbf"
        r = await self.client.get(url)
        out: list[tuple[str, Polygon, bool]] = []
        if r.status_code != 404:  # outside the coverage = no use areas
            r.raise_for_status()
            layer = mvt.read_layer(r.content, "landuse")
            for f in layer.features if layer else []:
                cls = str(f.properties.get("class") or "")
                ext = layer.extent if layer else 4096
                for poly in f.polygons:
                    edge = any(not (0 < x < ext and 0 < y < ext) for x, y in poly[0])
                    out.append(
                        (cls, [[_tile_to_lnglat(TILE_Z, tx, ty, ext, x, y) for x, y in ring] for ring in poly], edge)
                    )
        self.tiles[(tx, ty)] = {"landuse": out}
        return out

    async def area(self, lng: float, lat: float) -> tuple[str | None, list[Polygon] | None]:
        """The allowed use area the point lies in, as its pieces (a tile cuts an area at its edge;
        the piece in a neighbouring tile that overlaps it belongs to it)."""
        tx, ty = _tile_xy(lng, lat)
        # only the kinds that are one object's grounds (a pitch inside a school ground does not
        # hide the school), the smallest of them when they nest
        here = [
            (c, q, e) for c, q, e in await self._tile_areas(tx, ty) if c in AREA_CLASSES and in_polygon(q, (lng, lat))
        ]
        if not here:
            return None, None
        here.sort(key=lambda t: ring_area_m2(t[1][0]))
        cls, poly, edge = here[0]
        pieces = [poly]
        if edge:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if dx == dy == 0:
                        continue
                    for c, q, _e in await self._tile_areas(tx + dx, ty + dy):
                        if c == cls and (
                            any(in_polygon(poly, p) for p in q[0]) or any(in_polygon(q, p) for p in poly[0])
                        ):
                            pieces.append(q)
        return cls, pieces

    async def parcel(self, lng: float, lat: float) -> list[Polygon] | None:
        base = geocode._IDENTIFY_URL if geocode._GEOCODER_OK else None
        if not base:
            raise RuntimeError("no geocoder host")
        d = 0.0005
        r = await self.client.get(
            base,
            params={
                "geometry": f"{lng},{lat}",
                "geometryType": "esriGeometryPoint",
                "geometryFormat": "geojson",
                "sr": "4326",
                "tolerance": "0",
                "mapExtent": f"{lng - d},{lat - d},{lng + d},{lat + d}",
                "imageDisplay": "100,100,96",
                "layers": "all:ch.swisstopo-vd.amtliche-vermessung",
                "returnGeometry": "true",
                "lang": "de",
            },
        )
        r.raise_for_status()
        for res in r.json().get("results", []):
            polys = _geojson_polygons(res.get("geometry") or {})
            if polys and in_any(polys, (lng, lat)):
                return polys
        return None

    async def buildings(self, box: tuple[float, float, float, float]) -> list[Ring]:
        west, south, east, north = box
        flt = (
            '<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2">'
            "<fes:And><fes:PropertyIsEqualTo><fes:ValueReference>Art</fes:ValueReference>"
            "<fes:Literal>Gebaeude</fes:Literal></fes:PropertyIsEqualTo>"
            '<fes:BBOX><fes:ValueReference>geometry</fes:ValueReference><gml:Envelope srsName="urn:ogc:def:crs:EPSG::4326">'
            f"<gml:lowerCorner>{south:.7f} {west:.7f}</gml:lowerCorner><gml:upperCorner>{north:.7f} {east:.7f}</gml:upperCorner>"
            "</gml:Envelope></fes:BBOX></fes:And></fes:Filter>"
        )
        r = await self.client.get(
            settings.footprint_buildings_wfs,
            params={
                "SERVICE": "WFS",
                "VERSION": "2.0.0",
                "REQUEST": "GetFeature",
                "TYPENAMES": "ms:LCSF",
                "SRSNAME": "urn:ogc:def:crs:EPSG::4326",
                "OUTPUTFORMAT": "geojson",
                "COUNT": "500",
                "FILTER": flt,
            },
        )
        r.raise_for_status()
        out: list[Ring] = []
        for f in r.json().get("features", []):
            for poly in _geojson_polygons(f.get("geometry") or {}):
                out.append(poly[0])
        return out


def _geojson_polygons(g: dict) -> list[Polygon]:
    def ring(r: list) -> Ring:
        pts = [(float(p[0]), float(p[1])) for p in r]
        return pts[:-1] if len(pts) > 1 and pts[0] == pts[-1] else pts

    if g.get("type") == "Polygon":
        return [[ring(r) for r in g.get("coordinates") or []]]
    if g.get("type") == "MultiPolygon":
        return [[ring(r) for r in q] for q in g.get("coordinates") or []]
    return []


def _span_box(at: LngLat, polys: list[list[Polygon] | None]) -> tuple[float, float, float, float]:
    """The box to ask for buildings in: the area/parcel and ~40 m around the point, capped."""
    lng, lat = at
    pad_lat = 40 / 110_540
    pad_lng = 40 / (111_320 * math.cos(math.radians(lat)))
    rings: list[Ring] = [[(lng - pad_lng, lat - pad_lat), (lng + pad_lng, lat + pad_lat)]]
    for p in polys:
        for q in p or []:
            rings.append(q[0])
    w, s, e, n = bbox_of(rings) or (lng, lat, lng, lat)
    half_lat = MAX_SPAN_M / 2 / 110_540
    half_lng = MAX_SPAN_M / 2 / (111_320 * math.cos(math.radians(lat)))
    return (max(w, lng - half_lng), max(s, lat - half_lat), min(e, lng + half_lng), min(n, lat + half_lat))


async def ask(src: Sources, at: LngLat) -> Facts:
    """Everything the sources say at one point. Raises when any of them could not be asked — a
    half answer is never stored, it would read as «no area» / «no parcel» for good."""
    lng, lat = at
    cls, area = await src.area(lng, lat)
    if area is not None and polygons_area_m2(area) > MAX_AREA_M2:
        cls, area = cls, None  # a district: neither stored nor asked about
    parcel = await src.parcel(lng, lat)
    if parcel is not None and polygons_area_m2(parcel) > MAX_PARCEL_M2:
        parcel = None
    buildings = await src.buildings(_span_box(at, [area, parcel]))
    return Facts(area_class=cls if area else None, area=area, parcel=parcel, buildings=buildings)


# --- the store ----------------------------------------------------------------------------------


def enabled() -> bool:
    return bool(settings.footprint_area_tiles.strip() and settings.footprint_buildings_wfs.strip())


def _point_key(lat: float, lng: float) -> str:
    return f"{lat:.6f},{lng:.6f}"


def _load() -> dict:
    if not storage.exists(STORE_KEY):
        return {}
    try:
        data = json.loads(storage.get_bytes(STORE_KEY))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


_read: tuple[float, dict] | None = None
_READ_S = 60.0


def stored() -> dict[str, dict]:
    """object id → ``{"at": "<lat>,<lng>", "source": …, "footprint": GeoJSON}`` as last derived.
    Read from storage at most once a minute per process; never asks a source."""
    global _read
    now = time.monotonic()
    if _read and now - _read[0] < _READ_S:
        return _read[1].get("footprints", {})
    data = _load()
    _read = (now, data)
    return data.get("footprints", {})


def footprint_for(object_id: str, lat: float | None, lng: float | None) -> dict | None:
    """The stored footprint, only while the object still stands where it was derived for."""
    if lat is None or lng is None:
        return None
    hit = stored().get(object_id)
    if not hit or hit.get("at") != _point_key(lat, lng):
        return None
    return hit.get("footprint")


#: when a point's last ask failed — retried after RETRY_S, per process
_failed: dict[str, float] = {}


async def _station_points(db: AsyncSession) -> dict[str, LngLat]:
    """Every station object with a point, key boxes left out (they are no building's owner)."""
    from .api.station_reference import object_kind
    from .models import ObjectSite, ReferenceDataset
    from .object_visits import refs_by_object

    with_plans = set(
        (await db.execute(select(ReferenceDataset.object_id).where(ReferenceDataset.object_id.is_not(None)))).scalars()
    )
    refs = await refs_by_object(db)
    out: dict[str, LngLat] = {}
    for o in (
        await db.execute(select(ObjectSite).where(ObjectSite.lat.is_not(None), ObjectSite.lng.is_not(None)))
    ).scalars():
        if object_kind(o, o.id in with_plans, [r["source"] for r in refs.get(o.id, [])]) == "depot":
            continue
        out[str(o.id)] = (float(o.lng), float(o.lat))  # type: ignore[arg-type]
    return out


def derive_all(points: dict[str, LngLat], facts: dict[str, Facts]) -> dict[str, dict]:
    """Every object's footprint from the facts at hand (no network)."""
    out: dict[str, dict] = {}
    for oid, at in points.items():
        f = facts.get(_point_key(at[1], at[0]))
        if f is None:
            continue
        others = [p for k, p in points.items() if k != oid]
        got = derive(at, f, others)
        if got is not None:
            out[oid] = {"at": _point_key(at[1], at[0]), "source": got[0], "footprint": as_geojson(got[1])}
    return out


def _signature(points: dict[str, LngLat], facts_keys: set[str]) -> str:
    h = hashlib.sha256(f"{ALGO}|".encode())
    for oid in sorted(points):
        h.update(f"{oid}={_point_key(points[oid][1], points[oid][0])};".encode())
    h.update("|".join(sorted(facts_keys)).encode())
    return h.hexdigest()


async def tick(db: AsyncSession, *, client: httpx.AsyncClient | None = None) -> int:
    """Ask the sources for up to ``BATCH`` points not asked yet, then re-derive when anything
    changed. Returns how many points were asked. Idle (one query, one small file read) once
    every object has its facts."""
    global _read
    if not enabled():
        return 0
    points = await _station_points(db)
    data = _load()
    facts = {k: Facts.from_json(v) for k, v in (data.get("facts") or {}).items()}
    now = time.monotonic()
    todo = [
        at
        for at in {_point_key(p[1], p[0]): p for p in points.values()}.values()
        if _point_key(at[1], at[0]) not in facts and now - _failed.get(_point_key(at[1], at[0]), -math.inf) > RETRY_S
    ][:BATCH]
    asked = 0
    if todo:
        own = client is None
        cli = client or httpx.AsyncClient(timeout=TIMEOUT_S, headers={"User-Agent": _USER_AGENT})
        src = Sources(cli)
        sem = asyncio.Semaphore(CONCURRENCY)

        async def one(at: LngLat) -> None:
            nonlocal asked
            key = _point_key(at[1], at[0])
            async with sem:
                try:
                    facts[key] = await ask(src, at)
                    asked += 1
                except (httpx.HTTPError, ValueError, KeyError, TypeError, RuntimeError) as e:
                    _failed[key] = time.monotonic()
                    logger.warning("object footprint: could not ask the sources at %s: %s", key, e)

        try:
            # sequential tiles are fine: they are cached in `src` and shared between the points
            await asyncio.gather(*(one(at) for at in todo))
        finally:
            if own:
                await cli.aclose()
    # facts for points no object stands on any more are dropped
    live = {_point_key(p[1], p[0]) for p in points.values()}
    facts = {k: v for k, v in facts.items() if k in live}
    sig = _signature(points, set(facts))
    if sig == data.get("sig") and not asked:
        return 0
    out = {
        "version": ALGO,
        "sig": sig,
        "derivedAt": datetime.now(UTC).isoformat(),
        "facts": {k: v.to_json() for k, v in facts.items()},
        "footprints": derive_all(points, facts),
    }
    await asyncio.to_thread(storage.put_bytes, STORE_KEY, json.dumps(out, separators=(",", ":")).encode())
    _read = None
    logger.info("object footprints: %d asked, %d objects with buildings", asked, len(out["footprints"]))
    return asked


def clear_cache() -> None:
    global _read
    _read = None
    _failed.clear()

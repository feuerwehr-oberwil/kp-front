"""Every building a station object stands for (`app/object_footprints.py`, review 17.10.2026).

The rule runs on synthetic polygons (metres around a made-up point); the three sources run
against an httpx MockTransport serving a hand-encoded vector tile, an identify answer and a WFS
answer — nothing leaves the machine. The end-to-end case goes through the scheduler's tick into
`GET /api/reference/objects`.
"""

from __future__ import annotations

import json
import math
import uuid

import httpx
import pytest

from app import mvt, storage
from app import object_footprints as of
from app.models import ObjectRef, ObjectSite
from tests.test_building_facts import _login

ORIGIN = (7.5700, 47.5200)  # lng, lat — a field somewhere, synthetic
KX = 111_320.0 * math.cos(math.radians(ORIGIN[1]))
KY = 110_540.0


def at(e: float, n: float) -> tuple[float, float]:
    """A point `e` m east and `n` m north of ORIGIN."""
    return (ORIGIN[0] + e / KX, ORIGIN[1] + n / KY)


def box(e0: float, n0: float, e1: float, n1: float) -> list[tuple[float, float]]:
    return [at(e0, n0), at(e1, n0), at(e1, n1), at(e0, n1)]


@pytest.fixture(autouse=True)
def _fresh():
    def wipe():
        of.clear_cache()
        if storage.exists(of.STORE_KEY):
            storage.delete(of.STORE_KEY)

    wipe()
    yield
    wipe()


# --- the rule -------------------------------------------------------------------------------------

SCHOOL = box(0, 0, 200, 150)  # 30 000 m² of school ground
HOUSE = box(10, 10, 40, 40)  # the object's own building (its point is in here)
GYM = box(100, 20, 150, 60)
HALL = box(60, 90, 120, 130)
SHED = box(170, 10, 174, 14)  # 16 m² — no building of the object's
NEIGHBOUR = box(220, 10, 260, 40)  # outside the ground
POINT = at(20, 20)


def facts(**kw) -> of.Facts:
    base = {
        "area_class": "school",
        "area": [[SCHOOL]],
        "parcel": [[box(0, 0, 50, 50)]],
        "buildings": [HOUSE, GYM, HALL, SHED, NEIGHBOUR],
    }
    base.update(kw)
    return of.Facts(**base)


def test_a_campus_is_every_building_on_its_ground_its_own_first():
    source, rings = of.derive(POINT, facts(), others=[])
    assert source == "area"
    assert rings[0] is HOUSE  # the tag hangs off the building the point is in
    assert {id(r) for r in rings} == {id(HOUSE), id(GYM), id(HALL)}  # no shed, no neighbour


def test_another_objects_point_on_the_ground_steps_down_to_the_parcel():
    # the gym is a catalogue object of its own: the ground is shared, so neither claims it
    source, rings = of.derive(POINT, facts(), others=[at(120, 40)])
    assert (source, rings) == ("building", [HOUSE])  # the parcel holds only the house
    two = facts(parcel=[[box(0, 0, 160, 80)]])
    assert of.derive(POINT, two, others=[at(120, 120)]) == ("parcel", [HOUSE, GYM])


def test_too_big_or_too_many_falls_back():
    huge = facts(area=[[box(0, 0, 500, 400)]], parcel=None)  # 200 000 m²: a district
    assert of.derive(POINT, huge, others=[]) == ("building", [HOUSE])
    huts = [box(60 + 6 * i, 100, 65 + 6 * i, 108) for i in range(16)]  # 16 × 40 m² garden huts
    many = facts(buildings=[HOUSE, *huts], parcel=None)
    assert of.derive(POINT, many, others=[]) == ("building", [HOUSE])


def test_no_area_takes_the_parcel_and_no_parcel_the_building():
    assert of.derive(POINT, facts(area=None, parcel=[[box(0, 0, 160, 80)]]), others=[]) == ("parcel", [HOUSE, GYM])
    assert of.derive(POINT, facts(area=None, parcel=None), others=[]) == ("building", [HOUSE])


def test_a_point_in_no_building_is_nothing_unless_its_ground_says_so():
    yard = at(80, 70)  # on the school yard, in no building
    source, rings = of.derive(yard, facts(), others=[])
    assert source == "area" and len(rings) == 3
    # but a parcel with a single building is not «this object's» by proximity
    alone = facts(area=None, parcel=[[box(0, 0, 50, 50)]])
    assert of.derive(at(45, 45), alone, others=[]) is None


def test_a_hole_in_the_ground_is_not_the_ground():
    holed = facts(area=[[SCHOOL, box(90, 10, 160, 70)]], parcel=None)  # the gym's plot is cut out
    _, rings = of.derive(POINT, holed, others=[])
    assert GYM not in rings and HALL in rings


def test_geojson_is_one_multipolygon_with_closed_rings():
    g = of.as_geojson([HOUSE, GYM])
    assert g["type"] == "MultiPolygon" and len(g["coordinates"]) == 2
    ring = g["coordinates"][0][0]
    assert ring[0] == ring[-1] and len(ring) == 5


# --- the vector tile ------------------------------------------------------------------------------


def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _field(num: int, payload: bytes) -> bytes:
    return _varint(num << 3 | 2) + _varint(len(payload)) + payload


def _vfield(num: int, v: int) -> bytes:
    return _varint(num << 3) + _varint(v)


def _zz(n: int) -> int:
    return (n << 1) ^ (n >> 31)


def _geom(rings: list[list[tuple[int, int]]]) -> list[int]:
    out: list[int] = []
    cx = cy = 0
    for r in rings:
        x, y = r[0]
        out += [1 | 1 << 3, _zz(x - cx), _zz(y - cy)]
        cx, cy = x, y
        out.append(2 | (len(r) - 1) << 3)
        for x, y in r[1:]:
            out += [_zz(x - cx), _zz(y - cy)]
            cx, cy = x, y
        out.append(7 | 1 << 3)
    return out


def encode_tile(features: list[tuple[str, list[list[tuple[int, int]]]]], extent: int = 4096) -> bytes:
    """A one-layer `landuse` tile: (class, rings in tile coordinates) per feature."""
    classes = sorted({c for c, _ in features})
    layer = _field(1, b"landuse") + _vfield(15, 2) + _vfield(5, extent) + _field(3, b"class")
    for c in classes:
        layer += _field(4, _field(1, c.encode()))
    for c, rings in features:
        tags = _varint(0) + _varint(classes.index(c))
        geom = b"".join(_varint(v) for v in _geom(rings))
        layer += _field(2, _field(2, tags) + _vfield(3, 3) + _field(4, geom))
    return _field(3, layer)


def test_the_tile_reader_keeps_classes_rings_and_holes():
    # exterior clockwise in tile coordinates (y down) = positive area; the hole runs the other way
    outer = [(100, 100), (400, 100), (400, 400), (100, 400)]
    hole = [(200, 200), (200, 300), (300, 300), (300, 200)]
    data = encode_tile([("school", [outer, hole]), ("parking", [[(0, 0), (50, 0), (50, 50), (0, 50)]])])
    layer = mvt.read_layer(data, "landuse")
    assert layer is not None and layer.extent == 4096
    school = next(f for f in layer.features if f.properties["class"] == "school")
    assert len(school.polygons) == 1 and len(school.polygons[0]) == 2  # one polygon with its hole
    assert school.polygons[0][0] == outer
    assert mvt.read_layer(data, "building") is None


# --- the sources, end to end through the tick -----------------------------------------------------


def _tile_coords(p: tuple[float, float]) -> tuple[int, int, int, int]:
    """(tile x, tile y, px, py) of a point at z14, extent 4096."""
    n = 2**of.TILE_Z
    fx = (p[0] + 180) / 360 * n
    fy = (1 - math.asinh(math.tan(math.radians(p[1]))) / math.pi) / 2 * n
    return int(fx), int(fy), round((fx - int(fx)) * 4096), round((fy - int(fy)) * 4096)


def _sources(monkeypatch, *, wfs_down: bool = False) -> dict[str, int]:
    calls = {"tile": 0, "identify": 0, "wfs": 0}
    ring_px = []
    for p in SCHOOL:
        tx, ty, px, py = _tile_coords(p)
        ring_px.append((px, py))
    # tile coordinates have y down: the SCHOOL ring (counter-clockwise in lng/lat) becomes clockwise
    tile = encode_tile([("school", [ring_px])])
    tx, ty, *_ = _tile_coords(POINT)

    def gj(rings):
        return {"type": "Polygon", "coordinates": [[list(p) for p in [*r, r[0]]] for r in rings]}

    async def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith(".pbf"):
            calls["tile"] += 1
            return httpx.Response(200, content=tile) if f"/14/{tx}/{ty}.pbf" in url else httpx.Response(404)
        if request.url.path.endswith("/identify"):
            calls["identify"] += 1
            assert request.url.params["layers"] == "all:ch.swisstopo-vd.amtliche-vermessung"
            return httpx.Response(200, json={"results": [{"geometry": gj([box(0, 0, 50, 50)])}]})
        if "geodienste" in url:
            calls["wfs"] += 1
            if wfs_down:
                return httpx.Response(503)
            assert request.url.params["TYPENAMES"] == "ms:LCSF" and "Gebaeude" in request.url.params["FILTER"]
            return httpx.Response(
                200,
                json={"features": [{"geometry": gj([r])} for r in (HOUSE, GYM, HALL, SHED, NEIGHBOUR)]},
            )
        return httpx.Response(404)

    orig_init = httpx.AsyncClient.__init__
    transport = httpx.MockTransport(handler)

    def patched_init(self, *args, **kwargs):
        kwargs["transport"] = transport
        orig_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)
    monkeypatch.setattr(of.geocode, "_GEOCODER_OK", True)
    return calls


async def _objects(db) -> dict[str, ObjectSite]:
    school = ObjectSite(id=uuid.uuid4(), name="Schulhaus Feld", address="Feldweg 1", lat=POINT[1], lng=POINT[0])
    depot = ObjectSite(
        id=uuid.uuid4(), name="Schlüsseldepot Feld", address="Feldweg 1", lat=at(30, 5)[1], lng=at(30, 5)[0]
    )
    db.add_all([school, depot])
    await db.flush()
    db.add(ObjectRef(object_id=depot.id, source="fwo-schlue", external_id="k-1"))
    await db.commit()
    return {"school": school, "depot": depot}


async def test_the_tick_asks_once_and_the_catalogue_carries_the_buildings(client, db_session, editor, monkeypatch):
    calls = _sources(monkeypatch)
    objs = await _objects(db_session)
    assert await of.tick(db_session) == 1  # one point asked: the key box is no building's owner
    assert calls["identify"] == 1 and calls["wfs"] == 1
    stored = json.loads(storage.get_bytes(of.STORE_KEY))
    assert stored["footprints"][str(objs["school"].id)]["source"] == "area"

    await _login(client, editor)
    body = (await client.get("/api/reference/objects")).json()
    by = {o["name"]: o for o in body["objects"]}
    fp = by["Schulhaus Feld"]["footprint"]
    assert fp["type"] == "MultiPolygon" and len(fp["coordinates"]) == 3  # house, gym, hall
    assert by["Schlüsseldepot Feld"]["footprint"] is None

    # idle: a second tick asks nobody
    assert await of.tick(db_session) == 0
    assert calls["identify"] == 1

    # the object moved: its old buildings are not shown while the new point is unasked
    objs["school"].lat, objs["school"].lng = at(500, 500)[1], at(500, 500)[0]
    await db_session.commit()
    of.clear_cache()
    body = (await client.get("/api/reference/objects")).json()
    assert {o["name"]: o for o in body["objects"]}["Schulhaus Feld"]["footprint"] is None


async def test_a_failed_source_is_never_stored_as_nothing(db_session, monkeypatch):
    calls = _sources(monkeypatch, wfs_down=True)
    await _objects(db_session)
    assert await of.tick(db_session) == 0
    assert calls["wfs"] == 1
    stored = json.loads(storage.get_bytes(of.STORE_KEY)) if storage.exists(of.STORE_KEY) else {}
    assert not stored.get("facts")
    # and it is not asked again on the next tick (an hour's pause), so a down source is not hammered
    await of.tick(db_session)
    assert calls["wfs"] == 1


async def test_off_when_a_source_is_unset(db_session, monkeypatch):
    calls = _sources(monkeypatch)
    monkeypatch.setattr(of.settings, "footprint_buildings_wfs", "")
    await _objects(db_session)
    assert await of.tick(db_session) == 0
    assert calls == {"tile": 0, "identify": 0, "wfs": 0}

"""«Unterirdische Bauten» (`app/underground.py`, review round 4, 17.10.2026; area and tunnels per
the owner's answers on #383).

The survey WFS and swisstopo's municipality service are an httpx MockTransport serving synthetic
squares — nothing leaves the machine. The end-to-end case goes through the tick into
`GET /api/reference/underground`.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app import storage
from app import underground as ug
from app.models import DeploymentConfig, ObjectSite
from tests.test_building_facts import _login

ORIGIN = (7.5700, 47.5200)  # lng, lat — a field somewhere, synthetic
KX = 111_320.0 * 0.6756
KY = 110_540.0


def at(e: float, n: float) -> tuple[float, float]:
    """A point `e` m east and `n` m north of ORIGIN."""
    return (ORIGIN[0] + e / KX, ORIGIN[1] + n / KY)


def square(e: float, n: float, side: float = 20.0) -> list[list[float]]:
    pts = [at(e, n), at(e + side, n), at(e + side, n + side), at(e, n + side)]
    return [list(p) for p in [*pts, pts[0]]]


def feature(ring: list[list[float]], art: str = "unterirdisches_Gebaeude") -> dict:
    return {"type": "Feature", "properties": {"Art": art}, "geometry": {"type": "Polygon", "coordinates": [ring]}}


#: the synthetic municipality 9999: a 2 × 2 km square from ORIGIN
TOWN = [list(p) for p in [at(0, 0), at(2000, 0), at(2000, 2000), at(0, 2000), at(0, 0)]]


def _bbox_of(flt: str) -> tuple[float, float, float, float]:
    lower = flt.split("<gml:lowerCorner>")[1].split("<")[0].split()
    upper = flt.split("<gml:upperCorner>")[1].split("<")[0].split()
    return (float(lower[1]), float(lower[0]), float(upper[1]), float(upper[0]))


class Sources:
    """The WFS (every cell gets the features whose first corner lies in it) and swisstopo's
    municipalities (one: 9999, the square TOWN)."""

    def __init__(self, features: list[dict], *, down: bool = False):
        self.features = features
        self.down = down
        self.wfs = 0
        self.identify = 0
        self.boundary = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        p = request.url.params
        if request.url.path.endswith("/identify"):
            self.identify += 1
            assert p["layers"] == f"all:{ug.MUNICIPALITY_LAYER}"
            return httpx.Response(
                200,
                json={
                    "results": [
                        {"attributes": {"gde_nr": 1234, "is_current_jahr": False}},  # the 1850 one
                        {"attributes": {"gde_nr": 9999, "is_current_jahr": True}},
                    ]
                },
            )
        if ug.MUNICIPALITY_LAYER in request.url.path:
            self.boundary += 1
            if not request.url.path.endswith("/9999"):
                return httpx.Response(404)
            return httpx.Response(
                200, json={"feature": {"geometry": {"type": "MultiPolygon", "coordinates": [[TOWN]]}}}
            )
        self.wfs += 1
        if self.down:
            return httpx.Response(503)
        assert p["TYPENAMES"] == "ms:SOSF"
        assert all(a in p["FILTER"] for a in ug.ARTS)
        w, s, e, n = _bbox_of(p["FILTER"])
        hit = [
            f
            for f in self.features
            if w <= f["geometry"]["coordinates"][0][0][0] <= e and s <= f["geometry"]["coordinates"][0][0][1] <= n
        ]
        return httpx.Response(200, json={"type": "FeatureCollection", "features": hit[: int(p["COUNT"])]})

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    # this test's own storage root: under xdist the workers share `data/storage`, and another
    # worker's scheduler test wrote a real `underground.json` between the wipe and the assert
    # (test_not_asked_yet_says_so failed only under `-n`, review round 6)
    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))
    monkeypatch.setattr(ug.settings, "underground_wfs", "https://geodienste.ch/db/av_0/deu")
    monkeypatch.setattr(ug.geocode, "_GEOCODER_OK", True)

    def wipe():
        ug.clear_cache()
        if storage.exists(ug.STORE_KEY):
            storage.delete(ug.STORE_KEY)

    wipe()
    yield
    wipe()


async def _config(db, **map_cfg) -> None:
    row = (await db.get(DeploymentConfig, 1)) or DeploymentConfig(id=1, config_json={})
    row.config_json = {"map": map_cfg}
    db.add(row)
    await db.commit()


async def _object(db, e: float, n: float, name: str = "Objekt") -> None:
    lng, lat = at(e, n)
    db.add(ObjectSite(id=uuid.uuid4(), name=name, lat=lat, lng=lng))
    await db.commit()


# --- the area -------------------------------------------------------------------------------------

# inside the town · the town's edge, a corner inside · outside the town, near no object ·
# outside, beside the object in the next village · a tunnel inside · a wall inside
INSIDE = feature(square(500, 500))
EDGE = feature(square(1990, 1000))
AWAY = feature(square(4000, 4000))
NEAR_ARA = feature(square(3050, 300))
TUNNEL = feature(square(800, 1500, 60), art="Tunnel_Unterfuehrung_Galerie")
WALL = feature(square(900, 900), art="Mauer")
ALL = [INSIDE, EDGE, AWAY, NEAR_ARA, TUNNEL, WALL]


async def test_nothing_to_go_by_asks_nothing(db_session):
    assert await ug.station_area(db_session) is None
    sources = Sources(ALL)
    async with sources.client() as c:
        assert await ug.tick(db_session, client=c) == 0
    assert sources.wfs == 0


async def test_the_einsatzgebiet_is_the_map_centres_municipality_plus_every_objects_surroundings(db_session):
    await _config(db_session, defaultView={"center": list(at(1000, 1000)), "zoom": 16})
    await _object(db_session, 1000, 1000, "Schulhaus")  # in the town
    await _object(db_session, 3000, 300, "ARA")  # in the next village
    sources = Sources(ALL)
    async with sources.client() as c:
        assert await ug.tick(db_session, client=c) == 4  # inside, edge, near the ARA, the tunnel
    assert sources.identify == 1 and sources.boundary == 1
    data = json.loads(storage.get_bytes(ug.STORE_KEY))
    assert data["municipalities"] == [9999]
    firsts = {tuple(p[0][0]) for p in data["geometry"]["coordinates"]}

    def first(f: dict) -> tuple[float, float]:
        return tuple(round(v, ug.DECIMALS) for v in f["geometry"]["coordinates"][0][0])

    assert {first(INSIDE), first(EDGE), first(NEAR_ARA), first(TUNNEL)} == firsts


async def test_named_municipalities_win_over_the_map_centre(db_session):
    await _config(db_session, defaultView={"center": list(at(1000, 1000))}, serviceArea={"municipalities": [9999]})
    sources = Sources(ALL)
    async with sources.client() as c:
        assert await ug.tick(db_session, client=c) == 3  # inside, edge, tunnel — no objects
    assert sources.identify == 0


async def test_without_a_municipality_only_the_objects_surroundings(db_session):
    await _object(db_session, 3000, 300, "ARA")
    sources = Sources(ALL)
    async with sources.client() as c:
        assert await ug.tick(db_session, client=c) == 1
    assert sources.boundary == 0


async def test_fetch_keeps_each_structure_once_and_splits_full_cells(monkeypatch):
    area = ug.Area([9999], None, [], [[[tuple(p) for p in TOWN[:-1]]]])  # [polygon[ring]]
    sources = Sources([INSIDE, INSIDE, EDGE, WALL])
    monkeypatch.setattr(ug, "CELL_COUNT", 2)
    async with sources.client() as c:
        rings = await ug.fetch(c, area)
    assert len(rings) == 2  # INSIDE once, EDGE; the wall the filter let through is not drawn
    assert sources.wfs > 1
    gj = ug.as_geojson(rings)
    assert gj["type"] == "MultiPolygon" and gj["coordinates"][0][0][0] == gj["coordinates"][0][0][-1]


def test_an_object_inside_the_municipalities_is_not_asked_twice():
    town = [[tuple(p) for p in TOWN[:-1]]]  # one polygon: its outer ring
    area = ug.Area([9999], None, [at(1000, 1000), at(3000, 300)], [town])
    boxes = ug.boxes_to_ask(area)
    assert len(boxes) == 2  # the town's box + the ARA's surroundings


# --- the store and the endpoint -------------------------------------------------------------------


async def test_the_tick_stores_once_and_the_endpoint_serves_it(client, db_session, editor):
    await _object(db_session, 500, 500)
    sources = Sources([INSIDE, feature(square(520, 480))])
    async with sources.client() as c:
        assert await ug.tick(db_session, client=c) == 2
        asked = sources.wfs
        assert await ug.tick(db_session, client=c) == 0  # idle: fresh, same area, same source
        assert sources.wfs == asked
        await _object(db_session, 3000, 300, "ARA")  # the area changed: asked again
        assert await ug.tick(db_session, client=c) == 2

    await _login(client, editor)
    body = (await client.get("/api/reference/underground")).json()
    assert body["enabled"] is True and body["count"] == 2
    assert body["geometry"]["type"] == "MultiPolygon" and len(body["geometry"]["coordinates"]) == 2
    again = (await client.get("/api/reference/underground", params={"have": body["fetchedAt"]})).json()
    assert again == {"enabled": True, "fetchedAt": body["fetchedAt"], "count": 2, "unchanged": True}


async def test_a_week_old_set_is_asked_again(db_session):
    await _object(db_session, 500, 500)
    sources = Sources([INSIDE])
    async with sources.client() as c:
        await ug.tick(db_session, client=c)
        data = json.loads(storage.get_bytes(ug.STORE_KEY))
        data["fetchedAt"] = (datetime.now(UTC) - timedelta(seconds=ug.REFRESH_S + 60)).isoformat()
        storage.put_bytes(ug.STORE_KEY, json.dumps(data).encode())
        sources.features.append(feature(square(540, 540)))
        assert await ug.tick(db_session, client=c) == 2


async def test_a_failed_ask_keeps_the_stored_set_and_waits(db_session):
    await _object(db_session, 500, 500)
    async with Sources([INSIDE]).client() as c:
        await ug.tick(db_session, client=c)
    data = json.loads(storage.get_bytes(ug.STORE_KEY))
    data["fetchedAt"] = (datetime.now(UTC) - timedelta(days=30)).isoformat()
    storage.put_bytes(ug.STORE_KEY, json.dumps(data).encode())
    down = Sources([], down=True)
    async with down.client() as c:
        assert await ug.tick(db_session, client=c) == 0
        assert json.loads(storage.get_bytes(ug.STORE_KEY))["count"] == 1  # never stored as «nothing»
        calls = down.wfs
        assert await ug.tick(db_session, client=c) == 0  # an hour's pause: a down source is not hammered
        assert down.wfs == calls


async def test_off_when_the_setting_is_empty(client, db_session, editor, monkeypatch):
    monkeypatch.setattr(ug.settings, "underground_wfs", "")
    await _object(db_session, 500, 500)
    sources = Sources([INSIDE])
    async with sources.client() as c:
        assert await ug.tick(db_session, client=c) == 0
    assert sources.wfs == 0
    await _login(client, editor)
    assert (await client.get("/api/reference/underground")).json() == {"enabled": False}


async def test_not_asked_yet_says_so(client, editor):
    await _login(client, editor)
    assert (await client.get("/api/reference/underground")).json() == {"enabled": True, "fetchedAt": None, "count": 0}

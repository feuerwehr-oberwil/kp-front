"""«Unterirdische Bauten» (`app/underground.py`, review round 4, 17.10.2026).

The survey WFS is an httpx MockTransport serving synthetic squares — nothing leaves the machine.
The end-to-end case goes through the tick into `GET /api/reference/underground`.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app import storage
from app import underground as ug
from app.models import ObjectSite
from tests.test_building_facts import _login

# a synthetic region of 4 × 3 km in LV95 (the Jura foothills south of Basel)
REGION = "2600000,1250000,2604000,1253000"


def square(lng: float, lat: float, d: float = 0.0002) -> list[list[float]]:
    return [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]


def feature(ring: list[list[float]], art: str = ug.ART) -> dict:
    return {"type": "Feature", "properties": {"Art": art}, "geometry": {"type": "Polygon", "coordinates": [ring]}}


def _bbox_of(flt: str) -> tuple[float, float, float, float]:
    lower = flt.split("<gml:lowerCorner>")[1].split("<")[0].split()
    upper = flt.split("<gml:upperCorner>")[1].split("<")[0].split()
    return (float(lower[1]), float(lower[0]), float(upper[1]), float(upper[0]))


class Survey:
    """The WFS: answers every cell with the features whose first corner lies in it — and one that
    straddles every cell (a garage on a cell edge is returned twice and kept once)."""

    def __init__(self, features: list[dict], *, down: bool = False):
        self.features = features
        self.down = down
        self.calls = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.down:
            return httpx.Response(503)
        p = request.url.params
        assert p["TYPENAMES"] == "ms:SOSF" and ug.ART in p["FILTER"]
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
def _fresh(monkeypatch):
    monkeypatch.setattr(ug.settings, "geocoder_bbox_lv95", REGION)
    monkeypatch.setattr(ug.settings, "underground_wfs", "https://geodienste.ch/db/av_0/deu")

    def wipe():
        ug.clear_cache()
        if storage.exists(ug.STORE_KEY):
            storage.delete(ug.STORE_KEY)

    wipe()
    yield
    wipe()


def region() -> tuple[float, float, float, float]:
    box = ug.parse_lv95_box(REGION)
    assert box is not None
    return box


def inside(fx: float, fy: float) -> tuple[float, float]:
    w, s, e, n = region()
    return (w + (e - w) * fx, s + (n - s) * fy)


# --- the area -------------------------------------------------------------------------------------


def test_the_region_box_is_read_from_lv95():
    w, s, e, n = region()
    assert 7.43 < w < e < 7.50 and 47.40 < s < n < 47.46
    width, height = ug.box_size_m((w, s, e, n))
    assert 3900 < width < 4100 and 2900 < height < 3100
    assert ug.parse_lv95_box("not,a,box") is None
    assert ug.parse_lv95_box("2604000,1250000,2600000,1253000") is None  # min > max


def test_cells_cover_the_box_without_gaps():
    box = region()
    cs = ug.cells(box, 1500.0)
    assert len(cs) == 3 * 2  # 4 km → 3 columns, 3 km → 2 rows
    assert min(c[0] for c in cs) == box[0] and max(c[2] for c in cs) == pytest.approx(box[2])
    assert sum((c[2] - c[0]) * (c[3] - c[1]) for c in cs) == pytest.approx((box[2] - box[0]) * (box[3] - box[1]))
    assert len(ug.quarter(cs[0])) == 4


async def test_without_a_region_the_objects_set_the_area(db_session, monkeypatch):
    monkeypatch.setattr(ug.settings, "geocoder_bbox_lv95", "")
    assert await ug.region_box(db_session) is None  # nothing to go by: nothing asked
    db_session.add(ObjectSite(id=uuid.uuid4(), name="Schulhaus Feld", lat=47.52, lng=7.57))
    await db_session.commit()
    w, s, e, n = await ug.region_box(db_session)
    assert w < 7.57 < e and s < 47.52 < n
    width, _ = ug.box_size_m((w, s, e, n))
    assert width == pytest.approx(2 * ug.REACH_M, rel=0.01)


# --- the ask --------------------------------------------------------------------------------------


async def test_fetch_keeps_underground_buildings_once_and_splits_full_cells(monkeypatch):
    a = square(*inside(0.2, 0.2))
    b = square(*inside(0.8, 0.7))
    wall = square(*inside(0.5, 0.5))
    survey = Survey([feature(a), feature(a), feature(b), feature(wall, art="Mauer")])
    monkeypatch.setattr(ug, "CELL_COUNT", 2)
    async with survey.client() as c:
        rings = await ug.fetch(c, region())
    # a twice in its cell (a full cell → split) and kept once; the wall the filter let through is not
    assert len(rings) == 2
    assert survey.calls > len(ug.cells(region()))
    gj = ug.as_geojson(rings)
    assert gj["type"] == "MultiPolygon" and gj["coordinates"][0][0][0] == gj["coordinates"][0][0][-1]


async def test_the_tick_stores_once_and_the_endpoint_serves_it(client, db_session, editor):
    survey = Survey([feature(square(*inside(0.3, 0.3))), feature(square(*inside(0.6, 0.4)))])
    async with survey.client() as c:
        assert await ug.tick(db_session, client=c) == 2
        asked = survey.calls
        # idle: the set is fresh, for this area and this source
        assert await ug.tick(db_session, client=c) == 0
        assert survey.calls == asked

    await _login(client, editor)
    body = (await client.get("/api/reference/underground")).json()
    assert body["enabled"] is True and body["count"] == 2
    assert body["geometry"]["type"] == "MultiPolygon" and len(body["geometry"]["coordinates"]) == 2
    # the device that holds this set gets no geometry back
    again = (await client.get("/api/reference/underground", params={"have": body["fetchedAt"]})).json()
    assert again == {"enabled": True, "fetchedAt": body["fetchedAt"], "count": 2, "unchanged": True}


async def test_a_week_old_set_is_asked_again(db_session):
    survey = Survey([feature(square(*inside(0.3, 0.3)))])
    async with survey.client() as c:
        await ug.tick(db_session, client=c)
        data = json.loads(storage.get_bytes(ug.STORE_KEY))
        data["fetchedAt"] = (datetime.now(UTC) - timedelta(seconds=ug.REFRESH_S + 60)).isoformat()
        storage.put_bytes(ug.STORE_KEY, json.dumps(data).encode())
        survey.features.append(feature(square(*inside(0.7, 0.7))))
        assert await ug.tick(db_session, client=c) == 2


async def test_a_failed_ask_keeps_the_stored_set_and_waits(db_session):
    async with Survey([feature(square(*inside(0.3, 0.3)))]).client() as c:
        await ug.tick(db_session, client=c)
    before = storage.get_bytes(ug.STORE_KEY)
    data = json.loads(before)
    data["fetchedAt"] = (datetime.now(UTC) - timedelta(days=30)).isoformat()
    storage.put_bytes(ug.STORE_KEY, json.dumps(data).encode())
    down = Survey([], down=True)
    async with down.client() as c:
        assert await ug.tick(db_session, client=c) == 0
        assert json.loads(storage.get_bytes(ug.STORE_KEY))["count"] == 1  # never stored as «nothing»
        calls = down.calls
        assert await ug.tick(db_session, client=c) == 0  # an hour's pause: a down source is not hammered
        assert down.calls == calls


async def test_off_when_the_setting_is_empty(client, db_session, editor, monkeypatch):
    monkeypatch.setattr(ug.settings, "underground_wfs", "")
    survey = Survey([feature(square(*inside(0.3, 0.3)))])
    async with survey.client() as c:
        assert await ug.tick(db_session, client=c) == 0
    assert survey.calls == 0
    await _login(client, editor)
    assert (await client.get("/api/reference/underground")).json() == {"enabled": False}


async def test_not_asked_yet_says_so(client, editor):
    await _login(client, editor)
    assert (await client.get("/api/reference/underground")).json() == {"enabled": True, "fetchedAt": None, "count": 0}


async def test_a_region_too_big_for_one_brigade_is_not_asked(db_session, monkeypatch):
    monkeypatch.setattr(ug.settings, "geocoder_bbox_lv95", "2480000,1070000,2840000,1300000")  # all of CH
    survey = Survey([])
    async with survey.client() as c:
        assert await ug.tick(db_session, client=c) == 0
    assert survey.calls == 0

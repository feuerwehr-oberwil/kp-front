"""The Einsatzgebiet's houses (`app/houses.py`, Karte Haus round 1, 19.10.2026): one cadastral
footprint per house, so a tap on Storchenweg 4 is not OSM's block of 2/4/6.

The area, the cells and the store are app/underground's (tests/test_underground covers them);
here: the survey layer asked, what is kept, and the endpoint. An httpx MockTransport serves
synthetic squares — nothing leaves the machine.
"""

from __future__ import annotations

import httpx
import pytest

from app import houses, storage
from tests.test_building_facts import _login
from tests.test_underground import _object, square


def feature(ring: list[list[float]], art: str = "Gebaeude") -> dict:
    return {
        "type": "Feature",
        "properties": {"Art": art, "GWR_EGID": "1"},
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }


# a terraced row: three houses wall to wall (OSM has them as one) · a garden the filter let through
ROW = [feature(square(500 + 10 * i, 500, 10)) for i in range(3)]
GARDEN = feature(square(500, 520), art="Gartenanlage")


class Survey:
    def __init__(self, features: list[dict]):
        self.features = features
        self.asked: list[httpx.QueryParams] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.asked.append(request.url.params)
        return httpx.Response(200, json={"type": "FeatureCollection", "features": self.features})

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))
    monkeypatch.setattr(houses.settings, "houses_wfs", "https://geodienste.ch/db/av_0/deu")
    houses.clear_cache()
    yield
    houses.clear_cache()


async def test_every_house_of_a_terraced_row_is_kept_apart_and_served(client, db_session, editor):
    await _object(db_session, 510, 505)
    survey = Survey([*ROW, GARDEN])
    async with survey.client() as c:
        assert await houses.tick(db_session, client=c) == 3  # three houses, not one block; no garden
        assert await houses.tick(db_session, client=c) == 0  # fresh: idle
    p = survey.asked[0]
    assert p["TYPENAMES"] == "ms:LCSF" and "<fes:Literal>Gebaeude</fes:Literal>" in p["FILTER"]

    await _login(client, editor)
    body = (await client.get("/api/reference/houses")).json()
    assert body["enabled"] is True and body["count"] == 3
    assert body["geometry"]["type"] == "MultiPolygon" and len(body["geometry"]["coordinates"]) == 3
    again = (await client.get("/api/reference/houses", params={"have": body["fetchedAt"]})).json()
    assert again == {"enabled": True, "fetchedAt": body["fetchedAt"], "count": 3, "unchanged": True}


async def test_off_when_the_setting_is_empty(client, db_session, editor, monkeypatch):
    monkeypatch.setattr(houses.settings, "houses_wfs", "")
    await _object(db_session, 510, 505)
    survey = Survey(ROW)
    async with survey.client() as c:
        assert await houses.tick(db_session, client=c) == 0
    assert survey.asked == []
    await _login(client, editor)
    assert (await client.get("/api/reference/houses")).json() == {"enabled": False}

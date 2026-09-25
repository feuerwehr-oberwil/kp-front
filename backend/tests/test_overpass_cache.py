"""Building outlines: the cache, one race per query, and the station snapshot first (25.09.2026).

Every Karte/Gebäude open on staging answered `POST /api/overpass/buildings` with a 502 about
half the time: all three public mirrors 504'd or stalled from Railway's shared egress address.
Part of that was our own doing — every device of an Einsatz raced all three mirrors for the SAME
box, and a public mirror throttles per client address — and part of it was asking at all for
outlines the station already keeps (app/reference_buildings).
"""

import asyncio

import httpx
import pytest

from app import overpass, reference_buildings, storage


@pytest.fixture
def patch_httpx(monkeypatch):
    """MockTransport-backed AsyncClient — the technique tests/test_geo_clients.py uses."""

    def _install(handler):
        transport = httpx.MockTransport(handler)
        orig_init = httpx.AsyncClient.__init__

        def patched_init(self, *args, **kwargs):
            kwargs["transport"] = transport
            orig_init(self, *args, **kwargs)

        monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)

    return _install


async def test_a_repeated_query_is_answered_from_the_cache(patch_httpx, monkeypatch):
    monkeypatch.setattr(overpass, "mirrors", lambda: ["https://only.example/api"])
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.content.decode())
        return httpx.Response(200, json={"elements": ["one"]})

    patch_httpx(handler)
    first = await overpass.fetch_buildings("out body;")
    second = await overpass.fetch_buildings("out body;")
    assert first == second == {"elements": ["one"]}
    assert len(calls) == 1
    await overpass.fetch_buildings("out geom;")  # a different box is its own entry
    assert len(calls) == 2


async def test_concurrent_identical_queries_share_one_race(patch_httpx, monkeypatch):
    """Four tablets opening one Einsatz used to be four races × every mirror, from one address."""
    monkeypatch.setattr(overpass, "mirrors", lambda: ["https://a.example/api", "https://b.example/api"])
    calls: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        await asyncio.sleep(0.02)
        return httpx.Response(200, json={"elements": ["shared"]})

    patch_httpx(handler)
    answers = await asyncio.gather(*(overpass.fetch_buildings("out body;") for _ in range(4)))
    assert all(a == {"elements": ["shared"]} for a in answers)
    assert len(calls) <= 2  # ONE race: at most one request per mirror, not four of each


async def test_a_failure_is_never_cached(patch_httpx, monkeypatch):
    monkeypatch.setattr(overpass, "mirrors", lambda: ["https://only.example/api"])
    status = {"code": 504}
    patch_httpx(lambda r: httpx.Response(status["code"], json={"elements": ["later"]}))
    with pytest.raises(RuntimeError):
        await overpass.fetch_buildings("out body;")
    status["code"] = 200
    assert await overpass.fetch_buildings("out body;") == {"elements": ["later"]}


async def test_a_caller_that_gives_up_does_not_cancel_the_race(patch_httpx, monkeypatch):
    """The browser aborts at 20 s; a mirror may answer at 25. That answer must still reach the
    cache for the next open instead of dying with the request that gave up."""
    monkeypatch.setattr(overpass, "mirrors", lambda: ["https://only.example/api"])

    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.05)
        return httpx.Response(200, json={"elements": ["slow"]})

    patch_httpx(handler)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(overpass.fetch_buildings("out body;"), timeout=0.01)
    await asyncio.sleep(0.15)
    assert overpass._cache["out body;"][1] == {"elements": ["slow"]}


async def test_without_cache_every_call_races(patch_httpx, monkeypatch):
    """The station snapshot keeps its own (megabyte) copy in storage; it must not also sit here."""
    monkeypatch.setattr(overpass, "mirrors", lambda: ["https://only.example/api"])
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={"elements": []})

    patch_httpx(handler)
    await overpass.fetch_buildings("out body;", cache=False)
    await overpass.fetch_buildings("out body;", cache=False)
    assert len(calls) == 2
    assert "out body;" not in overpass._cache


def test_the_mirror_guard_outlasts_the_query_timeout():
    """At 20 s the backend hung up on a mirror the query itself had allowed 25 s."""
    budget = int(overpass.BUILDINGS_QUERY.split("[timeout:")[1].split("]")[0])
    assert budget < overpass.FETCH_TIMEOUT_S


# --- the station snapshot answers first ------------------------------------------------------


def _store_snapshot(monkeypatch, tmp_path, bbox, elements):
    import json

    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))
    storage.put_bytes(reference_buildings.SNAPSHOT_KEY, json.dumps({"bbox": bbox, "elements": elements}).encode())


async def test_a_box_inside_the_snapshot_is_clipped_from_it(monkeypatch, tmp_path):
    inside = {"type": "way", "id": 1, "geometry": [{"lat": 47.5001, "lon": 7.5001}]}
    outside = {"type": "way", "id": 2, "geometry": [{"lat": 47.52, "lon": 7.52}]}
    _store_snapshot(monkeypatch, tmp_path, [47.4, 7.4, 47.6, 7.6], [inside, outside])
    answer = await reference_buildings.stored_answer((47.499, 7.499, 47.501, 7.501))
    assert answer == {"elements": [inside]}


async def test_a_box_reaching_past_the_snapshot_is_not_answered_from_it(monkeypatch, tmp_path):
    _store_snapshot(monkeypatch, tmp_path, [47.4, 7.4, 47.6, 7.6], [])
    assert await reference_buildings.stored_answer((47.59, 7.5, 47.61, 7.51)) is None


async def test_no_snapshot_means_no_answer(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))
    assert await reference_buildings.stored_answer((47.5, 7.5, 47.51, 7.51)) is None


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def test_the_proxy_answers_from_the_snapshot_without_asking_a_mirror(client, editor, monkeypatch, tmp_path):
    inside = {"type": "way", "id": 7, "geometry": [{"lat": 47.5001, "lon": 7.5001}]}
    _store_snapshot(monkeypatch, tmp_path, [47.4, 7.4, 47.6, 7.6], [inside])

    async def no_mirror(*_a, **_kw):
        raise AssertionError("a mirror was asked for a box the snapshot covers")

    monkeypatch.setattr(overpass, "fetch_buildings", no_mirror)
    await _login(client, editor)
    r = await client.post(
        "/api/overpass/buildings", json={"south": 47.499, "west": 7.499, "north": 47.501, "east": 7.501}
    )
    assert r.status_code == 200
    assert r.json() == {"elements": [inside]}

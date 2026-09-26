"""Building outlines: the cache, one race per query, and the station snapshot first (25.09.2026).

Every Karte/Gebäude open on staging answered `POST /api/overpass/buildings` with a 502 about
half the time: all three public mirrors 504'd or stalled from Railway's shared egress address.
Part of that was our own doing — every device of an Einsatz raced all three mirrors for the SAME
box, and a public mirror throttles per client address — and part of it was asking at all for
outlines the station already keeps (app/reference_buildings).
"""

import asyncio
import json
from datetime import UTC, datetime, timedelta

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


def _store_snapshot(monkeypatch, tmp_path, bbox, elements, age=timedelta(days=1)):
    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))
    fetched_at = (datetime.now(UTC) - age).isoformat()
    body = {"fetched_at": fetched_at, "bbox": bbox, "elements": elements}
    storage.put_bytes(reference_buildings.SNAPSHOT_KEY, json.dumps(body).encode())


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


async def test_an_old_snapshot_is_not_the_first_answer(monkeypatch, tmp_path):
    """Past LIVE_MAX_AGE the mirrors are asked first; the old outlines are only the fallback."""
    _store_snapshot(monkeypatch, tmp_path, [47.4, 7.4, 47.6, 7.6], [], age=timedelta(days=45))
    box = (47.499, 7.499, 47.501, 7.501)
    assert await reference_buildings.stored_answer(box) is None
    assert await reference_buildings.stored_answer(box, any_age=True) == {"elements": []}


async def test_concurrent_cold_loads_parse_the_file_once(monkeypatch, tmp_path):
    """An alarm is when three or four devices open the Karte at once."""
    _store_snapshot(monkeypatch, tmp_path, [47.4, 7.4, 47.6, 7.6], [])
    real = reference_buildings._load_stored
    loads: list[int] = []

    def counting():
        loads.append(1)
        return real()

    monkeypatch.setattr(reference_buildings, "_load_stored", counting)
    box = (47.499, 7.499, 47.501, 7.501)
    answers = await asyncio.gather(*(reference_buildings.stored_answer(box) for _ in range(4)))
    assert all(a == {"elements": []} for a in answers)
    assert len(loads) == 1


async def test_the_live_path_never_feeds_the_workers_cache(monkeypatch, tmp_path, db_session):
    """Review of #232: `ensure_snapshot` returns its `_cache` for ten minutes WITHOUT checking the
    station's objects, so a stale disk copy parsed by a Karte open must never land there — the
    worker would clip objects the snapshot does not cover and store «kein Vorschlag»."""
    from app.models import ObjectSite

    _store_snapshot(monkeypatch, tmp_path, [47.4, 7.4, 47.6, 7.6], [])
    await reference_buildings.stored_answer((47.499, 7.499, 47.501, 7.501))
    assert reference_buildings._cache is None
    # an object outside the stored box: the worker must refresh, not reuse the live copy
    db_session.add(ObjectSite(name="Neu", lat=47.9, lng=7.9))
    await db_session.commit()
    fetched: list[str] = []

    async def fetch(query, timeout_s=20.0, **_kw):
        fetched.append(query)
        return {"elements": []}

    monkeypatch.setattr(reference_buildings.overpass, "fetch_buildings", fetch)
    snap = await reference_buildings.ensure_snapshot(db_session)
    assert fetched, "the worker reused a snapshot that does not cover the new object"
    assert reference_buildings.covers(tuple(snap["bbox"]), (47.9, 7.9, 47.9, 7.9))


async def test_the_proxy_falls_back_to_an_old_snapshot_only_when_every_mirror_fails(
    client, editor, monkeypatch, tmp_path
):
    inside = {"type": "way", "id": 7, "geometry": [{"lat": 47.5001, "lon": 7.5001}]}
    _store_snapshot(monkeypatch, tmp_path, [47.4, 7.4, 47.6, 7.6], [inside], age=timedelta(days=60))
    asked: list[int] = []

    async def mirror_down(*_a, **_kw):
        asked.append(1)
        raise RuntimeError("all Overpass mirrors failed")

    monkeypatch.setattr(overpass, "mirrors", lambda: ["https://only.example/api"])
    monkeypatch.setattr(overpass, "fetch_buildings", mirror_down)
    await _login(client, editor)
    body = {"south": 47.499, "west": 7.499, "north": 47.501, "east": 7.501}
    r = await client.post("/api/overpass/buildings", json=body)
    assert asked == [1]  # the mirrors first — the snapshot is two months old
    assert r.status_code == 200
    assert r.json() == {"elements": [inside]}


async def test_no_mirrors_configured_still_answers_from_the_snapshot(client, editor, monkeypatch, tmp_path):
    _store_snapshot(monkeypatch, tmp_path, [47.4, 7.4, 47.6, 7.6], [], age=timedelta(days=60))
    monkeypatch.setattr(overpass, "mirrors", list)
    await _login(client, editor)
    r = await client.post(
        "/api/overpass/buildings", json={"south": 47.499, "west": 7.499, "north": 47.501, "east": 7.501}
    )
    assert r.status_code == 200
    r = await client.post("/api/overpass/buildings", json={"south": 48.0, "west": 8.0, "north": 48.1, "east": 8.1})
    assert r.status_code == 503  # outside it: the honest «not configured»

"""LOAD: three devices on one editor login saving one incident at once (post-mortem 23.09.2026, D4).

The field shape: one account open on an iPad and two Androids, 140 × 409 on PUT /workspace in
~40 minutes, revs 1–574 contiguous in the end. This drives the REAL endpoint from three
independent HTTP clients (own cookie jars, same login) with interleaved writes: each device
PUTs at its base_rev, and on a 409 re-reads, merges its own objects over the server's (by id —
the client's mergeById, reduced to the union these additions need), waits a jittered moment
and retries. What must hold:

- no request ever answers 5xx — a lost race is a 409, never a crash;
- every device's every write is in the final workspace;
- the revisions the server handed out are exactly 1..N, one per accepted save, and the audit
  chain holds one ``workspace.save`` per revision and verifies intact.

Real concurrency needs PostgreSQL (row locks, independent transactions — CI provides it via
``DATABASE_URL``); the in-memory SQLite harness shares ONE connection across sessions, which
cannot model two transactions at once, so the test skips there — like
test_events_api · test_concurrent_identified_retry_appends_once_on_postgres.
"""

import asyncio
import random

import httpx
import pytest

pytestmark = pytest.mark.asyncio

DEVICES = 3
WRITES = 30
BUDGET = 60  # attempts per write — generous; the point is that it is never exhausted


async def _device(app, editor) -> httpx.AsyncClient:
    c = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    r = await c.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert r.status_code == 200, r.text
    return c


def _merge(server: dict, mine: dict) -> dict:
    """Union by id, server order first — mergeWorkspace's mergeById for pure additions."""
    have = {v["id"] for v in server.get("cameraViews", [])}
    return {
        **server,
        "cameraViews": [
            *server.get("cameraViews", []),
            *(v for v in mine.get("cameraViews", []) if v["id"] not in have),
        ],
    }


async def test_three_devices_thirty_interleaved_writes_each(client, editor, engine):
    if engine.dialect.name != "postgresql":
        pytest.skip("requires PostgreSQL row locks and independent transactions")
    from app.main import app

    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert r.status_code == 200
    inc = (await client.post("/api/incidents", json={"title": "Last – drei Geräte"})).json()["id"]
    devices = [await _device(app, editor) for _ in range(DEVICES)]
    rng = random.Random(23092026)
    statuses: list[int] = []
    accepted: list[int] = []
    conflicts = 0

    async def run(d: int, c: httpx.AsyncClient) -> int:
        nonlocal conflicts
        got = (await c.get(f"/api/incidents/{inc}/workspace")).json()
        local, base_rev = got["workspace"] or {}, got["workspace_rev"]
        most = 0
        for k in range(WRITES):
            local = {**local, "cameraViews": [*local.get("cameraViews", []), {"id": f"d{d}-{k}"}]}
            for attempt in range(BUDGET):
                put = await c.put(
                    f"/api/incidents/{inc}/workspace?slim=1", json={"workspace": local, "base_rev": base_rev}
                )
                statuses.append(put.status_code)
                if put.status_code == 200:
                    base_rev = put.json()["workspace_rev"]
                    accepted.append(base_rev)
                    most = max(most, attempt + 1)
                    break
                assert put.status_code == 409, put.text
                conflicts += 1
                server = (await c.get(f"/api/incidents/{inc}/workspace")).json()
                local, base_rev = _merge(server["workspace"] or {}, local), server["workspace_rev"]
                # the client's jittered re-merge pause (workspaceSync · conflictBackoffMs), scaled down
                await asyncio.sleep(rng.uniform(0.0, 0.02) * min(attempt + 1, 4))
            else:
                pytest.fail(f"device {d} exhausted its retry budget on write {k}")
            await asyncio.sleep(rng.uniform(0.0, 0.01))  # interleave with the others
        return most

    try:
        worst = await asyncio.gather(*(run(d, c) for d, c in enumerate(devices)))
    finally:
        for c in devices:
            await c.aclose()

    assert not [s for s in statuses if s >= 500]
    final = (await client.get(f"/api/incidents/{inc}/workspace")).json()
    ids = [v["id"] for v in final["workspace"]["cameraViews"]]
    assert len(ids) == len(set(ids)) == DEVICES * WRITES
    assert set(ids) == {f"d{d}-{k}" for d in range(DEVICES) for k in range(WRITES)}
    # contiguous: every accepted save advanced the revision by exactly one
    assert sorted(accepted) == list(range(1, DEVICES * WRITES + 1))
    assert final["workspace_rev"] == DEVICES * WRITES
    events = (await client.get(f"/api/incidents/{inc}/events")).json()
    saves = [e["payload_json"]["rev"] for e in events if e["op_type"] == "workspace.save"]
    assert saves == list(range(1, DEVICES * WRITES + 1))
    assert (await client.get(f"/api/incidents/{inc}/verify")).json()["intact"] is True
    assert conflicts > 0, "three interleaved writers must have raced at least once"
    assert max(worst) < BUDGET

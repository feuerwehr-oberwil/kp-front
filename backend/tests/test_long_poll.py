"""Long-poll live-follow: `wait=1` on the workspace and journal reads (app/live_wait).

The contract the two client loops rely on:
- nothing new within the timeout → the SAME answer the request would have given at once
  (304 for the workspace, an empty page for the journal), never an error;
- a change committed by another device wakes the parked request immediately, with the
  change already readable — a wake fired before the writer's COMMIT would hand the waiter
  the old state and cost it the whole timeout;
- parking leaks no waiter, whatever the outcome.
"""

import asyncio
import time
import uuid

import pytest
from sqlalchemy import select

from app import live_wait


@pytest.fixture(autouse=True)
def _short_wait(monkeypatch):
    """Real long polls park for 20 s. The tests assert the mechanics, not the duration."""
    monkeypatch.setattr(live_wait, "LONG_POLL_TIMEOUT_S", 0.2)


async def _parked() -> None:
    """Block until the poll task has actually registered its waiter.

    ⚠️ This replaces a bare ``asyncio.sleep(0.02)``. Twenty milliseconds is not a fact about the
    code, it is a guess about the machine — and on a loaded box (the full frontend suite running
    beside this one) the poll had not parked yet, so the write below fired before there was
    anything to wake and the test failed on a timing accident rather than on a defect. The
    condition the test actually depends on is observable, so wait for THAT.
    """
    deadline = time.perf_counter() + 2.0
    while not live_wait._waiters:
        assert time.perf_counter() < deadline, "the poll never parked"
        await asyncio.sleep(0.005)


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _incident(client) -> str:
    r = await client.post("/api/incidents", json={"title": "Long-Poll Test"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_workspace_wait_times_out_into_the_plain_304(client, editor):
    await _login(client, editor)
    inc = await _incident(client)

    started = time.perf_counter()
    r = await client.get(f"/api/incidents/{inc}/workspace?since=0&wait=1")
    elapsed = time.perf_counter() - started

    assert r.status_code == 304
    assert elapsed >= 0.2, "the request answered before the wait was over — it did not park"
    assert not live_wait._waiters, "a timed-out waiter stayed registered"


async def test_workspace_wait_wakes_on_another_devices_save(client, editor):
    await _login(client, editor)
    inc = await _incident(client)

    poll = asyncio.create_task(client.get(f"/api/incidents/{inc}/workspace?since=0&wait=1"))
    await _parked()  # …and it has handed its DB connection back

    put = await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": {"a": 1}, "base_rev": 0})
    assert put.status_code == 200, put.text

    r = await asyncio.wait_for(poll, timeout=2)
    assert r.status_code == 200
    # The woken read must see the COMMITTED blob, not the revision alone.
    assert r.json() == {"workspace": {"a": 1}, "workspace_rev": 1}
    assert not live_wait._waiters


async def test_workspace_wait_without_since_returns_the_blob_at_once(client, editor):
    """`wait` only qualifies the conditional read — a first open must never park."""
    await _login(client, editor)
    inc = await _incident(client)
    r = await client.get(f"/api/incidents/{inc}/workspace?wait=1")
    assert r.status_code == 200
    assert r.json()["workspace_rev"] == 0


async def test_journal_wait_times_out_into_an_empty_page(client, editor):
    await _login(client, editor)
    inc = await _incident(client)

    started = time.perf_counter()
    r = await client.get(f"/api/incidents/{inc}/journal?since_seq=0&wait=1")
    elapsed = time.perf_counter() - started

    assert r.status_code == 200
    assert r.json() == {"entries": [], "latest_seq": 0}
    assert elapsed >= 0.2
    assert not live_wait._waiters


async def test_journal_wait_wakes_on_an_append(client, editor):
    await _login(client, editor)
    inc = await _incident(client)

    poll = asyncio.create_task(client.get(f"/api/incidents/{inc}/journal?since_seq=0&wait=1"))
    await _parked()

    row = {"id": "r1", "t": "14:02", "icon": "flag", "text": "Wasser ab"}
    post = await client.post(f"/api/incidents/{inc}/journal", json={"entries": [row]})
    assert post.status_code == 201, post.text

    r = await asyncio.wait_for(poll, timeout=2)
    page = r.json()
    assert [e["row"]["text"] for e in page["entries"]] == ["Wasser ab"]
    assert page["latest_seq"] == 1
    assert not live_wait._waiters


async def test_journal_wait_returns_at_once_when_rows_are_already_waiting(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    await client.post(f"/api/incidents/{inc}/journal", json={"entries": [{"id": "r1", "t": "", "text": "da"}]})

    started = time.perf_counter()
    r = await client.get(f"/api/incidents/{inc}/journal?since_seq=0&wait=1")
    assert time.perf_counter() - started < 0.2
    assert len(r.json()["entries"]) == 1


async def test_the_wake_is_held_back_until_the_commit(db_session):
    """The whole point of `notify_after_commit`: a follower woken while the writer's transaction
    is still open would re-read the OLD state, find nothing and park again for a full timeout."""
    topic = live_wait.workspace_topic(uuid.uuid4())
    async with live_wait.subscribe(topic) as changes:
        await db_session.execute(select(1))  # open a real transaction
        live_wait.notify_after_commit(db_session, topic)
        assert await changes.wait() is False, "the wake fired before the commit"
        await db_session.commit()
        assert await changes.wait() is True

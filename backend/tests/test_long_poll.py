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


@pytest.fixture
def _long_park(monkeypatch):
    """For the WAKE tests: park long enough that only the wake can end the wait.

    ⚠️ The 0.2 s of `_short_wait` starts when the poll parks, and the whole PUT/POST the test
    then sends — auth, validation, commit, the after-commit wake — had to land inside it. On a
    loaded runner it did not (CI, 24.09.2026, and 3 of 12 local runs): the waiter timed out,
    re-read BEFORE the writer's commit, and answered 304. The bound on the wake is the test's own
    `asyncio.wait_for(poll, timeout=2)`, which starts after the write returned.
    """
    monkeypatch.setattr(live_wait, "LONG_POLL_TIMEOUT_S", 30.0)


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


async def test_workspace_wait_wakes_on_another_devices_save(client, editor, _long_park):
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


async def test_journal_wait_wakes_on_an_append(client, editor, _long_park):
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


# --- the saving device's own poll (18.10.2026) ----------------------------------------------
# Every save woke every follower — the SAVING device's own long poll too, which then downloaded
# the whole blob it had just sent. The saves now carry the device's writer id
# (X-Workspace-Writer) and the follower read asks with `writer=`: a range of revisions that is
# nothing but that device's own saves is the 304 + X-Workspace-Rev. Everything else — another
# device on the SAME login, a save without an id, an old client — must still be the blob.

A = "wsA1760800000000-1abc"
B = "wsB1760800000000-2def"


def _put(client, inc: str, rev: int, ws: dict, writer: str | None = None, route: str = ""):
    headers = {"X-Workspace-Writer": writer} if writer else {}
    body = {"trupps": ws.get("trupps", []), "base_rev": rev} if route == "/trupps" else {"workspace": ws, "base_rev": rev}
    return client.put(f"/api/incidents/{inc}/workspace{route}", json=body, headers=headers)


async def test_own_save_wakes_the_own_poll_without_the_blob(client, editor, _long_park):
    await _login(client, editor)
    inc = await _incident(client)

    poll = asyncio.create_task(client.get(f"/api/incidents/{inc}/workspace?since=0&wait=1&writer={A}"))
    await _parked()
    assert (await _put(client, inc, 0, {"a": 1}, A)).status_code == 200

    r = await asyncio.wait_for(poll, timeout=2)
    assert r.status_code == 304, r.text
    assert r.content == b""
    assert r.headers["X-Workspace-Rev"] == "1"
    assert r.headers["X-Incident-Open"] == "1", "the lifecycle rides the own-save answer too"
    assert not live_wait._waiters


async def test_another_device_on_the_same_login_still_gets_the_blob(client, editor, _long_park):
    """One account on three tablets is the field's shape: the user is not the writer."""
    await _login(client, editor)
    inc = await _incident(client)

    poll = asyncio.create_task(client.get(f"/api/incidents/{inc}/workspace?since=0&wait=1&writer={A}"))
    await _parked()
    assert (await _put(client, inc, 0, {"b": 1}, B)).status_code == 200

    r = await asyncio.wait_for(poll, timeout=2)
    assert r.status_code == 200
    assert r.json() == {"workspace": {"b": 1}, "workspace_rev": 1}


@pytest.mark.parametrize(
    ("poll_writer", "save_writer"),
    [(A, None), (None, A), (A, "not a writer id!"), (A, "x" * 65)],
    ids=["save-without-id", "old-client-poll", "garbled-id", "overlong-id"],
)
async def test_anything_unproven_is_the_blob(client, editor, _long_park, poll_writer, save_writer):
    await _login(client, editor)
    inc = await _incident(client)

    q = f"&writer={poll_writer}" if poll_writer else ""
    poll = asyncio.create_task(client.get(f"/api/incidents/{inc}/workspace?since=0&wait=1{q}"))
    await _parked()
    assert (await _put(client, inc, 0, {"c": 1}, save_writer)).status_code == 200

    r = await asyncio.wait_for(poll, timeout=2)
    assert r.status_code == 200
    assert r.json()["workspace_rev"] == 1


async def test_a_foreign_save_anywhere_in_the_range_is_the_blob(client, editor):
    """The race: this device saved, another device saved right after, and only then did this
    device's poll ask again. The range holds a foreign revision — the blob, with both."""
    await _login(client, editor)
    inc = await _incident(client)
    assert (await _put(client, inc, 0, {"mine": 1}, A)).status_code == 200
    assert (await _put(client, inc, 1, {"mine": 1, "theirs": 1}, B)).status_code == 200

    for since in (0, 1):
        r = await client.get(f"/api/incidents/{inc}/workspace?since={since}&writer={A}")
        assert r.status_code == 200, f"since={since}"
        assert r.json() == {"workspace": {"mine": 1, "theirs": 1}, "workspace_rev": 2}
    # …and the other way round: B's poll never takes A's save for its own
    r = await client.get(f"/api/incidents/{inc}/workspace?since=0&writer={B}")
    assert r.status_code == 200


async def test_several_own_saves_in_a_row_are_still_own_and_the_next_foreign_one_is_not(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    assert (await _put(client, inc, 0, {"n": 1}, A)).status_code == 200
    assert (await _put(client, inc, 1, {"n": 2}, A)).status_code == 200

    r = await client.get(f"/api/incidents/{inc}/workspace?since=0&writer={A}")
    assert (r.status_code, r.headers.get("X-Workspace-Rev")) == (304, "2")

    assert (await _put(client, inc, 2, {"n": 2, "other": 1}, B)).status_code == 200
    r = await client.get(f"/api/incidents/{inc}/workspace?since=2&writer={A}")
    assert r.status_code == 200
    assert r.json()["workspace_rev"] == 3


async def test_a_refused_save_records_nothing(client, editor):
    """A 409 (stale base) is rolled back: the revision it would have been is another device's."""
    await _login(client, editor)
    inc = await _incident(client)
    assert (await _put(client, inc, 0, {"b": 1}, B)).status_code == 200
    assert (await _put(client, inc, 0, {"a": 1}, A)).status_code == 409

    r = await client.get(f"/api/incidents/{inc}/workspace?since=0&writer={A}")
    assert r.status_code == 200
    assert r.json() == {"workspace": {"b": 1}, "workspace_rev": 1}


@pytest.mark.parametrize("route", ["/trupps", "/record"])
async def test_the_slice_routes_record_their_writer_too(client, editor, route):
    """A Funkkontakt goes the trupp slice (#394), the EL's record the record slice."""
    await _login(client, editor)
    inc = await _incident(client)
    assert (await _put(client, inc, 0, {"trupps": [], "mittel": []}, A, route)).status_code == 200

    r = await client.get(f"/api/incidents/{inc}/workspace?since=0&writer={A}")
    assert (r.status_code, r.headers.get("X-Workspace-Rev")) == (304, "1")


async def test_only_the_newest_revisions_are_vouched_for(client, editor, monkeypatch):
    """The record is a window, not a history: a follower further behind gets the blob."""
    monkeypatch.setattr(live_wait, "_WRITES_KEPT", 2)
    await _login(client, editor)
    inc = await _incident(client)
    for rev in range(3):
        assert (await _put(client, inc, rev, {"n": rev}, A)).status_code == 200

    assert (await client.get(f"/api/incidents/{inc}/workspace?since=1&writer={A}")).status_code == 304
    assert (await client.get(f"/api/incidents/{inc}/workspace?since=0&writer={A}")).status_code == 200

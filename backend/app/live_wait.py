"""Wake-ups for the long-polling live-follow reads (workspace blob + Verlauf).

Every open device follows an incident with two loops: the workspace blob
(``GET …/workspace?since=&wait=1``) and the journal (``GET …/journal?since_seq=&wait=1``).
Without this module they asked again every couple of seconds and were told «nothing new» ~99 %
of the time — the cost of a cross-device change showing up was half a poll cycle, and the cost
of a *quiet* incident was a request per device per beat, all night, on cellular.

With it a follower parks inside its GET until a writer says there is something to fetch. One
request covers the whole quiet stretch, and a change is delivered as fast as the writer's
transaction commits.

Two properties the callers depend on:

· **The wake happens after the COMMIT.** A waiter woken while the writer's transaction is still
  open would re-read the *old* state, conclude nothing changed and park again for a full
  timeout — the exact latency the long poll exists to remove. `notify_after_commit` therefore
  hands the wake-up to `transaction_hooks.after_commit`, the module that owns that boundary
  for every non-database side effect (blob cleanup, outbound notifications) — a wake-up is one
  more of those, and a rollback drops it there for the same reason it drops the others.

· **Nothing waits on a checked-out DB connection.** The endpoints query, hand the connection
  back (``await db.commit()``), and only then park here. The pool holds 10+10 connections and a
  station has more parked followers than that.

⚠️ **In-process only.** Production runs a single uvicorn worker (``backend/start.sh``: no
``--workers``), so every writer and every waiter share this registry. If this is ever deployed
across several workers or containers, a follower on worker B will not hear a write on worker A —
it degrades to its wait timeout, i.e. back to the old polling cadence, correct but slower. The
natural fix at that point is Postgres ``LISTEN/NOTIFY`` on the same database, with this module's
API unchanged.
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession

from .transaction_hooks import after_commit

#: How long a long-poll read parks before answering «nothing new». Comfortably under the
#: reverse-proxy idle timeouts we run behind, and under the client's own request timeout —
#: the browser must see our 304/empty page rather than time out on its own (lib/api.ts).
LONG_POLL_TIMEOUT_S = 20.0

#: A thing to follow: ("workspace" | "journal", incident id).
Topic = tuple[str, uuid.UUID]

#: topic → the events of the requests currently parked on it. One entry per parked request;
#: both sides are removed in the waiter's ``finally``, so the dict is bounded by live requests
#: and empty again once the last follower of an incident goes away.
_waiters: dict[Topic, set[asyncio.Event]] = {}


def workspace_topic(incident_id: uuid.UUID) -> Topic:
    return ("workspace", incident_id)


def journal_topic(incident_id: uuid.UUID) -> Topic:
    return ("journal", incident_id)


def notify(topic: Topic) -> None:
    """Wake every request parked on `topic`, now. Cheap and safe when nobody is listening.

    Use `notify_after_commit` from inside a request — this raw form is for writers that have
    already committed.
    """
    for ev in _waiters.get(topic, ()):
        ev.set()


def notify_after_commit(db: AsyncSession, topic: Topic) -> None:
    """Queue a wake-up for `topic`, fired when this session's transaction commits.

    Called by the writers (workspace PUT, journal append) *while* their transaction is still
    open — see the module docstring for why the delay matters. A rollback drops the queue:
    that is `transaction_hooks`' after-commit contract, which this rides rather than
    re-deriving. Several topics may be queued on one session; each fires once, in order,
    and a second wake for a topic already queued is harmless (it sets a set event again).
    """
    after_commit(db, lambda: notify(topic))


class Subscription:
    """A registered interest in one topic — see `subscribe`."""

    def __init__(self, event_: asyncio.Event) -> None:
        self._event = event_

    async def wait(self) -> bool:
        """Park for up to `LONG_POLL_TIMEOUT_S`. True → something changed, False → timed out.

        The caller then re-reads and answers exactly as it would have without the wait, so False
        is never an error: it is «nothing happened for 20 s», i.e. a 304 / an empty page. A
        spurious wake costs one re-read and the same answer.

        The bound is the module constant rather than an argument: it belongs to the protocol
        (the client sizes its own request timeout above it), not to the call site — and one
        place to read it is one place for the tests to shorten.
        """
        try:
            await asyncio.wait_for(self._event.wait(), LONG_POLL_TIMEOUT_S)
            return True
        except TimeoutError:
            return False


@asynccontextmanager
async def subscribe(topic: Topic) -> AsyncIterator[Subscription]:
    """Register interest in `topic` for the duration of the block.

    ⚠️ Enter this BEFORE the read that decides whether there is anything to wait for. Registering
    afterwards leaves a gap in which a writer can commit unheard, and the follower then sits out
    the full timeout with the change already in the database — a 20 s stall on exactly the busy
    moment the long poll is for.

    A client that disconnects mid-wait cancels the request task; leaving the block de-registers,
    so an aborted long poll (tab hidden, incident switched) leaks no waiter.
    """
    ev = asyncio.Event()
    _waiters.setdefault(topic, set()).add(ev)
    try:
        yield Subscription(ev)
    finally:
        parked = _waiters.get(topic)
        if parked is not None:
            parked.discard(ev)
            if not parked:
                _waiters.pop(topic, None)

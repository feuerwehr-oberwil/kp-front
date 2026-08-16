"""`get_db` must commit BEFORE the response is sent, not after.

FastAPI runs the exit code of a dependency-with-yield at request scope by default — after the
response has already gone out on the wire. With the commit sitting there, a client that
immediately re-read what it had just written raced its own write and lost: a tight
write-then-read loop against a single uvicorn worker read the pre-write state 23 times in 300.
On a Verwaltung page that is «gespeichert» over a table that still shows the old rows, and an
operator who saves a second time. `app/api/config.py` already carried a hand-placed
`await db.commit()` for exactly this reason at one endpoint.

Timing tests are flaky, so this asserts the ORDER rather than a rate: a stub session records
when it is committed, the raw ASGI `send` records when the response starts, and the commit has
to come first. Deterministic — no database, no server, no sleeping.
"""

import contextlib
from typing import Any

from fastapi import Depends, FastAPI

from app.database import get_db


class _StubSession:
    """Records the session lifecycle into a shared log. Doubles as its own async CM,
    which is what `async with async_session_maker() as session` expects."""

    def __init__(self, log: list[str], *, commit_fails: bool = False) -> None:
        self.log = log
        self.commit_fails = commit_fails

    async def __aenter__(self) -> "_StubSession":
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False

    async def commit(self) -> None:
        self.log.append("commit")
        if self.commit_fails:
            raise RuntimeError("the transaction could not be committed")

    async def rollback(self) -> None:
        self.log.append("rollback")

    async def close(self) -> None:
        self.log.append("close")


async def _drive(app: FastAPI, log: list[str], path: str) -> int | None:
    """Call the ASGI app directly. httpx's ASGITransport awaits the whole call before
    returning, so only a raw `send` can see where the response leaves relative to the commit."""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.1"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"host", b"test")],
        "client": ("test", 1),
        "server": ("test", 80),
    }

    status: int | None = None

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        nonlocal status
        if message["type"] == "http.response.start":
            log.append("response.start")
            status = message["status"]

    await app(scope, receive, send)  # type: ignore[arg-type]
    return status


def _app_with(log: list[str], *, boom: bool = False) -> FastAPI:
    api = FastAPI()

    @api.get("/probe")
    async def probe(db: Any = Depends(get_db)) -> dict[str, bool]:  # a real call site's shape
        if boom:
            raise RuntimeError("write failed after the session was handed out")
        return {"ok": True}

    return api


async def test_commit_lands_before_the_response_is_sent(monkeypatch) -> None:
    log: list[str] = []
    monkeypatch.setattr("app.database.async_session_maker", lambda: _StubSession(log))

    await _drive(_app_with(log), log, "/probe")

    assert "commit" in log, "the session was never committed"
    assert log.index("commit") < log.index("response.start"), (
        f"the commit ran AFTER the response went out ({log}) — a client that re-reads what it "
        'just wrote can see the pre-write state. Keep the `scope="function"` on get_db\'s Depends.'
    )


async def test_a_failing_endpoint_still_rolls_back(monkeypatch) -> None:
    """Moving the commit earlier must not cost the all-or-nothing transaction: everything a
    request wrote (station_workbook imports personnel AND config in one) still has to go back
    together when a later step raises."""
    log: list[str] = []
    monkeypatch.setattr("app.database.async_session_maker", lambda: _StubSession(log))

    with contextlib.suppress(RuntimeError):  # ServerErrorMiddleware answers, then re-raises
        await _drive(_app_with(log, boom=True), log, "/probe")

    assert "rollback" in log
    assert "commit" not in log


async def test_a_commit_that_fails_no_longer_answers_200(monkeypatch) -> None:
    """The other half of moving the commit: a commit that FAILS now fails the request.

    While the commit ran after the response, a failing one could not change what had already
    been sent — the client had its 200 and the error only ever reached the server log. Now it
    happens first, so the request errors out instead of reporting a write that is not there.
    An operator must not be told «gespeichert» about a transaction the database refused.
    """
    log: list[str] = []
    monkeypatch.setattr("app.database.async_session_maker", lambda: _StubSession(log, commit_fails=True))

    status: int | None = None
    with contextlib.suppress(RuntimeError):  # ServerErrorMiddleware answers, then re-raises
        status = await _drive(_app_with(log), log, "/probe")

    assert "commit" in log
    assert status != 200, f"a failed commit still answered the client with {status}"

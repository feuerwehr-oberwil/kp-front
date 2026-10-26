"""Gzip sync-channel: compressed request bodies inflate transparently; bombs are capped.

The frontend sends large JSON bodies (workspace saves) with Content-Encoding: gzip.
Covers: a gzipped journal POST behaves identically to plain JSON; corrupt gzip is 400
(never a 500); a body that decompresses past the JSON cap is 413; a truncated member, trailing
bytes or a second member is 400 before anything is written; another coding is 415, none at all
passes untouched; completeness is judged at the end of a body delivered in tiny chunks.
"""

import gzip
import json

import pytest

from app.config import settings
from app.gzip_request import GzipRequestMiddleware


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _incident(client) -> str:
    r = await client.post("/api/incidents", json={"title": "Gzip Test"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _gz(payload: dict) -> bytes:
    return gzip.compress(json.dumps(payload).encode())


async def test_gzipped_request_body_is_inflated(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    body = {"entries": [{"id": "t1", "t": "14:00", "icon": "flag", "text": "gzipped row"}]}
    r = await client.post(
        f"/api/incidents/{inc}/journal",
        content=_gz(body),
        headers={"Content-Type": "application/json", "Content-Encoding": "gzip"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["latest_seq"] == 1

    read = await client.get(f"/api/incidents/{inc}/journal")
    assert read.json()["entries"][0]["row"]["text"] == "gzipped row"


async def test_corrupt_gzip_is_400_not_500(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    r = await client.post(
        f"/api/incidents/{inc}/journal",
        content=b"definitely-not-gzip",
        headers={"Content-Type": "application/json", "Content-Encoding": "gzip"},
    )
    assert r.status_code == 400


async def test_gzip_bomb_is_capped_at_the_json_limit(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    # tiny on the wire, huge decompressed — must hit the decompressed-size cap, not RAM
    bomb = gzip.compress(b'{"entries": [' + b'"x",' * (settings.max_json_body_mb * 1024 * 1024 // 4) + b'"x"]}')
    r = await client.post(
        f"/api/incidents/{inc}/journal",
        content=bomb,
        headers={"Content-Type": "application/json", "Content-Encoding": "gzip"},
    )
    assert r.status_code == 413


@pytest.mark.parametrize("missing", range(1, 9))
async def test_incomplete_gzip_never_appends_a_journal_row(client, editor, missing):
    await _login(client, editor)
    inc = await _incident(client)
    body = {"entries": [{"id": "incomplete", "t": "14:00", "icon": "flag", "text": "incomplete"}]}
    r = await client.post(
        f"/api/incidents/{inc}/journal",
        content=_gz(body)[:-missing],
        headers={"Content-Type": "application/json", "Content-Encoding": "gzip"},
    )
    assert r.status_code == 400, r.text
    assert (await client.get(f"/api/incidents/{inc}/journal")).json()["entries"] == []


@pytest.mark.parametrize("suffix", [b"junk", gzip.compress(b"{}")], ids=["junk", "second-member"])
async def test_gzip_trailing_bytes_are_rejected_before_mutation(client, editor, suffix):
    await _login(client, editor)
    inc = await _incident(client)
    body = {"entries": [{"id": "trailing", "t": "14:00", "icon": "flag", "text": "trailing"}]}
    r = await client.post(
        f"/api/incidents/{inc}/journal",
        content=_gz(body) + suffix,
        headers={"Content-Type": "application/json", "Content-Encoding": "gzip"},
    )
    assert r.status_code == 400, r.text
    assert (await client.get(f"/api/incidents/{inc}/journal")).json()["entries"] == []


@pytest.mark.parametrize("encoding", ["gzip, gzip", "br", "gzip, identity", "deflate", "x-gzip"])
async def test_unsupported_encodings_are_rejected(client, editor, encoding):
    await _login(client, editor)
    inc = await _incident(client)
    # Plain JSON must not slip through just because an encoding is unrecognized.
    r = await client.post(
        f"/api/incidents/{inc}/journal",
        content=b'{"entries": []}',
        headers={"Content-Type": "application/json", "Content-Encoding": encoding},
    )
    assert r.status_code == 415, r.text
    assert (await client.get(f"/api/incidents/{inc}/journal")).json()["entries"] == []


async def _run_chunked(
    wire: bytes, *, chunk: int = 1, encoding: bytes | None = b"gzip"
) -> tuple[int | None, bytes | None]:
    """Drive the middleware directly with the body split into `chunk`-byte ASGI messages (the
    httpx test client always sends one). Returns (refusal status or None, body the app saw)."""
    pieces = [wire[i : i + chunk] for i in range(0, len(wire), chunk)] or [b""]
    messages = [{"type": "http.request", "body": p, "more_body": i < len(pieces) - 1} for i, p in enumerate(pieces)]
    seen: list[bytes] = []
    sent: list[dict] = []

    async def app(scope, receive, send):
        body = b""
        while True:
            msg = await receive()
            body += msg.get("body", b"")
            if not msg.get("more_body"):
                break
        seen.append(body)

    async def receive():
        return messages.pop(0)

    async def send(msg):
        sent.append(msg)

    headers = [(b"content-type", b"application/json")] + ([(b"content-encoding", encoding)] if encoding else [])
    await GzipRequestMiddleware(app, max_decompressed_bytes=1024 * 1024)(
        {"type": "http", "headers": headers}, receive, send
    )
    status = sent[0]["status"] if sent else None
    return status, (seen[0] if seen else None)


async def test_completeness_is_judged_at_the_end_of_a_tiny_chunked_body():
    payload = json.dumps({"entries": [{"id": "c", "text": "x" * 500}]}).encode()
    member = gzip.compress(payload)
    assert await _run_chunked(member) == (None, payload)
    assert await _run_chunked(member[:-1]) == (400, None)
    assert await _run_chunked(member + gzip.compress(b"{}"), chunk=3) == (400, None)
    assert await _run_chunked(b"") == (400, None)  # «gzip» with no member at all


async def test_a_plain_body_passes_untouched():
    assert await _run_chunked(b'{"a": 1}', encoding=None) == (None, b'{"a": 1}')
    assert await _run_chunked(b'{"a": 1}', encoding=b"identity") == (None, b'{"a": 1}')

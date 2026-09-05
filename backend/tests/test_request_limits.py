"""Request-ingestion bounds (SEC-04): what the server agrees to read before it answers.

The cap used to be a `Content-Length` check and nothing else, so the one caller who mattered
— a client that simply omits the header and streams — walked past it. Worse, the request then
reached validation, which echoed the submitted data back: a 1 MiB body produced a 2 MB 422.
Both halves are unauthenticated, so this is the availability boundary of the single service
every command tablet talks to.

What is pinned here:

- a declared oversized length is still refused up front (413), and a lying/garbage one is 400;
- a body streamed WITHOUT `Content-Length` is refused at the same cap, after bounded reading;
- the cap is route-aware: multipart gets `max_upload_mb`, everything else `max_json_body_mb`,
  so the ~100 MB voice-memo import keeps working while JSON stays small;
- the gzip request channel keeps its own decompressed cap (the wire cap is not it);
- a validation failure answers with a bounded, redacted body — never the input again.
"""

import gzip
import json
from collections.abc import AsyncIterator

import pytest

from app.config import settings

#: Small caps so the streaming tests move kilobytes, not the deployment's real megabytes.
TEST_JSON_CAP_MB = 1


@pytest.fixture(autouse=True)
def small_json_cap(monkeypatch):
    """Shrink the JSON cap only. `max_upload_mb` stays at its real value — the point of the
    route-aware test below is that the two genuinely differ."""
    monkeypatch.setattr(settings, "max_json_body_mb", TEST_JSON_CAP_MB)
    return TEST_JSON_CAP_MB


async def _stream(total: int, chunk: int = 64 * 1024) -> AsyncIterator[bytes]:
    """An httpx request body with no length — the transport falls back to chunked framing,
    which is exactly the shape that used to bypass the cap."""
    sent = 0
    while sent < total:
        n = min(chunk, total - sent)
        yield b"x" * n
        sent += n


def _oversized_json(extra: int = 4096) -> bytes:
    """A syntactically valid login body one cap over the line."""
    filler = "y" * (TEST_JSON_CAP_MB * 1024 * 1024 + extra)
    return json.dumps({"user_id": "00000000-0000-0000-0000-000000000000", "pin": filler}).encode()


async def test_declared_oversized_body_is_413(client):
    body = _oversized_json()
    r = await client.post("/api/auth/login", content=body, headers={"content-type": "application/json"})
    assert r.status_code == 413, r.text
    assert "gross" in r.json()["detail"]


async def test_unparsable_content_length_is_400(client):
    r = await client.post(
        "/api/auth/login",
        content=b"{}",
        headers={"content-type": "application/json", "content-length": "not-a-number"},
    )
    assert r.status_code == 400


async def test_streamed_body_without_content_length_is_413(client):
    """⚠️ THE BYPASS. No `Content-Length`, so the header check had nothing to look at and the
    whole body was read and validated. The cap has to count the bytes as they arrive."""
    total = TEST_JSON_CAP_MB * 1024 * 1024 + 4096
    r = await client.post(
        "/api/auth/login",
        content=_stream(total),
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 413, f"{r.status_code}: {r.text[:200]}"
    assert len(r.content) < 4096, "the refusal must not carry the body back"


async def test_streamed_multipart_gets_the_upload_cap(client):
    """Route-aware: the same streamed size that is refused as JSON is accepted as an upload.

    `max_upload_mb` (110) must stay above the media route's own 100 MB per-file cap, so a
    voice memo imported from a phone is bounded by media.py, not by this middleware."""
    assert settings.max_upload_mb > TEST_JSON_CAP_MB
    total = TEST_JSON_CAP_MB * 1024 * 1024 + 4096
    r = await client.post(
        "/api/auth/login",
        content=_stream(total),
        headers={"content-type": "multipart/form-data; boundary=----kpfront"},
    )
    # Whatever the route makes of the junk (422 — it wanted JSON), the SIZE was not the reason.
    assert r.status_code != 413, r.text


async def test_gzip_request_keeps_its_decompressed_cap(client, editor):
    """The wire cap does not replace the inflation cap: a bomb is tiny on the wire."""
    login = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert login.status_code == 200
    inc = await client.post("/api/incidents", json={"title": "Limit Test"})
    assert inc.status_code == 201, inc.text
    bomb = gzip.compress(b'{"entries": [' + b'"x",' * (8 * 1024 * 1024 // 4) + b'"x"]}')
    r = await client.post(
        f"/api/incidents/{inc.json()['id']}/journal",
        content=bomb,
        headers={"Content-Type": "application/json", "Content-Encoding": "gzip"},
    )
    assert r.status_code == 413, r.text


async def test_a_json_body_lying_about_multipart_gets_the_json_cap(client):
    """SEC-04 (05.09.): the cap was chosen by a substring search, so
    `application/json; charset=multipart/form-data` selected the 110 MB upload cap for a JSON
    body. The bare media type decides now, not a substring anywhere in the header."""
    total = TEST_JSON_CAP_MB * 1024 * 1024 + 4096
    r = await client.post(
        "/api/auth/login",
        content=_stream(total),
        headers={"content-type": "application/json; charset=multipart/form-data"},
    )
    assert r.status_code == 413, f"{r.status_code}: {r.text[:200]}"


async def test_a_caller_chosen_loc_key_cannot_inflate_the_422():
    """SEC-04 (05.09.): `loc` is caller-influenced (a rejected dict field's key lives there), and
    it was serialised unbounded — so the redaction that dropped `input` could still be defeated
    through a giant key. Both the count of parts and each part's length are bounded now."""
    from fastapi.exceptions import RequestValidationError

    from app.main import validation_exception_handler

    exc = RequestValidationError(
        [{"loc": ("body", "k" * 500_000, *(str(i) for i in range(50))), "msg": "x" * 500_000, "type": "value_error"}]
    )
    resp = await validation_exception_handler(None, exc)  # type: ignore[arg-type]
    assert len(resp.body) < 4096, f"422 body was {len(resp.body)} bytes"


async def test_validation_error_does_not_echo_the_request(client):
    """A rejected body must not come back doubled. The default 422 repeats every offending
    value under `input`, which turned a large-but-legal request into a larger response."""
    payload = json.dumps({"user_id": "not-a-uuid", "pin": "z" * 200_000}).encode()
    r = await client.post("/api/auth/login", content=payload, headers={"content-type": "application/json"})
    assert r.status_code == 422, r.text
    assert len(r.content) < 4096, f"422 body was {len(r.content)} bytes"
    assert "zzzz" not in r.text
    detail = r.json()["detail"]
    assert isinstance(detail, list) and detail, r.text
    assert {"loc", "msg", "type"} <= set(detail[0])

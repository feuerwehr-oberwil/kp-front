"""Gzip sync-channel: compressed request bodies inflate transparently; bombs are capped.

The frontend sends large JSON bodies (workspace saves) with Content-Encoding: gzip.
Covers: a gzipped journal POST behaves identically to plain JSON; corrupt gzip is 400
(never a 500); a body that decompresses past the JSON cap is 413.
"""

import gzip
import json

from app.config import settings


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

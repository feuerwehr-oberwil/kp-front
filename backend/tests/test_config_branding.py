"""Batch A admin features: config backup meta + branding asset uploads.

Covers:
- GET /api/config/meta returns the resolver name + iso date after a PUT stamps updated_by.
- POST /api/branding/{slot} sets identity.assets[slot] to a public file URL.
- GET /api/branding/file/{key} serves the stored bytes (PUBLIC, no auth).
- A non-image upload is rejected 415.
- A traversal key on the public serve endpoint is rejected 404.

Runs against the test DB (SQLite locally, postgres in CI).
"""

import pytest

pytestmark = pytest.mark.asyncio


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


# --- A1: config meta ----------------------------------------------------------------


async def test_config_meta_after_put(client, editor, admin_login):
    await _login(client, editor)
    await admin_login(client)
    # a fresh DB has no row → nulls
    r0 = await client.get("/api/config/meta")
    assert r0.status_code == 200
    assert r0.json() == {"updated_at": None, "updated_by_name": None}

    # stamp the row via a PUT — updated_by is the logged-in user driving the admin UI
    put = await client.put("/api/config", json={"identity": {"appName": "Testwehr"}})
    assert put.status_code == 200, put.text

    r1 = await client.get("/api/config/meta")
    assert r1.status_code == 200
    body = r1.json()
    assert body["updated_by_name"] == editor.display_name
    assert body["updated_at"] is not None


async def test_config_meta_requires_admin(client, editor):
    # Admin endpoints are gated on the ADMIN_SECRET session, NOT the editor role: even a
    # logged-in editor without an admin session is locked out (401).
    await _login(client, editor)
    r = await client.get("/api/config/meta")
    assert r.status_code == 401


# --- A2: branding uploads -----------------------------------------------------------

# 1x1 transparent PNG
_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06"
    b"\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xcf\xc0\x00\x00\x03"
    b"\x01\x01\x00\x18\xdd\x8d\xb0\x00\x00\x00\x00IEND\xaeB`\x82"
)


async def test_branding_upload_sets_asset_and_serves(client, editor, admin_login):
    await _login(client, editor)
    await admin_login(client)
    r = await client.post(
        "/api/branding/logo",
        files={"file": ("logo.png", _PNG, "image/png")},
    )
    assert r.status_code == 200, r.text
    url = r.json()["identity"]["assets"]["logo"]
    assert url and url.startswith("/api/branding/file/branding/")

    # the public serve endpoint returns the bytes WITHOUT auth
    import httpx

    from app.main import app

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as anon:
        served = await anon.get(url)
    assert served.status_code == 200
    assert served.content == _PNG

    # meta now reflects the branding stamp too
    meta = await client.get("/api/config/meta")
    assert meta.json()["updated_by_name"] == editor.display_name


async def test_branding_rejects_non_image_415(client, editor, admin_login):
    await _login(client, editor)
    await admin_login(client)
    r = await client.post(
        "/api/branding/logo",
        files={"file": ("evil.html", b"<script>", "text/html")},
    )
    assert r.status_code == 415


async def test_branding_unknown_slot_404(client, editor, admin_login):
    await _login(client, editor)
    await admin_login(client)
    r = await client.post(
        "/api/branding/banner",
        files={"file": ("x.png", _PNG, "image/png")},
    )
    assert r.status_code == 404


async def test_branding_serve_rejects_traversal(client):
    # PUBLIC endpoint — no login. A non-branding / traversal key must 404, never read
    # an arbitrary file.
    r1 = await client.get("/api/branding/file/etc/passwd")
    assert r1.status_code == 404
    r2 = await client.get("/api/branding/file/branding/..%2f..%2fsecret")
    assert r2.status_code == 404


async def test_branding_delete_clears_asset(client, editor, admin_login):
    await _login(client, editor)
    await admin_login(client)
    up = await client.post(
        "/api/branding/favicon",
        files={"file": ("fav.png", _PNG, "image/png")},
    )
    assert up.json()["identity"]["assets"]["favicon"] is not None
    rm = await client.delete("/api/branding/favicon")
    assert rm.status_code == 200
    assert rm.json()["identity"]["assets"]["favicon"] is None

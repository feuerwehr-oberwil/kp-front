"""``GET /manifest.webmanifest`` — the installed PWA carries the STATION's identity.

The manifest is baked at build time by vite-plugin-pwa; ``app/webmanifest.py`` shadows the
built file and overlays the deployment config onto it. What is pinned here:

- a configured identity (name, accent colour, locale, uploaded icons) reaches the manifest;
- an empty/absent/garbage config still yields a valid manifest, never a 500 and never a
  nameless one — this route is fetched by every tablet on every load;
- the station's icons appear ONLY once the assets exist, and never claim to be maskable;
- an install icon that the launcher could not use is refused at upload with a message that
  says what was wrong.
"""

import struct
import zlib

import pytest

from app.api.branding import _ICON_SLOTS, _png_size
from app.webmanifest import _FALLBACK_BASE, build_manifest

# (pytest-asyncio runs in `asyncio_mode = "auto"`, so the async tests below need no marker —
# and the pure ones must not carry one.)


def _png(width: int, height: int) -> bytes:
    """A real (opaque black RGBA) PNG of the given size — the uploads are checked against
    the bytes, so a stub header would not exercise the same path."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + b"\x00\x00\x00\xff" * width for _ in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


# --- the overlay itself (pure, independent of whether dist/ exists) ---------------------


def test_configured_identity_reaches_the_manifest():
    doc = build_manifest(
        _FALLBACK_BASE,
        {
            "appName": "Feuerwehr Talheim",
            "locale": "fr-CH",
            "accentColor": "#c81e1e",
            "assets": {
                "iconPng192": "/api/branding/file/branding/a.png",
                "iconPng512": "/api/branding/file/branding/b.png",
            },
        },
    )
    assert doc["name"] == "Feuerwehr Talheim"
    # «Feuerwehr Ta» would read like a bug on a home screen; the Ort is what identifies it
    assert doc["short_name"] == "Talheim"
    assert doc["lang"] == "fr-CH"
    assert doc["theme_color"] == "#c81e1e"
    assert [i["src"] for i in doc["icons"]] == [
        "/api/branding/file/branding/a.png",
        "/api/branding/file/branding/b.png",
    ]
    # the splash background stays the app's own dark shell — see webmanifest.py
    assert doc["background_color"] == _FALLBACK_BASE["background_color"]


def test_empty_and_garbage_config_leave_the_build_manifest_intact():
    for identity in (
        {},
        {"appName": "   ", "accentColor": "", "locale": "", "assets": None},
        {"appName": None, "accentColor": "rot bitte", "locale": "de_CH!", "assets": {"iconPng192": 42}},
    ):
        doc = build_manifest(_FALLBACK_BASE, identity)
        assert doc["name"] == _FALLBACK_BASE["name"]
        assert doc["short_name"] == _FALLBACK_BASE["short_name"]
        assert doc["theme_color"] == _FALLBACK_BASE["theme_color"]
        assert doc["icons"] == _FALLBACK_BASE["icons"]
        assert "lang" not in doc


def test_a_station_icon_replaces_the_maskable_one_and_keeps_the_missing_size():
    """Android prefers a maskable icon, so keeping ours would show the kp-front mark on the
    one launcher this feature exists for. The size the station did NOT upload keeps the
    bundled entry, so install and splash still have an icon of every size."""
    doc = build_manifest(_FALLBACK_BASE, {"assets": {"iconPng192": "/api/branding/file/branding/a.png"}})
    purposes = [i.get("purpose") for i in doc["icons"]]
    assert "maskable" not in purposes
    by_size = {i["sizes"]: i["src"] for i in doc["icons"]}
    assert by_size["192x192"] == "/api/branding/file/branding/a.png"
    assert by_size["512x512"] == "icons/icon-512.png"


# --- the route -------------------------------------------------------------------------


async def test_manifest_is_public_and_valid_without_any_config(client):
    """No login, no config row: still a valid, named, no-cache manifest."""
    r = await client.get("/manifest.webmanifest")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/manifest+json")
    assert r.headers["cache-control"] == "no-cache"
    doc = r.json()
    assert doc["name"] and doc["start_url"] and doc["icons"]
    # nothing station-specific has been uploaded, so no branding URLs may appear
    assert not [i for i in doc["icons"] if str(i["src"]).startswith("/api/branding/")]


async def test_manifest_reflects_the_stations_identity(client, editor, admin_login):
    await _login(client, editor)
    await admin_login(client)
    put = await client.put(
        "/api/config",
        json={"identity": {"appName": "Feuerwehr Talheim", "accentColor": "#c81e1e"}},
    )
    assert put.status_code == 200, put.text

    up = await client.post(
        "/api/branding/iconPng512",
        files={"file": ("icon.png", _png(512, 512), "image/png")},
    )
    assert up.status_code == 200, up.text
    icon_url = up.json()["identity"]["assets"]["iconPng512"]

    r = await client.get("/manifest.webmanifest")
    doc = r.json()
    assert doc["name"] == "Feuerwehr Talheim"
    assert doc["short_name"] == "Talheim"
    assert doc["theme_color"] == "#c81e1e"
    assert {"src": icon_url, "sizes": "512x512", "type": "image/png", "purpose": "any"} in doc["icons"]


# --- upload validation -----------------------------------------------------------------


async def test_install_icon_rejects_a_non_png(client, editor, admin_login):
    await _login(client, editor)
    await admin_login(client)
    # a browser will happily label an SVG as image/svg+xml — allowed for the logo, useless
    # as an install icon, so the BYTES decide
    r = await client.post(
        "/api/branding/iconPng192",
        files={"file": ("icon.svg", b"<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml")},
    )
    assert r.status_code == 415
    assert "PNG" in r.json()["detail"]


@pytest.mark.parametrize(
    ("size", "needle"),
    [((64, 64), "192×192"), ((256, 128), "quadratisch"), ((2048, 2048), "192×192")],
)
async def test_install_icon_rejects_unusable_dimensions(client, editor, admin_login, size, needle):
    await _login(client, editor)
    await admin_login(client)
    r = await client.post(
        "/api/branding/iconPng192",
        files={"file": ("icon.png", _png(*size), "image/png")},
    )
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert needle in detail
    # the message names what was actually uploaded, not just the rule
    assert f"{size[0]}×{size[1]}" in detail


def test_png_size_reads_the_header():
    assert _png_size(_png(192, 192)) == (192, 192)
    assert _png_size(b"not a png at all, really not") is None


def test_every_icon_slot_is_an_uploadable_slot():
    from app.api.branding import _SLOTS

    assert set(_ICON_SLOTS) <= set(_SLOTS)

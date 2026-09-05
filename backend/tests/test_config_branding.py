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


async def test_a_branding_upload_keeps_the_config_it_replaced(client, editor, admin_login, session_factory):
    """A logo upload rewrites the WHOLE document (`_set_asset` normalizes and reassigns it), so it
    is a config write like any other — and it was one of two paths with no undo, while
    docs/CONFIGURATION.md promised history on every one of them."""
    from sqlalchemy import select

    from app.models import DeploymentConfigHistory

    await _login(client, editor)
    await admin_login(client)
    await client.put("/api/config", json={"identity": {"appName": "Testwehr"}})  # nothing to keep yet
    up = await client.post("/api/branding/logo", files={"file": ("logo.png", _PNG, "image/png")})
    assert up.status_code == 200, up.text

    # ⚠️ through the TEST session factory — app.database.async_session_maker is the app's own engine
    async with session_factory() as db:
        kept = (await db.execute(select(DeploymentConfigHistory))).scalars().all()
    assert [k.source for k in kept] == ["branding"]
    assert kept[0].config_json["identity"]["appName"] == "Testwehr"


async def test_db_direct_branding_load_keeps_the_config_it_replaced(
    client, editor, admin_login, session_factory, monkeypatch, tmp_path
):
    from sqlalchemy import select

    from app import admin_branding, database, storage
    from app.models import DeploymentConfigHistory

    await _login(client, editor)
    await admin_login(client)
    await client.put("/api/config", json={"identity": {"appName": "Testwehr"}})

    logo = tmp_path / "logo.png"
    logo.write_bytes(_PNG)
    monkeypatch.setattr(database, "async_session_maker", session_factory)
    monkeypatch.setattr(storage, "put_bytes", lambda _key, _data: None)

    url = await admin_branding._load("logo", logo)

    assert url == "/api/branding/file/branding/logo.png"
    async with session_factory() as db:
        kept = (await db.execute(select(DeploymentConfigHistory))).scalars().all()
    assert [row.source for row in kept] == ["branding"]
    assert kept[0].config_json["identity"]["appName"] == "Testwehr"


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


async def test_config_put_cannot_strip_an_uploaded_asset(client, editor, admin_login):
    """A full-document PUT must not be able to null a branding slot.

    The Verwaltung holds the config in a client-side draft and replaces the whole document on
    every autosave, so a draft loaded BEFORE a logo was installed (from the CLI, from another
    device, by the nightly demo reset) used to put it back to null the next time anybody nudged
    an unrelated field — silently. That is how the public demo lost its brandmark three times.
    """
    await _login(client, editor)
    await admin_login(client)
    up = await client.post("/api/branding/logo", files={"file": ("logo.png", _PNG, "image/png")})
    url = up.json()["identity"]["assets"]["logo"]
    assert url

    # a stale draft: the whole document, with assets as the client last saw them (empty)
    stale = await client.put(
        "/api/config",
        json={"identity": {"appName": "Testwehr", "assets": {"logo": None, "favicon": None}}},
    )
    assert stale.status_code == 200, stale.text
    # the echo the admin UI re-seeds from carries the real URL, not the null it sent…
    assert stale.json()["identity"]["assets"]["logo"] == url
    assert stale.json()["identity"]["appName"] == "Testwehr"  # everything else IS the body
    # …and so does the next GET
    got = await client.get("/api/config")
    assert got.json()["identity"]["assets"]["logo"] == url


async def test_branding_delete_still_clears_after_a_put(client, editor, admin_login):
    """Removing a logo goes through DELETE /api/branding/{slot} — which must still work.
    `_keep_assets` carries over only slots that are SET, so the delete is not undone by the
    next config save."""
    await _login(client, editor)
    await admin_login(client)
    await client.post("/api/branding/logo", files={"file": ("logo.png", _PNG, "image/png")})
    rm = await client.delete("/api/branding/logo")
    assert rm.json()["identity"]["assets"]["logo"] is None
    after = await client.put("/api/config", json={"identity": {"appName": "Testwehr"}})
    assert after.json()["identity"]["assets"]["logo"] is None


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


# --- optimistic concurrency: a stale tab cannot silently revert the station ----------


async def test_a_put_with_a_stale_version_is_refused(client, editor, admin_login):
    """⚠️ THE bug this guards: the Verwaltung holds the config in a client-side draft and
    replaces the whole document on every autosave. A tab open since breakfast therefore reverted
    everything anybody had changed since — Dienstgrade, Partnerorganisationen, the Atemschutz
    doctrine including the Alarmdruck — on the next nudge of one unrelated field, with no error
    and no diff to look at. Refused, so the client re-reads before it decides.
    """
    await _login(client, editor)
    await admin_login(client)
    first = await client.put("/api/config", json={"identity": {"appName": "Erste"}})
    stale = first.json()["version"]
    assert stale

    # somebody else (or the CLI) writes in the meantime
    await client.put("/api/config", json={"identity": {"appName": "Zweite"}})

    conflict = await client.put("/api/config", json={"identity": {"appName": "Erste"}}, headers={"If-Match": stale})
    assert conflict.status_code == 409, conflict.text
    # …and the newer document is untouched
    assert (await client.get("/api/config")).json()["identity"]["appName"] == "Zweite"


async def test_the_version_advances_so_the_next_save_goes_through(client, editor, admin_login):
    """The token handed back must be the NEW one — otherwise a client that saves twice in a row
    conflicts with a document only it has ever touched."""
    await _login(client, editor)
    await admin_login(client)
    v1 = (await client.put("/api/config", json={"identity": {"appName": "A"}})).json()["version"]
    r2 = await client.put("/api/config", json={"identity": {"appName": "B"}}, headers={"If-Match": v1})
    assert r2.status_code == 200, r2.text
    v2 = r2.json()["version"]
    r3 = await client.put("/api/config", json={"identity": {"appName": "C"}}, headers={"If-Match": v2})
    assert r3.status_code == 200, r3.text


async def test_a_put_without_the_header_still_writes(client, editor, admin_login):
    """`admin_config load`, the geodata push and the backup importer are deliberate one-shot
    pushes by somebody at a terminal — not a tab that has been open for an hour. Omitting the
    token keeps them working exactly as before."""
    await _login(client, editor)
    await admin_login(client)
    await client.put("/api/config", json={"identity": {"appName": "Erste"}})
    later = await client.put("/api/config", json={"identity": {"appName": "CLI"}})
    assert later.status_code == 200
    assert (await client.get("/api/config")).json()["identity"]["appName"] == "CLI"


async def test_a_browser_put_without_the_version_is_refused(client, editor, admin_login):
    """⚠️ The hole the first version of this guard left open.

    Making `If-Match` merely optional protects only tabs new enough to send it — and the tab that
    does the damage is by definition an OLD one, open since before the guard shipped. It sends no
    header, is indistinguishable from a CLI push, and overwrites. The public demo was clobbered a
    second time exactly that way, hours after the guard went live.

    A browser always sends `Sec-Fetch-Site`; httpx and curl do not. So a request that looks like a
    browser must carry the version, and gets 428 (this page is stale) when it does not.
    """
    await _login(client, editor)
    await admin_login(client)
    await client.put("/api/config", json={"identity": {"appName": "Erste"}})

    stale_tab = await client.put(
        "/api/config",
        json={"identity": {"appName": "Von einem alten Tab"}},
        headers={"Sec-Fetch-Site": "same-origin"},
    )
    assert stale_tab.status_code == 428, stale_tab.text
    # …and it changed nothing
    assert (await client.get("/api/config")).json()["identity"]["appName"] == "Erste"


async def test_an_origin_header_counts_as_a_browser_too(client, editor, admin_login):
    """A same-origin write carries `Origin` even where `Sec-Fetch-*` is absent (older Safari).

    Own origin on purpose: a FOREIGN origin is now refused earlier (403) by the
    SEC-12 origin gate — this test is about browser detection, not CSRF.
    """
    await _login(client, editor)
    await admin_login(client)
    r = await client.put(
        "/api/config",
        json={"identity": {"appName": "X"}},
        headers={"Origin": "http://test"},
    )
    assert r.status_code == 428


async def test_a_browser_put_with_a_current_version_still_writes(client, editor, admin_login):
    """The guard must not break the Verwaltung itself — a current tab saves normally."""
    await _login(client, editor)
    await admin_login(client)
    first = await client.put("/api/config", json={"identity": {"appName": "Erste"}})
    v = first.json()["version"]
    ok = await client.put(
        "/api/config",
        json={"identity": {"appName": "Zweite"}},
        headers={"Sec-Fetch-Site": "same-origin", "If-Match": v},
    )
    assert ok.status_code == 200, ok.text
    assert (await client.get("/api/config")).json()["identity"]["appName"] == "Zweite"


async def test_a_branding_upload_hands_back_the_new_version(client, editor, admin_login):
    """⚠️ Uploading a logo must return the version of the document it just wrote.

    It did not: both branding endpoints called `_projection(doc)` and the `version` parameter
    defaults to None. The Verwaltung keeps the version it read (`safe.version ?? versionRef`),
    so after an upload the tab still held the PRE-upload hash — and the admin's very next
    keystroke PUT a stale `If-Match` and was told, alone in the building, that somebody else had
    changed the configuration. Uploading the brandmark is usually a new station's first action.
    """
    await _login(client, editor)
    await admin_login(client)
    before = (await client.get("/api/config")).json()["version"]

    up = await client.post(
        "/api/branding/logo",
        files={"file": ("logo.png", b"\x89PNG\r\n\x1a\n" + b"0" * 32, "image/png")},
    )
    assert up.status_code == 200, up.text
    returned = up.json()["version"]

    assert returned is not None, "the upload response carried no version at all"
    assert returned != before, "the document changed, so its version must have changed with it"
    assert returned == (await client.get("/api/config")).json()["version"]

    # …and the version it handed back is one the next save is allowed to use
    ok = await client.put(
        "/api/config",
        json={"identity": {"appName": "Nach dem Logo"}},
        headers={"Sec-Fetch-Site": "same-origin", "If-Match": returned},
    )
    assert ok.status_code == 200, ok.text


async def test_an_uploaded_filename_cannot_choose_what_the_browser_executes(client, editor, admin_login):
    """The stored extension comes from the VALIDATED content type, never from the filename.

    `serve_branding` is public by design — the login screen needs the logo before anybody signs
    in — and it derives the response's Content-Type from the stored key. So a filename that
    picked the extension picked what the browser would run: `Content-Type: image/png` (which
    passes the allowlist) plus `filename="logo.html"` was stored as `…/<uuid>.html` and came
    back as `text/html` from the app's own origin. Persistent same-origin XSS against every
    viewer, editor and Einsatz-Link holder, surviving a config restore because the blob is
    never deleted.
    """
    await _login(client, editor)
    await admin_login(client)

    up = await client.post("/api/branding/logo", files={"file": ("logo.html", _PNG, "image/png")})
    assert up.status_code == 200, up.text
    url = up.json()["identity"]["assets"]["logo"]
    assert url.endswith(".png"), f"the filename chose the extension: {url}"

    served = await client.get(url)
    assert served.status_code == 200
    assert served.headers["content-type"].startswith("image/png")


async def test_branding_files_are_served_with_nosniff_and_a_csp(client, editor, admin_login):
    """The headers that keep an SVG logo from being a script.

    ⚠️ SVG STAYS ALLOWED — stations legitimately only have their mark as one — and an SVG is a
    document: navigate straight to it and any `<script>` inside runs on this origin. `sandbox`
    plus a `default-src 'none'` fallback for `script-src` is what stops that, so these headers
    are load-bearing rather than decorative. `nosniff` covers the other half: a browser deciding
    for itself that a PNG looked more interesting than a PNG.
    """
    await _login(client, editor)
    await admin_login(client)
    up = await client.post("/api/branding/logo", files={"file": ("logo.png", _PNG, "image/png")})
    served = await client.get(up.json()["identity"]["assets"]["logo"])

    assert served.headers["x-content-type-options"] == "nosniff"
    csp = served.headers["content-security-policy"]
    assert "default-src 'none'" in csp
    assert "sandbox" in csp

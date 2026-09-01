"""``/manifest.webmanifest`` — the installed PWA carries the STATION's identity, not ours.

A station sets ``identity.appName``, an accent colour and (via the branding slots) its own
app icons, and every surface becomes theirs — except the one the crew actually taps. The
manifest is baked at BUILD time by ``vite-plugin-pwa`` (vite.config.ts), so a single image
serving many brigades would put «kp-front» on every tablet's home screen forever.

So this route shadows the built file: it reads ``dist/manifest.webmanifest`` as the base
(everything the build decided — display, scope, shortcuts, launch_handler — stays exactly as
configured there, in ONE place) and overlays only the identity-carrying fields from the
deployment config:

    name             ← identity.appName
    short_name       ← identity.appName, shortened (see _short_name)
    lang             ← identity.locale
    theme_color      ← identity.accentColor
    icons[]          ← identity.assets.iconPng192 / iconPng512  (public /api/branding/file/…)
    shortcuts[].icons← identity.assets.iconPng192

``background_color`` is deliberately NOT taken from the accent colour: it is the splash
screen the OS paints before the first frame, and it has to match what the app paints — the
dark shell. Tinting it brand-red would make every cold start flash red and then go dark.

⚠️ THREE THINGS THIS ROUTE MUST NEVER DO
  • 500 — it is fetched by every tablet on every load. A missing config row, an empty
    document, a garbage accent colour and an absent ``dist/`` all degrade to the build-time
    manifest, never to an error.
  • be cached — ``Cache-Control: no-cache``, and the service worker must not precache it
    either (vite.config.ts strips it from the precache list via ``manifestTransforms``;
    without that the SW serves the manifest captured at INSTALL time and a rebrand never
    reaches the device).
  • require auth — a manifest is fetched by the browser itself, with no session.

⚠️ iOS caveat, surfaced to the operator in the admin UI: iOS captures the home-screen icon
when the app is added and never re-reads the manifest. A tablet that already has kp-front on
its home screen keeps the old icon until it is removed and re-added. Nothing here can fix
that; the admin UI says so.
"""

import json
import logging
import os
import re
from typing import Any

from fastapi import Depends, FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import Response

from .config import settings
from .database import get_db
from .models import DeploymentConfig

logger = logging.getLogger(__name__)

MANIFEST_PATH = "/manifest.webmanifest"

#: Last resort only — used when ``dist/manifest.webmanifest`` is absent or unreadable (API
#: running standalone against a Vite dev server, or a broken build). It is intentionally the
#: minimum a browser needs to treat the app as installable; the real values live in
#: vite.config.ts and are read from the built file whenever there is one.
_FALLBACK_BASE: dict[str, Any] = {
    "name": "kp-front Einsatzkarte",
    "short_name": "kp-front",
    "start_url": "/",
    "scope": "/",
    "display": "standalone",
    "background_color": "#1b2330",
    "theme_color": "#1b2330",
    "icons": [
        {"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
        {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
        {"src": "icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
}

#: Home screens truncate anyway, but a `short_name` that is itself a truncation ("Feuerwehr
#: Ta") reads like a bug. 12 is the length Android/iOS show before they elide.
_SHORT_NAME_MAX = 12

#: `theme_color` must be a CSS colour the browser can parse; an unparseable one makes some
#: Chromium versions reject the whole manifest. `identity.accentColor` is free text in the
#: admin editor (the colour picker writes hex, the text field next to it accepts anything),
#: so only hex is trusted through — anything else keeps the build-time colour.
_HEX_COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")

#: BCP-47-ish: 'de', 'de-CH', 'fr'. Same shape the frontend's locale resolver accepts.
_LANG_TAG = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")

#: The built manifest changes only when the image does, so it is read once per process.
_base_cache: dict[str, Any] | None = None


def _load_base() -> dict[str, Any]:
    """The built manifest as the overlay base; the fallback above when there is no build."""
    global _base_cache
    if _base_cache is not None:
        return _base_cache
    path = os.path.join(
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", settings.spa_dir)),
        "manifest.webmanifest",
    )
    try:
        with open(path, encoding="utf-8") as fh:
            loaded = json.load(fh)
        if not isinstance(loaded, dict) or not loaded:
            raise ValueError("manifest is not a non-empty object")
        _base_cache = loaded
    except Exception:  # noqa: BLE001 — no build, bad JSON, unreadable file: all mean "no base"
        logger.info("No usable %s — serving the built-in manifest base instead.", path)
        _base_cache = dict(_FALLBACK_BASE)
    return _base_cache


def _short_name(app_name: str) -> str:
    """A home-screen label for `appName`. Swiss station names are «<Rolle> <Ort>», and the
    Ort is the half that identifies it — «Feuerwehr Oberwil» → «Oberwil». Only when that
    doesn't fit either do we cut the string."""
    if len(app_name) <= _SHORT_NAME_MAX:
        return app_name
    last = app_name.split()[-1] if app_name.split() else ""
    if 0 < len(last) <= _SHORT_NAME_MAX:
        return last
    return app_name[:_SHORT_NAME_MAX].rstrip()


def _icons(base_icons: list[Any], icon192: str | None, icon512: str | None) -> list[Any]:
    """Merge the station's uploaded icons over the bundled ones.

    A size the station did not upload keeps the bundled entry, so install and splash always
    have an icon of every size. The bundled MASKABLE entry is dropped as soon as any custom
    icon exists: Android prefers a maskable icon over an 'any' one, so keeping ours would
    show the kp-front mark on exactly the launcher this feature is about. A station icon is
    not claimed to be maskable — it has no guaranteed safe zone, and Android pads an 'any'
    icon itself rather than cropping the station's mark.
    """
    if not icon192 and not icon512:
        return base_icons
    custom = {"192x192": icon192, "512x512": icon512}
    out: list[Any] = []
    for size, src in custom.items():
        if src:
            out.append({"src": src, "sizes": size, "type": "image/png", "purpose": "any"})
    for entry in base_icons:
        if not isinstance(entry, dict):
            continue
        if "maskable" in str(entry.get("purpose") or ""):
            continue
        if custom.get(str(entry.get("sizes") or "")):
            continue
        out.append(entry)
    return out


def build_manifest(base: dict[str, Any], identity: dict[str, Any]) -> dict[str, Any]:
    """The served manifest: `base` with the identity-carrying fields overlaid.

    Pure and total — every field is optional and any unusable value leaves the base value in
    place, so an empty/garbage config yields exactly the built manifest.
    """
    out = dict(base)

    app_name = identity.get("appName")
    if isinstance(app_name, str) and app_name.strip():
        out["name"] = app_name.strip()
        out["short_name"] = _short_name(app_name.strip())

    locale = identity.get("locale")
    if isinstance(locale, str) and _LANG_TAG.match(locale.strip()):
        out["lang"] = locale.strip()

    accent = identity.get("accentColor")
    if isinstance(accent, str) and _HEX_COLOR.match(accent.strip()):
        out["theme_color"] = accent.strip()

    assets = identity.get("assets")
    assets = assets if isinstance(assets, dict) else {}
    icon192 = assets.get("iconPng192") if isinstance(assets.get("iconPng192"), str) else None
    icon512 = assets.get("iconPng512") if isinstance(assets.get("iconPng512"), str) else None
    base_icons = out.get("icons")
    out["icons"] = _icons(base_icons if isinstance(base_icons, list) else [], icon192, icon512)

    # The long-press shortcuts carry the bundled 192 icon; rebrand those too, or the station's
    # own home-screen icon opens a menu still showing ours.
    shortcuts = out.get("shortcuts")
    if icon192 and isinstance(shortcuts, list):
        out["shortcuts"] = [
            {**s, "icons": [{"src": icon192, "sizes": "192x192", "type": "image/png"}]}
            if isinstance(s, dict) and s.get("icons")
            else s
            for s in shortcuts
        ]
    return out


async def _identity(db: AsyncSession) -> dict[str, Any]:
    """`identity` from the singleton config row — `{}` on any problem. Never raises: a
    database blip must not cost every tablet its manifest."""
    try:
        row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    except Exception:
        logger.exception("Manifest: reading the deployment config failed (serving the build defaults)")
        return {}
    cfg = (row.config_json if (row and row.config_json) else None) or {}
    identity = cfg.get("identity") if isinstance(cfg, dict) else None
    return identity if isinstance(identity, dict) else {}


def register_manifest_route(app: FastAPI) -> None:
    """Register GET /manifest.webmanifest. MUST run before ``mount_spa`` — the SPA fallback
    is a catch-all ``/{full_path:path}`` and would otherwise serve the built file verbatim."""

    @app.get(MANIFEST_PATH, response_model=None, tags=["branding"])
    async def webmanifest(db: AsyncSession = Depends(get_db)) -> Response:
        """PUBLIC (no auth — the browser fetches this with no session): the PWA manifest,
        with the station's name, colour and app icons overlaid onto the built one."""
        doc = build_manifest(_load_base(), await _identity(db))
        return Response(
            content=json.dumps(doc, ensure_ascii=False),
            media_type="application/manifest+json",
            # Revalidate on every load: the manifest changes when the station edits its
            # config, not when a new build is deployed. See the module docstring.
            headers={"Cache-Control": "no-cache"},
        )

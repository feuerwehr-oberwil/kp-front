"""Branding assets: runtime-uploadable logo + favicon (Batch A · A2).

A single kp-front build serves many brigades. The logo and favicon are uploaded here at
runtime (no rebuild), stored as blobs, and their public URLs are written into the singleton
deployment-config document under ``identity.assets[slot]``. The login screen reads them via
the PUBLIC ``GET /api/branding/file/{key}`` (branding must render BEFORE auth).

The PWA install icons (``iconPng192`` / ``iconPng512``) are uploaded here too, and
``app/webmanifest.py`` serves them in a per-deployment ``/manifest.webmanifest`` — so the
home-screen icon on the crew's tablet becomes the station's as well.
"""

import mimetypes

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import storage
from ..auth.dependencies import CurrentAdmin, OptionalUser
from ..config import settings
from ..config_history import keep_previous
from ..database import get_db
from ..models import DeploymentConfig
from ..schemas import DeploymentConfigIn, DeploymentConfigOut, load_stored_config
from .config import _projection, _version

router = APIRouter(prefix="/branding", tags=["branding"])

#: `reportLogo` is the letterhead on the printed Einsatzrapport. Its own slot rather than a
#: reuse of `logo`: the app's brandmark is read on a screen at a glance, the rapport's is read
#: on paper by a Gemeinde or a Versicherung — stations legitimately want a different mark there,
#: and one that carries the full name reads badly in a header. Falls back to `logo` when unset,
#: so nobody has to upload twice to get a sensible sheet.
_SLOTS = ("logo", "favicon", "reportLogo", "iconPng192", "iconPng512")

#: Home-screen / install icons, slot → the edge length the manifest declares for it. Unlike
#: the free-form slots above these are consumed by the OS launcher, not by our own CSS, so
#: they are validated before they are stored (see `_check_icon`): a manifest entry that says
#: `192x192 image/png` and points at a 40 KB JPEG is silently ignored by Chromium, and the
#: operator's only feedback would be a home-screen icon that never changed.
_ICON_SLOTS = {"iconPng192": 192, "iconPng512": 512}

#: Accepted upload size for an icon slot, as a multiple of the nominal edge. Exactly the
#: nominal size is the ideal; a larger square downsamples cleanly and is worth accepting
#: (icon exports are often 1024²), while a smaller one would be upscaled and look it.
_ICON_MAX_SCALE = 4

# Allowlist: only image types we can store and serve back safely. Anything else
# (svg-as-script aside, executables, html, octet-stream) is rejected 415.
_ALLOWED = {
    "image/svg+xml": ".svg",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
}


def _png_size(data: bytes) -> tuple[int, int] | None:
    """(width, height) of a PNG, or None if these bytes are not one.

    The IHDR chunk is fixed-offset and mandatory-first in every valid PNG, so this needs no
    image library — 24 bytes of header is the whole format question being asked here.
    """
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def _check_icon(slot: str, data: bytes) -> None:
    """Refuse an install icon that the launcher would reject, saying what was wrong.

    Raises 415 for anything that isn't a PNG and 422 for a PNG of an unusable shape.
    No-op for the non-icon slots.
    """
    nominal = _ICON_SLOTS.get(slot)
    if nominal is None:
        return
    size = _png_size(data)
    if size is None:
        raise HTTPException(
            status_code=415,
            detail=f"App-Icons müssen PNG-Dateien sein — «{slot}» hat keine gültige PNG-Datei erhalten.",
        )
    width, height = size
    if width != height:
        raise HTTPException(
            status_code=422,
            detail=f"App-Icons müssen quadratisch sein (hochgeladen: {width}×{height} Pixel).",
        )
    if width < nominal or width > nominal * _ICON_MAX_SCALE:
        raise HTTPException(
            status_code=422,
            detail=(
                f"App-Icon «{slot}» braucht {nominal}×{nominal} Pixel "
                f"(bis {nominal * _ICON_MAX_SCALE}×{nominal * _ICON_MAX_SCALE} wird verkleinert) — "
                f"hochgeladen: {width}×{height} Pixel."
            ),
        )


def _ext_for(filename: str | None, content_type: str) -> str:
    """The stored file's extension, decided by the VALIDATED content type and nothing else.

    ⚠️ This used to prefer the uploaded filename's extension, and `serve_branding` below derives
    the response's `Content-Type` from the stored key — so the two together let the uploader
    choose what the browser would execute. `Content-Type: image/png` (which passes `_ALLOWED`)
    with `filename="logo.html"` stored as `branding/<uuid>.html` and came back as `text/html`
    from the app's OWN origin, on a route that is deliberately public so the login screen can
    render. That is persistent same-origin XSS against every viewer, editor and link holder,
    surviving a config restore because the blob is never deleted.

    The filename adds nothing anyway: `_ALLOWED` has already decided which of six types this is,
    and that mapping names the extension. An unknown type never reaches here (415 before this
    point); the `mimetypes` fallback stays only so a future entry in `_ALLOWED` without an
    explicit extension still gets one.
    """
    return _ALLOWED.get(content_type) or mimetypes.guess_extension(content_type) or ""


async def _load_row(db: AsyncSession) -> DeploymentConfig:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json={})
        db.add(row)
        await db.flush()
    return row


def _set_asset(row: DeploymentConfig, slot: str, url: str | None) -> DeploymentConfigIn:
    """Write identity.assets[slot] = url into the row's config_json, returning the
    validated document (so we can project it back exactly like config.py does)."""
    raw = dict(row.config_json or {})
    identity = dict(raw.get("identity") or {})
    assets = dict(identity.get("assets") or {})
    assets[slot] = url
    identity["assets"] = assets
    raw["identity"] = identity
    # Validate + normalize so the persisted document stays canonical and GET round-trips
    # consistently — but as a STORED document (`schemas · load_stored_config`), which is what
    # `raw` is: this is the singleton row with one asset URL swapped, not a PUT body.
    #
    # ⚠️ It used to be the strict `DeploymentConfigIn.model_validate`, and that made uploading a
    # logo a 500 on any station holding a value that has since grown a rule. `accentColor: "rot"`
    # is exactly that case — `GET /api/config` serves it (dropping the colour), the Verwaltung
    # page renders, and then «Logo hochladen» is the one button that dies, on a document the
    # operator cannot see is the problem. Every other reader of this row already uses the
    # stored-document loader; this was the last strict one.
    doc = load_stored_config(raw)
    row.config_json = doc.model_dump(mode="json")
    return doc


@router.post("/{slot}", response_model=DeploymentConfigOut)
async def upload_branding(
    slot: str,
    _admin: CurrentAdmin,
    actor: OptionalUser,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> DeploymentConfigOut:
    if slot not in _SLOTS:
        raise HTTPException(status_code=404, detail=f"Unbekannter Slot {slot!r}")
    content_type = (file.content_type or "").lower()
    if content_type not in _ALLOWED:
        raise HTTPException(
            status_code=415,
            detail=f"Dateityp {content_type or 'unbekannt'!r} nicht erlaubt (erlaubt: {', '.join(sorted(_ALLOWED))})",
        )
    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Datei zu gross (max. {settings.max_upload_mb} MB)")
    # Content-Type says what the browser THINKS it sent; for the install icons the launcher
    # only cares what the bytes actually are, so those are checked against the bytes.
    _check_icon(slot, data)

    key = storage.new_key("branding", _ext_for(file.filename, content_type))
    storage.put_bytes(key, data)

    row = await _load_row(db)
    # `_set_asset` rewrites the WHOLE document (normalized), so this is a config write like any
    # other and owes the same undo — see app/config_history.
    await keep_previous(db, "branding", actor.id if actor else None)
    doc = _set_asset(row, slot, f"/api/branding/file/{key}")
    row.updated_by = actor.id if actor else None
    await db.flush()
    # ⚠️ WITH the version. Without it the response carries `version: None`, ConfigContext keeps
    # the hash it read BEFORE the upload (`safe.version ?? versionRef.current`), and the admin's
    # next keystroke PUTs a stale If-Match — 409 «Die Konfiguration wurde inzwischen an anderer
    # Stelle geändert» while they are working alone. Uploading the logo is usually the first
    # thing a new station does, so this greeted them on their first edit.
    return _projection(doc, version=_version(row.config_json))


@router.delete("/{slot}", response_model=DeploymentConfigOut)
async def delete_branding(
    slot: str,
    _admin: CurrentAdmin,
    actor: OptionalUser,
    db: AsyncSession = Depends(get_db),
) -> DeploymentConfigOut:
    if slot not in _SLOTS:
        raise HTTPException(status_code=404, detail=f"Unbekannter Slot {slot!r}")
    row = await _load_row(db)
    await keep_previous(db, "branding", actor.id if actor else None)  # see upload_branding
    doc = _set_asset(row, slot, None)  # leaving the orphaned blob is fine
    row.updated_by = actor.id if actor else None
    await db.flush()
    # ⚠️ WITH the version. Without it the response carries `version: None`, ConfigContext keeps
    # the hash it read BEFORE the upload (`safe.version ?? versionRef.current`), and the admin's
    # next keystroke PUTs a stale If-Match — 409 «Die Konfiguration wurde inzwischen an anderer
    # Stelle geändert» while they are working alone. Uploading the logo is usually the first
    # thing a new station does, so this greeted them on their first edit.
    return _projection(doc, version=_version(row.config_json))


@router.get("/file/{key:path}")
async def serve_branding(key: str, db: AsyncSession = Depends(get_db)) -> FileResponse:
    """PUBLIC (no auth) — the login screen needs the logo/favicon before sign-in.

    SECURITY: only serve keys under the ``branding/`` prefix and reject any traversal
    sequence so this endpoint can't be turned into an arbitrary-file read.

    SECURITY, the second half: this route hands back a file an admin uploaded, from the app's
    OWN origin, to anybody at all. Three things keep that from being a script-execution surface:

    * the extension comes from the validated content type (``_ext_for``), so the response type
      is one of the six in ``_ALLOWED`` and never ``text/html``;
    * ``X-Content-Type-Options: nosniff``, so a browser cannot decide for itself that a PNG is
      really something more interesting;
    * a per-response CSP. ⚠️ THIS ONE IS LOAD-BEARING, because ``image/svg+xml`` is on the
      allowlist and stays there — SVG logos are a used feature and a station's mark is often
      only available as one. An SVG is a document: navigate to it directly and any ``<script>``
      inside runs on this origin. ``script-src 'none'`` plus ``sandbox`` stops that while
      leaving the file perfectly good as an ``<img src>``, which is how the app itself uses it.

    ⚠️ The CSP here covers THIS route only. The app has no global CSP, which is a separate and
    wider change — so do not read this header as one.
    """
    if not key.startswith("branding/") or ".." in key:
        raise HTTPException(status_code=404, detail="Nicht gefunden")
    if not storage.exists(key):
        raise HTTPException(status_code=404, detail="Nicht gefunden")
    media_type = mimetypes.guess_type(key)[0] or "application/octet-stream"
    return FileResponse(
        storage.local_path(key),
        media_type=media_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        },
    )

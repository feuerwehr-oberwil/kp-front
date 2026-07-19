"""Branding assets: runtime-uploadable logo + favicon (Batch A · A2).

A single kp-front build serves many brigades. The logo and favicon are uploaded here at
runtime (no rebuild), stored as blobs, and their public URLs are written into the singleton
deployment-config document under ``identity.assets[slot]``. The login screen reads them via
the PUBLIC ``GET /api/branding/file/{key}`` (branding must render BEFORE auth).

PWA install icons (192/512/maskable/apple-touch) are baked at BUILD time in the Vite
manifest and are intentionally NOT uploadable here.
"""

import mimetypes

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import storage
from ..auth.dependencies import CurrentAdmin, OptionalUser
from ..config import settings
from ..database import get_db
from ..models import DeploymentConfig
from ..schemas import DeploymentConfigIn, DeploymentConfigOut
from .config import _projection

router = APIRouter(prefix="/branding", tags=["branding"])

_SLOTS = ("logo", "favicon")

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


def _ext_for(filename: str | None, content_type: str) -> str:
    """Prefer the uploaded filename's extension; fall back to the MIME-derived one."""
    if filename and "." in filename:
        ext = "." + filename.rsplit(".", 1)[-1].lower()
        if 1 < len(ext) <= 6 and ext.isascii():
            return ext
    return _ALLOWED.get(content_type) or mimetypes.guess_extension(content_type) or ""


async def _load_row(db: AsyncSession) -> DeploymentConfig:
    row = (
        await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()
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
    # Validate + normalize through the same pydantic model the PUT path uses, so the
    # persisted document stays canonical and GET round-trips consistently.
    doc = DeploymentConfigIn.model_validate(raw)
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
            detail=f"Dateityp {content_type or 'unbekannt'!r} nicht erlaubt "
            f"(erlaubt: {', '.join(sorted(_ALLOWED))})",
        )
    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Datei zu gross (max. {settings.max_upload_mb} MB)")

    key = storage.new_key("branding", _ext_for(file.filename, content_type))
    storage.put_bytes(key, data)

    row = await _load_row(db)
    doc = _set_asset(row, slot, f"/api/branding/file/{key}")
    row.updated_by = actor.id if actor else None
    await db.flush()
    return _projection(doc)


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
    doc = _set_asset(row, slot, None)  # leaving the orphaned blob is fine
    row.updated_by = actor.id if actor else None
    await db.flush()
    return _projection(doc)


@router.get("/file/{key:path}")
async def serve_branding(key: str, db: AsyncSession = Depends(get_db)) -> FileResponse:
    """PUBLIC (no auth) — the login screen needs the logo/favicon before sign-in.

    SECURITY: only serve keys under the ``branding/`` prefix and reject any traversal
    sequence so this endpoint can't be turned into an arbitrary-file read.
    """
    if not key.startswith("branding/") or ".." in key:
        raise HTTPException(status_code=404, detail="Nicht gefunden")
    if not storage.exists(key):
        raise HTTPException(status_code=404, detail="Nicht gefunden")
    media_type = mimetypes.guess_type(key)[0] or "application/octet-stream"
    return FileResponse(storage.local_path(key), media_type=media_type)

"""Reference data (global): list, download, replace, fetch-trigger (deferred)."""

import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import storage
from ..auth.dependencies import CurrentAdmin, CurrentUser, OptionalUser, UserOrAdmin
from ..database import get_db
from ..models import ReferenceDataset
from ..schemas import ReferenceDatasetOut

router = APIRouter(prefix="/reference", tags=["reference"])

# Allowlist for replace_reference: reference datasets are PDFs (plans), JSON-shaped
# (geojson symbols/geodata, checklist templates), or images (checklist diagram assets).
# Reject anything else with 415. Some browsers send application/octet-stream for .geojson —
# allow it only when the id is a geo:/symbols:/checklists: JSON slot (those are JSON-parsed below).
_ALLOWED_REFERENCE_TYPES = {
    "application/pdf",
    "application/json",
    "application/geo+json",
    "text/json",
}
# Checklist diagram assets (checklists:<id>:p<N>) — the playbook figures.
_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/svg+xml"}


def _checklist_role(dataset_id: str) -> str | None:
    """Classify a `checklists:` dataset id: 'template' (`checklists:fu-aktion`, a JSON
    ChecklistTemplate) vs 'asset' (`checklists:el-playbook:p12`, a diagram image). Returns
    None for non-checklist ids. Assets carry a second colon-separated segment."""
    if not dataset_id.startswith("checklists:"):
        return None
    return "asset" if ":" in dataset_id[len("checklists:") :] else "template"


def _validate_checklist_template(data: bytes) -> None:
    """Cheap shape check on an uploaded checklist template so a malformed one is rejected at
    upload, not shipped to the field. Requires id/kind/title and exactly one of phases/entries."""
    try:
        tpl = json.loads(data)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=422, detail=f"Checkliste ist kein gültiges JSON: {e}") from e
    if not isinstance(tpl, dict):
        raise HTTPException(status_code=422, detail="Checkliste muss ein JSON-Objekt sein")
    for field in ("id", "kind", "title"):
        if not isinstance(tpl.get(field), str) or not tpl[field].strip():
            raise HTTPException(status_code=422, detail=f"Checkliste: Feld {field!r} fehlt oder ist leer")
    if tpl["kind"] not in ("action", "rapport", "reference"):
        raise HTTPException(status_code=422, detail=f"Checkliste: unbekannte kind {tpl['kind']!r}")
    has_phases = isinstance(tpl.get("phases"), list) and tpl["phases"]
    has_entries = isinstance(tpl.get("entries"), list) and tpl["entries"]
    if bool(has_phases) == bool(has_entries):
        raise HTTPException(
            status_code=422, detail="Checkliste braucht genau eines von 'phases' (action/rapport) oder 'entries' (reference)"
        )


@router.get("", response_model=list[ReferenceDatasetOut])
async def list_reference(_user: UserOrAdmin, db: AsyncSession = Depends(get_db)):
    """Global datasets only (symbols + geodata); per-object plans live under /objects."""
    rows = (
        await db.execute(
            select(ReferenceDataset).where(ReferenceDataset.object_id.is_(None)).order_by(ReferenceDataset.id)
        )
    ).scalars()
    return list(rows)


def _coords_bbox(node, acc: list[float]) -> None:
    """Expand `acc` = [minx, miny, maxx, maxy] over every [lon, lat] pair under a geometry's
    `coordinates` (any nesting: point → multipolygon)."""
    if isinstance(node, (list, tuple)):
        if len(node) >= 2 and isinstance(node[0], (int, float)) and isinstance(node[1], (int, float)):
            x, y = float(node[0]), float(node[1])
            acc[0], acc[1], acc[2], acc[3] = min(acc[0], x), min(acc[1], y), max(acc[2], x), max(acc[3], y)
        else:
            for child in node:
                _coords_bbox(child, acc)


def _feature_bbox(feat: dict) -> tuple[float, float, float, float] | None:
    geom = feat.get("geometry") if isinstance(feat, dict) else None
    if not isinstance(geom, dict):
        return None
    acc = [float("inf"), float("inf"), float("-inf"), float("-inf")]
    _coords_bbox(geom.get("coordinates"), acc)
    for g in geom.get("geometries", []) or []:  # GeometryCollection
        _coords_bbox(g.get("coordinates"), acc)
    return None if acc[0] == float("inf") else (acc[0], acc[1], acc[2], acc[3])


def _overlaps(a: tuple, b: tuple) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


@router.get("/{dataset_id}")
async def download_reference(
    dataset_id: str,
    _user: CurrentUser,
    bbox: str | None = Query(default=None, description="Crop geo: GeoJSON to west,south,east,north"),
    db: AsyncSession = Depends(get_db),
):
    ds = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == dataset_id))).scalar_one_or_none()
    if ds is None or not ds.storage_key or not storage.exists(ds.storage_key):
        raise HTTPException(status_code=404, detail="Datensatz nicht gefunden")
    # Optional spatial crop: the Leitungskataster layers are region-wide (tens of MB); a client
    # caching/rendering only the incident area passes a bbox so we return just the intersecting
    # features. Cheap AABB test on each feature's coordinate bounds (errs toward inclusion).
    if bbox and dataset_id.startswith("geo:"):
        try:
            w, s, e, n = (float(v) for v in bbox.split(","))
            qbox = (min(w, e), min(s, n), max(w, e), max(s, n))
            with open(storage.local_path(ds.storage_key), "rb") as fh:
                fc = json.loads(fh.read())
            feats = fc.get("features") if isinstance(fc, dict) else None
            if isinstance(feats, list):
                kept = [f for f in feats if (bb := _feature_bbox(f)) is None or _overlaps(bb, qbox)]
                return JSONResponse({**fc, "features": kept}, media_type="application/geo+json")
        except (ValueError, TypeError, OSError):
            pass  # malformed bbox / unreadable → fall through to the full file
    return FileResponse(storage.local_path(ds.storage_key), media_type=ds.content_type or None)


@router.put("/{dataset_id}", response_model=ReferenceDatasetOut)
async def replace_reference(
    dataset_id: str,
    _admin: CurrentAdmin,
    actor: OptionalUser,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    source_note: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
) -> ReferenceDataset:
    ds = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == dataset_id))).scalar_one_or_none()
    content_type = file.content_type or "application/octet-stream"
    cl_role = _checklist_role(dataset_id)
    # octet-stream is tolerated only for JSON-backed slots (geo:/symbols:/checklist templates),
    # which are parsed below. Checklist diagram assets accept images instead.
    is_json_slot = dataset_id.startswith(("geo:", "symbols:")) or cl_role == "template"
    if cl_role == "asset":
        if content_type not in _ALLOWED_IMAGE_TYPES and not (content_type == "application/octet-stream"):
            raise HTTPException(
                status_code=415,
                detail=f"Dateityp {content_type!r} nicht erlaubt (Checklisten-Diagramm erwartet ein Bild)",
            )
    elif content_type not in _ALLOWED_REFERENCE_TYPES and not (content_type == "application/octet-stream" and is_json_slot):
        raise HTTPException(
            status_code=415,
            detail=f"Dateityp {content_type!r} nicht erlaubt (erwartet: PDF oder GeoJSON/JSON)",
        )
    data = await file.read()
    if cl_role == "template":
        _validate_checklist_template(data)  # reject a malformed template with 422 before storing
    kind = (
        "checklists"
        if cl_role
        else "geojson"
        if "json" in content_type or dataset_id.startswith("geo:")
        else "symbols"
        if dataset_id.startswith("symbols:")
        else "pdf"
    )
    feature_count = None
    if kind in ("geojson", "symbols"):
        try:
            parsed = json.loads(data)
            if isinstance(parsed, dict) and isinstance(parsed.get("features"), list):
                feature_count = len(parsed["features"])
        except (ValueError, TypeError):
            pass

    key = storage.new_key("reference", f"-{dataset_id.replace(':', '_')}")
    storage.put_bytes(key, data)

    if ds is None:
        ds = ReferenceDataset(id=dataset_id, kind=kind)
        db.add(ds)
    else:
        ds.current_version += 1
    ds.kind = kind
    ds.title = title or ds.title or dataset_id
    ds.source_note = source_note if source_note is not None else ds.source_note
    ds.source_type = "uploaded"
    ds.storage_key = key
    ds.content_type = content_type
    ds.size_bytes = len(data)
    ds.feature_count = feature_count
    ds.updated_by = actor.id if actor else None
    await db.flush()
    await db.refresh(ds)
    return ds


@router.post("/checklists/prune")
async def prune_checklists(keep: list[str], _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    """Delete every ``checklists:*`` reference dataset whose id is NOT in ``keep`` (the manifest's
    current template + asset ids), so a renamed or removed checklist doesn't leave a ghost dataset
    the Checkliste surface would still fetch. Called by ``admin_checklists`` after a push. Admin-gated
    (the push client holds only the admin-session cookie, so it can't use the CurrentUser listing)."""
    keepset = set(keep)
    rows = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id.like("checklists:%")))).scalars().all()
    pruned: list[str] = []
    for ds in rows:
        if ds.id not in keepset:
            if ds.storage_key:
                storage.delete(ds.storage_key)
            await db.delete(ds)
            pruned.append(ds.id)
    return {"pruned": pruned}


@router.post("/{dataset_id}/fetch")
async def fetch_reference(dataset_id: str, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    """Trigger an auto-fetch (SharePoint/Graph sync) — designed-for-later, not wired yet."""
    ds = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == dataset_id))).scalar_one_or_none()
    if ds is None:
        raise HTTPException(status_code=404, detail="Datensatz nicht gefunden")
    if not ds.fetch_url:
        raise HTTPException(status_code=501, detail="Kein Auto-Fetch konfiguriert (manueller Upload)")
    raise HTTPException(status_code=501, detail="Auto-Fetch (SharePoint/Graph) ist noch nicht aktiv")

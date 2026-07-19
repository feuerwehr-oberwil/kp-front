"""Einsatzobjekte + per-object module plans; proximity auto-surface on incidents."""

import re
import unicodedata
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import storage
from ..auth.dependencies import CurrentAdmin, CurrentUser, OptionalUser, UserOrAdmin
from ..database import get_db
from ..geo_util import haversine_m
from ..models import Incident, ObjectSite, ReferenceDataset
from ..schemas import ObjectIn, ObjectOut, ObjectWithPlans, ReferenceDatasetOut

router = APIRouter(prefix="/objects", tags=["objects"])

# PDF-only: per-object module plans are rendered by the PDF viewport. Reject anything else
# with 415 so a non-PDF can't be stored under a `plan:` id and then fail to render / be a vector.
_ALLOWED_PLAN_TYPES = {"application/pdf"}


async def _plans_for(db: AsyncSession, object_id: uuid.UUID) -> list[ReferenceDataset]:
    rows = (
        await db.execute(
            select(ReferenceDataset)
            .where(ReferenceDataset.object_id == object_id)
            .order_by(ReferenceDataset.module)
        )
    ).scalars()
    return list(rows)


async def _plans_by_object(
    db: AsyncSession, object_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[ReferenceDataset]]:
    """Fetch plans for many objects in ONE query and group in Python (avoids per-object N+1).

    Order within each object matches `_plans_for` (by module).
    """
    grouped: dict[uuid.UUID, list[ReferenceDataset]] = {oid: [] for oid in object_ids}
    if not object_ids:
        return grouped
    rows = (
        await db.execute(
            select(ReferenceDataset)
            .where(ReferenceDataset.object_id.in_(object_ids))
            .order_by(ReferenceDataset.module)
        )
    ).scalars()
    for p in rows:
        grouped.setdefault(p.object_id, []).append(p)
    return grouped


@router.get("", response_model=list[ObjectWithPlans])
async def list_objects(
    _user: UserOrAdmin,
    q: str | None = None,
    near: str | None = None,  # "lng,lat"
    db: AsyncSession = Depends(get_db),
):
    query = select(ObjectSite)
    if q:
        query = query.where(ObjectSite.name.ilike(f"%{q}%"))
    objs = list((await db.execute(query.order_by(ObjectSite.name))).scalars())

    ref_lng = ref_lat = None
    if near:
        try:
            ref_lng, ref_lat = (float(x) for x in near.split(","))
        except ValueError as e:
            raise HTTPException(status_code=422, detail="near muss 'lng,lat' sein") from e

    plans_by_obj = await _plans_by_object(db, [o.id for o in objs])
    out: list[ObjectWithPlans] = []
    for o in objs:
        plans = [ReferenceDatasetOut.model_validate(p) for p in plans_by_obj.get(o.id, [])]
        dist = (
            haversine_m(ref_lat, ref_lng, float(o.lat), float(o.lng))
            if ref_lat is not None and o.lat is not None and o.lng is not None
            else None
        )
        item = ObjectWithPlans.model_validate(o)
        item.plans = plans
        item.distance_m = dist
        out.append(item)
    if ref_lat is not None:
        out.sort(key=lambda i: (i.distance_m is None, i.distance_m or 0))
    return out


@router.get("/{object_id}", response_model=ObjectWithPlans)
async def get_object(object_id: uuid.UUID, _user: CurrentUser, db: AsyncSession = Depends(get_db)):
    o = (await db.execute(select(ObjectSite).where(ObjectSite.id == object_id))).scalar_one_or_none()
    if o is None:
        raise HTTPException(status_code=404, detail="Objekt nicht gefunden")
    item = ObjectWithPlans.model_validate(o)
    item.plans = [ReferenceDatasetOut.model_validate(p) for p in await _plans_for(db, o.id)]
    return item


@router.post("", response_model=ObjectOut, status_code=201)
async def create_object(body: ObjectIn, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> ObjectSite:
    o = ObjectSite(**body.model_dump())
    db.add(o)
    await db.flush()
    await db.refresh(o)
    return o


@router.put("/{object_id}", response_model=ObjectOut)
async def upsert_object(
    object_id: uuid.UUID, body: ObjectIn, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)
) -> ObjectSite:
    o = (await db.execute(select(ObjectSite).where(ObjectSite.id == object_id))).scalar_one_or_none()
    if o is None:
        o = ObjectSite(id=object_id)
        db.add(o)
    for k, v in body.model_dump().items():
        setattr(o, k, v)
    await db.flush()
    await db.refresh(o)
    return o


@router.put("/{object_id}/plans/{module}", response_model=ReferenceDatasetOut)
async def upload_plan(
    object_id: uuid.UUID,
    module: str,
    _admin: CurrentAdmin,
    actor: OptionalUser,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    source_note: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
) -> ReferenceDataset:
    o = (await db.execute(select(ObjectSite).where(ObjectSite.id == object_id))).scalar_one_or_none()
    if o is None:
        raise HTTPException(status_code=404, detail="Objekt nicht gefunden")

    content_type = file.content_type or "application/octet-stream"
    if content_type not in _ALLOWED_PLAN_TYPES:
        raise HTTPException(status_code=415, detail=f"Plan muss ein PDF sein (erhalten: {content_type!r})")

    ds_id = f"plan:{object_id}:{module}"
    ds = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == ds_id))).scalar_one_or_none()
    data = await file.read()
    key = storage.new_key(f"plans/{object_id}", f"-{module}.pdf")
    storage.put_bytes(key, data)

    if ds is None:
        ds = ReferenceDataset(id=ds_id, object_id=object_id, module=module, kind="pdf")
        db.add(ds)
    else:
        ds.current_version += 1
    ds.title = title or ds.title or f"{o.name} – {module}"
    ds.source_note = source_note if source_note is not None else ds.source_note
    ds.source_type = "uploaded"
    ds.storage_key = key
    ds.content_type = content_type
    ds.size_bytes = len(data)
    ds.updated_by = actor.id if actor else None
    await db.flush()
    await db.refresh(ds)
    return ds


# Auto-surface the nearest object's plans on an incident.
incidents_objects_router = APIRouter(prefix="/incidents", tags=["objects"])


# Only auto-surface an object whose plans plausibly cover the incident location. Without
# this, a single seeded object surfaces on every incident regardless of distance.
OBJECT_SURFACE_RADIUS_M = 400.0


def _norm_addr(s: str | None) -> str:
    """Normalise an address for matching: fold diacritics (ü→u, NFC vs NFD from macOS
    folder names) then drop punctuation/spaces. So 'Mühlemattstrasse 22' (typed, NFC) and
    the NFD-stored object address compare equal."""
    folded = unicodedata.normalize("NFKD", (s or "").lower())
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", folded)


@incidents_objects_router.get("/{incident_id}/objects", response_model=list[ObjectWithPlans])
async def objects_near_incident(
    incident_id: uuid.UUID, _user: CurrentUser, db: AsyncSession = Depends(get_db)
):
    inc = (await db.execute(select(Incident).where(Incident.id == incident_id))).scalar_one_or_none()
    if inc is None:
        raise HTTPException(status_code=404, detail="Einsatz nicht gefunden")
    objs = list((await db.execute(select(ObjectSite))).scalars())

    # Address match wins over pure proximity: geocoding "Strasse Nr" to a precise building
    # is imprecise and many objects sit within 400 m of each other, so the nearest-by-coords
    # object can be a neighbour. When the incident's address matches an Einsatzobjekt's
    # address, surface THAT object first regardless of distance.
    ia = _norm_addr(inc.address)
    has_coords = inc.lat is not None and inc.lng is not None

    candidates: list[tuple[ObjectSite, float | None, bool]] = []
    for o in objs:
        oa = _norm_addr(o.address)
        matched = bool(ia) and bool(oa) and (ia == oa or oa.startswith(ia) or ia.startswith(oa))
        dist = (
            haversine_m(float(inc.lat), float(inc.lng), float(o.lat), float(o.lng))
            if has_coords and o.lat is not None and o.lng is not None
            else None
        )
        if matched or (dist is not None and dist <= OBJECT_SURFACE_RADIUS_M):
            candidates.append((o, dist, matched))

    # address match first, then by distance (None distance last)
    candidates.sort(key=lambda c: (not c[2], c[1] is None, c[1] or 0))
    plans_by_obj = await _plans_by_object(db, [o.id for o, _, _ in candidates])
    out: list[ObjectWithPlans] = []
    for o, dist, _matched in candidates:
        item = ObjectWithPlans.model_validate(o)
        item.plans = [ReferenceDatasetOut.model_validate(p) for p in plans_by_obj.get(o.id, [])]
        item.distance_m = dist
        out.append(item)
    return out

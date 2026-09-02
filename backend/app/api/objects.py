"""Einsatzobjekte + per-object module plans; proximity auto-surface on incidents."""

import hashlib
import re
import unicodedata
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentAdmin, CurrentUser, OptionalUser, UserOrAdmin
from ..config import settings
from ..database import get_db
from ..geo_util import haversine_m
from ..models import ObjectSite, ReferenceDataset
from ..plans import store_plan
from ..schemas import ObjectIn, ObjectOut, ObjectWithPlans, ReferenceDatasetOut
from .incidents import get_incident_or_404

router = APIRouter(prefix="/objects", tags=["objects"])

# PDF-only: per-object module plans are rendered by the PDF viewport. Reject anything else
# with 415 so a non-PDF can't be stored under a `plan:` id and then fail to render / be a vector.
_ALLOWED_PLAN_TYPES = {"application/pdf"}

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


async def _plans_for(db: AsyncSession, object_id: uuid.UUID) -> list[ReferenceDataset]:
    rows = (
        await db.execute(
            select(ReferenceDataset).where(ReferenceDataset.object_id == object_id).order_by(ReferenceDataset.module)
        )
    ).scalars()
    return list(rows)


async def _plans_by_object(db: AsyncSession, object_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[ReferenceDataset]]:
    """Fetch plans for many objects in ONE query and group in Python (avoids per-object N+1).

    Order within each object matches `_plans_for` (by module).
    """
    grouped: dict[uuid.UUID, list[ReferenceDataset]] = {oid: [] for oid in object_ids}
    if not object_ids:
        return grouped
    rows = (
        await db.execute(
            select(ReferenceDataset).where(ReferenceDataset.object_id.in_(object_ids)).order_by(ReferenceDataset.module)
        )
    ).scalars()
    for p in rows:
        if p.object_id is not None:  # the .in_() filter guarantees this; the column is nullable
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
            if ref_lat is not None and ref_lng is not None and o.lat is not None and o.lng is not None
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


def _check_plan_digest(object_id: uuid.UUID, module: str, data: bytes, declared: str | None, *, machine: bool) -> None:
    """The publish door's wrong-tree guard: a plan must say which bytes it is.

    ⚠️ Read `Settings.require_plan_digest` before changing this. The manifest-side pin added on
    09.08. could not stop the failure it was written for, because an old checkout carries an old
    manifest *and* an old `admin_objects` — the digest and its checker go stale together. Only
    the server is never the stale party, so the refusal has to happen here. A client that cannot
    name the bytes it is uploading is, by construction, older than the guard.

    Two rules, not one:

    * **Whenever a digest IS declared** it is verified, on every deployment. One hash turns a
      truncated or swapped upload into a 400 instead of a plan a crew opens at 3am.
    * **A digest is REQUIRED only of a machine publish** — an admin-secret session with no
      logged-in user, which is exactly `admin_objects push` (`auth/dependencies.get_optional_user`
      spells this split out: the CLI holds the secret and no user). A person who picked a PDF in
      the admin UI is choosing that file deliberately and in front of the plan they replaced;
      refusing them would be a stale-tree message aimed at somebody with no tree. And the
      demo — where the requirement is on by default — must keep its admin surface usable, since
      being clicked through is the whole job it has.
    """
    if declared is None or not declared.strip():
        if not (machine and settings.plan_digest_required):
            return
        raise HTTPException(
            status_code=400,
            detail=(
                f"Plan {module!r} für Objekt {object_id} wurde ohne 'sha256' hochgeladen. Dieses "
                "Deployment nimmt automatisierte Plan-Uploads nur an, wenn sie ihre eigenen Bytes "
                "benennen (REQUIRE_PLAN_DIGEST). Der Client ist älter als diese Prüfung — aus einem "
                "veralteten Checkout zu veröffentlichen ist genau der Fehler, den sie verhindert. "
                "Checkout aktualisieren und erneut veröffentlichen."
            ),
        )
    expected = declared.strip().lower()
    if not _SHA256_RE.match(expected):
        raise HTTPException(status_code=422, detail="'sha256' muss 64 hexadezimale Kleinbuchstaben sein")
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Plan {module!r} für Objekt {object_id}: die Bytes sind nicht die angekündigten "
                f"(erwartet {expected[:12]}…, erhalten {actual[:12]}…, {len(data)} Bytes). "
                "Nichts gespeichert."
            ),
        )


@router.put("/{object_id}/plans/{module}", response_model=ReferenceDatasetOut)
async def upload_plan(
    object_id: uuid.UUID,
    module: str,
    _admin: CurrentAdmin,
    actor: OptionalUser,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    source_note: str | None = Form(default=None),
    sha256: str | None = Form(
        default=None,
        description=(
            "SHA-256 of the PDF, lower-case hex. Verified against the received bytes when given. "
            "Required when the deployment sets REQUIRE_PLAN_DIGEST (the public demo does)."
        ),
    ),
    db: AsyncSession = Depends(get_db),
) -> ReferenceDataset:
    o = (await db.execute(select(ObjectSite).where(ObjectSite.id == object_id))).scalar_one_or_none()
    if o is None:
        raise HTTPException(status_code=404, detail="Objekt nicht gefunden")

    content_type = file.content_type or "application/octet-stream"
    if content_type not in _ALLOWED_PLAN_TYPES:
        raise HTTPException(status_code=415, detail=f"Plan muss ein PDF sein (erhalten: {content_type!r})")

    data = await file.read()
    _check_plan_digest(object_id, module, data, sha256, machine=actor is None)

    # The plan write itself lives in app/plans.py, because it is not only this endpoint's:
    # the snapshot pull writes the same datasets, and the id rule, storage key and version
    # bump have to be decided once for both doors (see that module's docstring).
    return await store_plan(
        db,
        o,
        module,
        data,
        content_type=content_type,
        title=title,
        source_note=source_note,
        actor_id=actor.id if actor else None,
    )


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
async def objects_near_incident(incident_id: uuid.UUID, _user: CurrentUser, db: AsyncSession = Depends(get_db)):
    inc = await get_incident_or_404(db, incident_id)
    objs = list((await db.execute(select(ObjectSite))).scalars())

    # Address match wins over pure proximity: geocoding "Strasse Nr" to a precise building
    # is imprecise and many objects sit within 400 m of each other, so the nearest-by-coords
    # object can be a neighbour. When the incident's address matches an Einsatzobjekt's
    # address, surface THAT object first regardless of distance.
    ia = _norm_addr(inc.address)
    candidates: list[tuple[ObjectSite, float | None, bool]] = []
    for o in objs:
        oa = _norm_addr(o.address)
        matched = bool(ia) and bool(oa) and (ia == oa or oa.startswith(ia) or ia.startswith(oa))
        dist = (
            haversine_m(float(inc.lat), float(inc.lng), float(o.lat), float(o.lng))
            if inc.lat is not None and inc.lng is not None and o.lat is not None and o.lng is not None
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

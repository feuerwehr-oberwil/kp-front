"""Station reference reads OUTSIDE an Einsatz — «Karte & Objekte» (docs/karte-objekte.md).

* ``GET /api/reference/objects`` — every station object (Einsatzobjekte, plan-less catalogue
  objects, key boxes) with its plans, floors and last Objektbesuch, in ONE payload the viewer
  can search client-side and keep for offline.
* ``GET /api/reference/building?lat=&lng=`` — the Gebäude card's facts (app/building_facts,
  via api/building · fill_registers) for any point, without an incident.

Who may come in: an ACCOUNT session (``editor``, ``el``, ``viewer``) and the deployment-admin
session. Every incident link (alarm, view, Atemschutz, terminal) and the Erfassungs-Poster's
capture token get 403: a link is scoped to ONE Einsatz and must never become a door onto the
whole station's register (docs/roles-and-access.md). The app-level link allowlist refuses these
routes too; the dependency below says so itself, so the rule does not hang off a list — the
same shape as api/object_visits · get_reader.

⚠️ Declared on a router of its own and mounted BEFORE api/reference: that router's
``/{dataset_id}`` would otherwise answer ``/objects`` as a dataset called «objects» (404).

Nothing here writes. The viewer's own state (map position, measurements, overlays) never
reaches the server.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from typing import Annotated

import anyio
from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import geocode, object_footprints, plan_tiles
from ..auth.dependencies import _admin_session_valid, get_current_user
from ..auth.incident_link import link_page_owns_session, read_link_session
from ..building_facts import _street_of
from ..database import get_db
from ..models import ObjectSite, ObjectVisit, PlanAlignment, PlanPageFloor, PlanRevision, ReferenceDataset, User
from ..object_visits import checklist_ref, ov_config, refs_by_object
from ..plan_floors import PlanFloor, fit_publishable
from ..plan_revision_info import revision_page_count
from ..schemas import (
    BuildingObjectOut,
    BuildingOut,
    BuildingVisitOut,
    ReferenceFloorOut,
    ReferenceLastVisitOut,
    ReferenceObjectOut,
    ReferenceObjectsOut,
    ReferencePlanOut,
)
from .building import _LANGS, fill_registers, last_visit

router = APIRouter(prefix="/reference", tags=["reference"])

_LINK_REFUSED = HTTPException(
    status_code=status.HTTP_403_FORBIDDEN, detail="Karte & Objekte ist über einen Einsatz-Link nicht erreichbar"
)


def _is_link(user: User | None) -> bool:
    return bool(getattr(user, "link_kind", None)) or bool(getattr(user, "link_scoped", False))


async def get_station_reader(
    request: Request,
    access_token: Annotated[str | None, Cookie()] = None,
    admin_session: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """An account session (its user) or the admin session (None). Links and the poster: 403."""
    if link_page_owns_session(request):
        raise _LINK_REFUSED
    user: User | None = None
    if access_token:
        try:
            user = await get_current_user(request, access_token, db)
        except HTTPException:
            user = None
    if user is not None:
        if _is_link(user):
            raise _LINK_REFUSED
        return user
    if await _admin_session_valid(admin_session):
        return None
    if read_link_session(request) is not None or request.headers.get("x-capture-token"):
        raise _LINK_REFUSED
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Nicht angemeldet")


StationReader = Annotated[User | None, Depends(get_station_reader)]


# --- the objects ------------------------------------------------------------------------------

#: A plan-less object whose name says «Schlüssel…» (Schlüsseldepot, -hülse, -rohr, -kasten) is a
#: key box, and the map draws it as the FKS «GB Schluesseldepot» symbol. The data has no kind
#: column; the organizer's own source for key boxes (``fwo-schlue``) counts as well.
_KEY_BOX = re.compile(r"schl(?:ü|ue|u)ssel", re.IGNORECASE)
_KEY_BOX_SOURCES = ("schlue",)


def object_kind(obj: ObjectSite, has_plans: bool, ref_sources: list[str]) -> str:
    """``einsatzobjekt`` (carries Modul-PDFs) · ``depot`` (a key box) · ``objekt`` (the rest)."""
    if has_plans:
        return "einsatzobjekt"
    if _KEY_BOX.search(obj.name or "") or any(k in s for s in ref_sources for k in _KEY_BOX_SOURCES):
        return "depot"
    return "objekt"


def module_code(module: str | None) -> str:
    """«modul1» → «1», «modul23» → «2/3», «modul5-wasser2» → «5-wasser2»; never empty."""
    m = (module or "").strip()
    rest = m[len("modul") :] if m.lower().startswith("modul") else m
    if len(rest) == 2 and rest.isdigit():
        return f"{rest[0]}/{rest[1]}"
    return rest or m or "?"


def aliases_of(obj: ObjectSite) -> list[str]:
    """Other names for the object a member might type: the plan library's folder
    («Hauptstrasse 24 - Gemeindeverwaltung») when it is not just the name again."""
    folder = (obj.filing_folder or "").strip()
    if folder and folder.casefold() not in {(obj.name or "").casefold(), (obj.address or "").casefold()}:
        return [folder]
    return []


_TRAILING_NOTE = re.compile(r"\s*\([^)]*\)\s*$")


def object_address(obj: ObjectSite, place: dict | None, default_locality: str) -> tuple[str | None, str | None]:
    """``(address, locality)`` for the catalogue — an address for every object where one is
    knowable (owner, 17.10.2026: three key boxes and three objects sent ``null`` and the viewer
    printed «Schlüsseldepot» where the address belonged):

    1. the station's own ``address``;
    2. else the NAME when it is a street + number («Mühlemattstrasse 24», «Bienenstrasse 28 (EH)»
       → «Bienenstrasse 28»): those rows are addresses the import never split;
    3. else the register's address at the pin (``object_footprints.place_at``, asked once by the
       scheduler — never per view).

    ``locality`` is the town only when it is NOT the home town: the station's stored one, else the
    town of the register entry at the pin. The home town is never sent (every row would repeat it).
    """
    address = (obj.address or "").strip() or None
    if address is None:
        bare = _TRAILING_NOTE.sub("", obj.name or "").strip()
        if geocode.has_house_number(bare):
            address = bare
    if address is None and place and place.get("street"):
        address = place["street"]
    town = (obj.locality or "").strip() or None
    plz = None
    if town is None and place and place.get("town"):
        town, plz = place["town"], place.get("plz")
    if town and geocode.is_home(town, plz, default_locality):
        town = None
    return address, town


def _page_counts(keys: list[str]) -> dict[str, int | None]:
    return {k: plan_tiles.stored_page_count(k) for k in keys}


async def reference_objects(db: AsyncSession, *, with_visits: bool) -> ReferenceObjectsOut:
    objects = list((await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars())
    datasets = [
        d
        for d in (
            await db.execute(
                select(ReferenceDataset)
                .where(ReferenceDataset.object_id.is_not(None), ReferenceDataset.storage_key.is_not(None))
                .order_by(ReferenceDataset.module)
            )
        ).scalars()
        if d.kind == "pdf"
    ]
    ids = [d.id for d in datasets]
    current = {d.id: d.current_version for d in datasets}

    revisions: dict[str, str] = {}
    floors: dict[str, list[PlanFloor]] = {}
    approved: dict[str, list[int]] = {}
    if ids:
        for r in (await db.execute(select(PlanRevision).where(PlanRevision.dataset_id.in_(ids)))).scalars():
            if r.version == current.get(r.dataset_id):
                revisions[r.dataset_id] = r.storage_key
        for f in (
            await db.execute(
                select(PlanPageFloor)
                .where(PlanPageFloor.dataset_id.in_(ids))
                .order_by(PlanPageFloor.floor_index, PlanPageFloor.part)
            )
        ).scalars():
            if f.plan_version == current.get(f.dataset_id):
                floors.setdefault(f.dataset_id, []).append(
                    PlanFloor(f.page, f.floor_index, f.floor_name, f.clip, f.join, f.marker, f.part)
                )
        for a in (
            await db.execute(
                select(PlanAlignment).where(PlanAlignment.dataset_id.in_(ids), PlanAlignment.status == "approved")
            )
        ).scalars():
            if a.plan_version == current.get(a.dataset_id):
                approved.setdefault(a.dataset_id, []).append(a.page)

    keys = {d.id: revisions.get(d.id) or d.storage_key or "" for d in datasets}
    pages = await anyio.to_thread.run_sync(_page_counts, [k for k in keys.values() if k])

    plans_by_obj: dict[uuid.UUID, list[ReferencePlanOut]] = {}
    floors_by_obj: dict[uuid.UUID, dict[int, str | None]] = {}
    for d in datasets:
        key = keys[d.id]
        count = pages.get(key)
        georef = False
        if d.id in approved:
            # Same gate as api/reference · dataset_alignments: a fit counts only where the field
            # viewer would apply it. A floor page decides without the page count; only a fit on page
            # 0 of a plan with no manifest yet needs it, which costs a PDF open — and that count
            # stays out of `pages`, which is the manifest's or null.
            pack = floors.get(d.id, [])
            georef = any(fit_publishable(count, p, pack) for p in approved[d.id])
            if not georef and count is None and key and 0 in approved[d.id]:
                georef = fit_publishable(await revision_page_count(key), 0, pack)
        if d.object_id is None:  # the query filtered on it; this narrows the type
            continue
        plans_by_obj.setdefault(d.object_id, []).append(
            ReferencePlanOut(
                id=d.id,
                module=d.module,
                code=module_code(d.module),
                title=d.title or module_code(d.module),
                pages=count,
                georef=georef,
                version=d.current_version,
                updated_at=d.updated_at,
            )
        )
        named = floors_by_obj.setdefault(d.object_id, {})
        for fl in floors.get(d.id, []):
            if named.get(fl.index) is None:
                named[fl.index] = fl.name

    last: dict[uuid.UUID, ReferenceLastVisitOut] = {}
    if with_visits:
        rows = (
            await db.execute(
                select(
                    ObjectVisit.id, ObjectVisit.object_id, ObjectVisit.visited_at, ObjectVisit.findings, ObjectVisit.doc
                )
                .where(
                    ObjectVisit.lifecycle == "completed",
                    ObjectVisit.object_id.is_not(None),
                    ObjectVisit.visited_at.is_not(None),
                )
                .order_by(ObjectVisit.visited_at)
            )
        ).all()
        for v in rows:  # ascending, so the last one written per object is its newest
            ref = checklist_ref(v.doc or {})
            last[v.object_id] = ReferenceLastVisitOut(
                id=v.id, checklist=ref.get("title") if ref else None, date=v.visited_at, defects=v.findings or 0
            )

    refs = await refs_by_object(db)
    default_locality, _bbox = await geocode._resolve_bias()
    out: list[ReferenceObjectOut] = []
    for o in objects:
        plans = plans_by_obj.get(o.id, [])
        lat = float(o.lat) if o.lat is not None else None
        lng = float(o.lng) if o.lng is not None else None
        address, locality = object_address(o, object_footprints.place_at(lat, lng), default_locality)
        outline = o.outline if o.outline in ("building", "none") else "auto"
        out.append(
            ReferenceObjectOut(
                id=o.id,
                name=o.name,
                kind=object_kind(o, bool(plans), [r["source"] for r in refs.get(o.id, [])]),  # type: ignore[arg-type]
                address=address,
                locality=locality,
                lat=lat,
                lng=lng,
                outline=outline,  # type: ignore[arg-type]
                aliases=aliases_of(o),
                # every building the object stands for, derived by the scheduler from official
                # data (app/object_footprints); None = the viewer draws the OSM building its
                # point lies in
                footprint=None if outline == "none" else object_footprints.footprint_for(str(o.id), lat, lng),
                plans=plans,
                floors=[ReferenceFloorOut(index=i, name=n) for i, n in sorted(floors_by_obj.get(o.id, {}).items())],
                measures=o.measures,
                remarks=o.remarks,
                measures_source=o.measures_source,
                updated_at=o.updated_at,
                last_visit=last.get(o.id),
            )
        )
    return ReferenceObjectsOut(objects=out, generated_at=datetime.now(UTC))


@router.get("/objects", response_model=ReferenceObjectsOut, response_model_by_alias=True)
async def list_reference_objects(reader: StationReader, db: AsyncSession = Depends(get_db)) -> ReferenceObjectsOut:
    """Every station object for «Karte & Objekte» — including the plan-less ones an organizer
    created (key boxes), which the Einsatz pickers leave out (api/objects · list_objects).
    ``lastVisit`` only where the station runs Objektbesuche (or for the admin session)."""
    with_visits = reader is None or (await ov_config(db)).enabled
    return await reference_objects(db, with_visits=with_visits)


# --- the building at a point --------------------------------------------------------------------


async def object_at_address(db: AsyncSession, address: str | None) -> ObjectSite | None:
    """The catalogue object whose street + number IS this address, or None.

    Exact only (``Hauptstrasse 10`` = ``Hauptstrasse 10, 4104 Oberwil``): a neighbour 20 m away is
    NOT the building, and a register hint must never be dressed up as that object's facts. Two
    objects at one door (the Einsatzobjekt and its key box) → the one with plans, then by name.
    """
    street = _street_of(address)
    if not street:
        return None
    matches = [
        o
        for o in (await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars()
        if _street_of(o.address) == street
    ]
    if not matches:
        return None
    with_plans = set(
        (
            await db.execute(
                select(ReferenceDataset.object_id).where(ReferenceDataset.object_id.in_([o.id for o in matches]))
            )
        ).scalars()
    )
    matches.sort(key=lambda o: o.id not in with_plans)
    return matches[0]


@router.get("/building", response_model=BuildingOut)
async def reference_building(
    reader: StationReader,
    lat: float = Query(ge=-90, le=90),
    lng: float = Query(ge=-180, le=180),
    address: str | None = Query(default=None, max_length=300, description="The searched address, if any"),
    lang: str = "de",
    db: AsyncSession = Depends(get_db),
) -> BuildingOut:
    """The Gebäude card's facts for a point — no incident, nothing stored.

    ``object`` is set only when the register's address (or the searched one) is EXACTLY a
    catalogue object's — the viewer then opens that object instead of a bare building.
    """
    lang = lang if lang in _LANGS else "de"
    out = BuildingOut(registers="on")
    await fill_registers(db, out, lat, lng, address, lang)
    o = await object_at_address(db, out.address or address)
    if o is not None:
        out.object = BuildingObjectOut(
            id=o.id,
            name=o.name,
            address_match=True,
            distance_m=None,
            measures=o.measures,
            remarks=o.remarks,
            measures_source=o.measures_source,
            updated_at=o.updated_at,
        )
        if (reader is None or (await ov_config(db)).enabled) and (v := await last_visit(db, o.id)) is not None:
            out.visit = BuildingVisitOut(id=v.id, visited_at=v.visited_at, findings=v.findings or 0)
    return out

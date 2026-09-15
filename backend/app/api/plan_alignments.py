"""Admin review of automatically prepared, immutable PDF page alignments."""

import math
from datetime import UTC, datetime

import anyio
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentAdmin
from ..database import get_db
from ..models import ObjectSite, PlanAlignment, PlanAlignmentEvent, PlanPageFloor, PlanRevision, ReferenceDataset
from ..plan_alignment_compute import alignment_capability, render_preview
from ..plan_floors import PlanFloor, default_fit_page, fit_publishable, load_floors, replace_floors
from ..plan_revision_info import revision_page_count
from .plan_scales import GeorefPair

router = APIRouter(prefix="/admin/plan-alignments", tags=["admin-plan-alignments"])


class AlignmentMutation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    edit_version: int = Field(ge=1)


class AlignmentApproval(AlignmentMutation):
    pairs: list[GeorefPair] | None = Field(default=None, min_length=2, max_length=16)


class FloorAssignment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    page: int = Field(ge=0)
    index: int = Field(ge=-20, le=100)
    name: str | None = Field(default=None, max_length=80)
    #: the drawing's rectangle on the page, normalized [x0, y0, x1, y1]; absent = whole page
    clip: list[float] | None = Field(default=None, min_length=4, max_length=4)
    #: this drawing meets floor ``to`` at one point pair (normalized page coordinates)
    join: "FloorJoin | None" = None


class FloorJoin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    to: int = Field(ge=-20, le=100)
    at: list[float] = Field(min_length=2, max_length=2)
    there: list[float] = Field(min_length=2, max_length=2)


class FloorPack(AlignmentMutation):
    """The whole floor list of one revision, replaced as one document.

    ``fit_page`` names the page the shared map fit is measured on; absent = floor 0 (see
    plan_floors.default_fit_page). Changing it re-queues the fit at that page.
    """

    floors: list[FloorAssignment] = Field(max_length=100)
    fit_page: int | None = Field(default=None, ge=0)


def _snapshot(row: PlanAlignment) -> dict:
    return {
        "status": row.status,
        "pairs": row.pairs,
        "aspect": row.aspect,
        "scale_m_per_u": row.scale_m_per_u,
        "score": row.score,
        "coverage": row.coverage,
        "reason": row.reason,
        "approved_at": row.approved_at.isoformat() if row.approved_at else None,
        "reference_rings": row.reference_rings,
        "reference_source": row.reference_source,
        "reference_at": row.reference_at.isoformat() if row.reference_at else None,
    }


async def _item(db: AsyncSession, row: PlanAlignment) -> dict:
    ds = await db.get(ReferenceDataset, row.dataset_id)
    obj = await db.get(ObjectSite, ds.object_id) if ds and ds.object_id else None
    revision = await db.get(PlanRevision, (row.dataset_id, row.plan_version))
    page_count = await revision_page_count(revision.storage_key) if revision else None
    return _serialize_item(row, ds, obj, page_count, await load_floors(db, row.dataset_id, row.plan_version))


def _serialize_item(
    row: PlanAlignment,
    ds: ReferenceDataset | None,
    obj: ObjectSite | None,
    page_count: int | None,
    floors: list[PlanFloor],
) -> dict:
    current = bool(ds and ds.current_version == row.plan_version)
    return {
        "page_count": page_count,
        "floors": [f.as_dict() for f in floors],
        "can_approve": current
        and fit_publishable(page_count, row.page, floors)
        and row.status in {"ready", "needs_review", "no_match", "failed", "unavailable", "unsupported", "rejected"},
        "id": row.id,
        "dataset_id": row.dataset_id,
        "plan_version": row.plan_version,
        "page": row.page,
        "object_name": obj.name if obj else row.dataset_id,
        # the Einsatzobjekt's own coordinate: where the review map starts when the worker left no
        # reference rings (an unsupported module, a sheet nobody has fitted yet)
        "object_lng": float(obj.lng) if obj and obj.lng is not None else None,
        "object_lat": float(obj.lat) if obj and obj.lat is not None else None,
        "module": ds.module if ds else None,
        "title": ds.title if ds else None,
        "edit_version": row.edit_version,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "is_current": bool(ds and ds.current_version == row.plan_version),
        **_snapshot(row),
    }


async def _get(db: AsyncSession, item_id: int) -> PlanAlignment:
    row = await db.get(PlanAlignment, item_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Ausrichtung nicht gefunden")
    return row


@router.get("")
async def list_alignments(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)):
    """The whole review queue as metadata only – never the reference geometry.

    ⚠️ 453 sheets carrying their `reference_rings` were 21.5 MB and 1.7 s on the wire, and 23 MB
    of the serialized JSON was the rings alone. The wall draws its outlines per TILE as it
    scrolls (`GET /{id}/outline`), so this list must stay the small thing every caller polls.

    Nor does it open a single PDF: `page_count` is the detail's answer (one selected sheet, one
    `revision_page_count`), and an unknown page count deliberately keeps `can_approve` false for
    an ordinary document – the wall re-reads the detail before it approves anything.
    """
    # Review queues span hundreds of PDFs. Fetch their metadata together, including retained
    # revisions, rather than making three database round trips for every alignment row.
    rows = (
        await db.execute(
            select(PlanAlignment, ReferenceDataset, ObjectSite)
            .outerjoin(ReferenceDataset, ReferenceDataset.id == PlanAlignment.dataset_id)
            .outerjoin(ObjectSite, ObjectSite.id == ReferenceDataset.object_id)
            .order_by(PlanAlignment.updated_at.desc(), PlanAlignment.id.desc())
        )
    ).all()
    floors_by_revision: dict[tuple[str, int], list[PlanFloor]] = {}
    for f in (await db.execute(select(PlanPageFloor).order_by(PlanPageFloor.floor_index))).scalars():
        floors_by_revision.setdefault((f.dataset_id, f.plan_version), []).append(
            PlanFloor(f.page, f.floor_index, f.floor_name, f.clip, f.join)
        )
    items = []
    for row, ds, obj in rows:
        item = _serialize_item(row, ds, obj, None, floors_by_revision.get((row.dataset_id, row.plan_version), []))
        # the one field the list does not carry; everything else is the same contract as the detail
        del item["reference_rings"]
        items.append(item)
    return {
        "items": items,
        "capability": await anyio.to_thread.run_sync(alignment_capability),
    }


@router.get("/{item_id}")
async def get_alignment(item_id: int, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)):
    return await _item(db, await _get(db, item_id))


@router.get("/{item_id}/outline")
async def alignment_outline(item_id: int, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)):
    """What ONE tile draws over its thumbnail: the reference geometry the fit was measured
    against, plus the fit itself and its provenance. One row read, no PDF – this is what the
    list stopped carrying for all 453 sheets at once.

    Deliberately uncached: the rings change whenever the worker re-runs, and a stale outline
    over a fresh thumbnail is exactly the lie the review wall exists to catch.
    """
    row = await _get(db, item_id)
    return {
        "reference_rings": row.reference_rings,
        "reference_source": row.reference_source,
        "reference_at": row.reference_at,
        "pairs": row.pairs,
    }


@router.get("/{item_id}/preview")
async def alignment_preview(
    item_id: int,
    _admin: CurrentAdmin,
    db: AsyncSession = Depends(get_db),
    thumbnail: bool = False,
    page: int | None = Query(default=None, ge=0),
):
    """`thumbnail=true` answers the review grid's small JPEG; without it, the exact PNG raster.
    `page` picks another page of the same revision – the floor-pack editor shows every page."""
    row = await _get(db, item_id)
    revision = await db.get(PlanRevision, (row.dataset_id, row.plan_version))
    if revision is None:
        raise HTTPException(status_code=404, detail="Planversion nicht gefunden")
    shown = row.page if page is None else page
    try:
        data, media_type = await anyio.to_thread.run_sync(
            lambda: render_preview(revision.storage_key, shown, thumbnail=thumbnail)
        )
    except (OSError, ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail="Planvorschau konnte nicht erstellt werden") from exc
    return Response(data, media_type=media_type, headers={"Cache-Control": "private, max-age=3600"})


async def _change(db: AsyncSession, row: PlanAlignment, edit_version: int, action: str, values: dict) -> dict:
    """CAS guards even databases without SELECT FOR UPDATE; history and mutation commit together."""
    previous = _snapshot(row)
    result = await db.execute(
        update(PlanAlignment)
        .where(PlanAlignment.id == row.id, PlanAlignment.edit_version == edit_version)
        .values(**values, edit_version=PlanAlignment.edit_version + 1, updated_at=datetime.now(UTC))
        .returning(PlanAlignment.id)
        .execution_options(synchronize_session=False)
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=409, detail="Ausrichtung wurde zwischenzeitlich geändert – neu laden")
    db.add(
        PlanAlignmentEvent(
            alignment_id=row.id,
            action=action,
            edit_version=edit_version + 1,
            snapshot={
                "before": previous,
                "after": {
                    **previous,
                    **{k: v.isoformat() if isinstance(v, datetime) else v for k, v in values.items()},
                },
            },
        )
    )
    await db.flush()
    await db.refresh(row)
    return await _item(db, row)


@router.post("/{item_id}/approve")
async def approve_alignment(
    item_id: int, body: AlignmentApproval, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)
):
    row = await _get(db, item_id)
    manual = body.pairs is not None and all(pair.kind in {"gesetzt", "korrigiert"} for pair in body.pairs)
    allowed = {"ready", "needs_review"}
    if manual:
        # by hand, anything can be (re)aligned – including an approval whose pairs get corrected
        allowed |= {"no_match", "failed", "unavailable", "unsupported", "rejected", "approved"}
    if row.status not in allowed:
        raise HTTPException(status_code=409, detail="Kein Vorschlag zur Freigabe vorhanden")
    ds = await db.get(ReferenceDataset, row.dataset_id)
    if ds is not None and ds.object_id is not None:
        await db.execute(select(ObjectSite).where(ObjectSite.id == ds.object_id).with_for_update())
        await db.refresh(ds)
    if ds is None or ds.current_version != row.plan_version:
        raise HTTPException(status_code=409, detail="Dieser Plan wurde ersetzt – aktuelle Version prüfen")
    revision = await db.get(PlanRevision, (row.dataset_id, row.plan_version))
    page_count = await revision_page_count(revision.storage_key, fresh=True) if revision else None
    if not fit_publishable(page_count, row.page, await load_floors(db, row.dataset_id, row.plan_version)):
        raise HTTPException(
            status_code=422, detail="Nur einseitige PDF-Pläne oder Geschoss-Seiten können zentral ausgerichtet werden"
        )
    pairs = [p.model_dump() for p in body.pairs] if body.pairs is not None else row.pairs
    try:
        checked = [GeorefPair.model_validate(p) for p in pairs]
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Ungültige Ausrichtung") from exc
    has_auto = any(pair.kind == "auto" for pair in checked)
    if (
        len(checked) < 2
        or (has_auto and len(checked) != 2)
        or not row.aspect
        or not math.isfinite(row.aspect)
        or row.aspect <= 0
    ):
        raise HTTPException(status_code=422, detail="Ungültige Ausrichtung")
    for i, a in enumerate(checked):
        for b in checked[i + 1 :]:
            if a.plan == b.plan or a.lngLat == b.lngLat:
                raise HTTPException(status_code=422, detail="Ausrichtung braucht verschiedene Punkte")
    # Preserve the actual origin. Moving an automatic fit must keep its auto markers;
    # newly placed manual correspondences retain their measured-pair vocabulary.
    pairs = [p.model_dump() for p in checked]
    return await _change(
        db, row, body.edit_version, "approve", {"status": "approved", "pairs": pairs, "approved_at": datetime.now(UTC)}
    )


@router.post("/{item_id}/reject")
async def reject_alignment(
    item_id: int, body: AlignmentMutation, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)
):
    """The admin looked and said no: the proposal leaves the open queue without publishing
    anything. The sheet can still be aligned by hand (manual approve) or the decision undone."""
    row = await _get(db, item_id)
    if row.status not in {"ready", "needs_review", "no_match", "failed", "unavailable"}:
        raise HTTPException(status_code=409, detail="Kein offener Vorschlag zum Ablehnen vorhanden")
    return await _change(db, row, body.edit_version, "reject", {"status": "rejected", "approved_at": None})


@router.post("/{item_id}/undo")
async def undo_decision(
    item_id: int, body: AlignmentMutation, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)
):
    """Takes back an approval or a rejection; either way the sheet is back to «Bitte prüfen»."""
    row = await _get(db, item_id)
    if row.status not in {"approved", "rejected"}:
        raise HTTPException(status_code=409, detail="Keine Entscheidung zum Zurücknehmen vorhanden")
    return await _change(db, row, body.edit_version, "withdraw", {"status": "needs_review", "approved_at": None})


@router.post("/{item_id}/retry")
async def retry_alignment(
    item_id: int, body: AlignmentMutation, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)
):
    row = await _get(db, item_id)
    if row.status in {"approved", "processing", "pending"}:
        raise HTTPException(status_code=409, detail="Ausrichtung kann jetzt nicht neu berechnet werden")
    return await _change(
        db, row, body.edit_version, "retry", {"status": "pending", "reason": None, "claimed_at": None, "attempts": 0}
    )


@router.put("/{item_id}/floors")
async def assign_floors(item_id: int, body: FloorPack, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)):
    """Declare which page of this revision is which Geschoss (one floor per page, 14.09.2026).

    An empty list turns the pack back into an ordinary document. The alignment row moves to the
    page the shared fit is measured on and – unless already approved – is re-queued there, so
    the worker renders the right page. An approved fit is never moved silently: withdraw it
    first (409), then change the fit page.
    """
    row = await _get(db, item_id)
    ds = await db.get(ReferenceDataset, row.dataset_id)
    if ds is None or ds.current_version != row.plan_version:
        raise HTTPException(status_code=409, detail="Dieser Plan wurde ersetzt – aktuelle Version prüfen")
    revision = await db.get(PlanRevision, (row.dataset_id, row.plan_version))
    page_count = await revision_page_count(revision.storage_key, fresh=True) if revision else None
    if page_count is None:
        raise HTTPException(status_code=422, detail="PDF nicht lesbar")
    floors = [
        PlanFloor(f.page, f.index, (f.name or "").strip() or None, f.clip, f.join.model_dump() if f.join else None)
        for f in body.floors
    ]
    pages = [f.page for f in floors]
    if any(p >= page_count for p in pages):
        raise HTTPException(status_code=422, detail="Seite ausserhalb des PDFs")
    if len({f.index for f in floors}) != len(floors):
        raise HTTPException(status_code=422, detail="Jeder Geschoss-Index nur einmal")
    unit = lambda v: 0.0 <= v <= 1.0  # noqa: E731
    for f in floors:
        if f.clip is not None and not (
            all(unit(v) for v in f.clip) and f.clip[0] < f.clip[2] and f.clip[1] < f.clip[3]
        ):
            raise HTTPException(status_code=422, detail="Bereich ausserhalb der Seite")
        if f.join is not None:
            other = next((o for o in floors if o.index == f.join["to"]), None)
            if other is None or other.index == f.index:
                raise HTTPException(status_code=422, detail="Verbindung zeigt auf kein anderes Geschoss")
            if not all(unit(v) for v in [*f.join["at"], *f.join["there"]]):
                raise HTTPException(status_code=422, detail="Verbindungspunkt ausserhalb der Seite")
    # several floors on one page (regions of an A0) is the point; the same page twice WITHOUT
    # regions would be the same drawing twice
    plain = [f.page for f in floors if f.clip is None]
    if len(set(plain)) != len(plain):
        raise HTTPException(status_code=422, detail="Eine ganze Seite kann nur ein Geschoss sein")
    fit_page = body.fit_page if body.fit_page is not None else default_fit_page(floors)
    if fit_page is None:
        fit_page = 0
    elif fit_page not in pages:
        raise HTTPException(status_code=422, detail="Die Ausrichtungsseite muss ein Geschoss sein")
    if row.page != fit_page and row.status == "approved":
        raise HTTPException(status_code=409, detail="Freigabe zuerst zurücknehmen, dann die Ausrichtungsseite wechseln")
    await replace_floors(db, row.dataset_id, row.plan_version, floors)
    values: dict = {}
    if row.page != fit_page:
        # a fit measured on another page is meaningless here – start the worker over on this one
        values = {
            "page": fit_page,
            "status": "pending",
            "pairs": [],
            "aspect": None,
            "scale_m_per_u": None,
            "score": None,
            "coverage": None,
            "reason": None,
            "claimed_at": None,
            "attempts": 0,
        }
    return await _change(db, row, body.edit_version, "floors", values)

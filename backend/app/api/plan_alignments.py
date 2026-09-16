"""Admin review of automatically prepared, immutable PDF page alignments."""

import anyio
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentAdmin
from ..database import get_db
from ..models import ObjectSite, PlanAlignment, PlanPageFloor, PlanRevision, ReferenceDataset
from ..plan_alignment_compute import alignment_capability, render_preview
from ..plan_approval import ADMIN, ApprovalError, approve_fit, record_change, snapshot
from ..plan_floors import (
    FloorError,
    PlanFloor,
    default_fit_page,
    fit_publishable,
    load_floors,
    replace_floors,
    validate_floors,
)
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
        # Why a marked export produced what it produced (16.09.2026) — small enough for the LIST
        # too, and it has to be there: the object table's badge is what tells an operator that a
        # «Vorschlag bereit» with no Geschosse is an export to fix, not a plan to approve.
        "marker_notes": row.marker_notes,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "is_current": bool(ds and ds.current_version == row.plan_version),
        **snapshot(row),
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
    """One admin decision: the shared CAS-plus-history write (plan_approval.record_change)."""
    if not await record_change(db, row, edit_version, action, values, actor=ADMIN):
        raise HTTPException(status_code=409, detail="Ausrichtung wurde zwischenzeitlich geändert – neu laden")
    return await _item(db, row)


@router.post("/{item_id}/approve")
async def approve_alignment(
    item_id: int, body: AlignmentApproval, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)
):
    """«Freigeben»: publish this fit to incidents – the same gate the marker worker passes
    through when a plan states its own fit (app/plan_approval.py)."""
    row = await _get(db, item_id)
    try:
        await approve_fit(db, row, body.pairs, actor=ADMIN, edit_version=body.edit_version)
    except ApprovalError as refused:
        raise HTTPException(status_code=refused.status_code, detail=refused.detail) from refused
    return await _item(db, row)


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
    # Whatever the PDF's own §-markers proposed for a storey stays pinned to it across this
    # save: it is the baseline that tells the admin's correction from the export's say-so, and
    # the next re-export re-applies the first on top of the second (app/plan_markers.py).
    proposed = {f.index: f.marker for f in await load_floors(db, row.dataset_id, row.plan_version)}
    floors = [
        PlanFloor(
            f.page,
            f.index,
            (f.name or "").strip() or None,
            f.clip,
            f.join.model_dump() if f.join else None,
            proposed.get(f.index),
        )
        for f in body.floors
    ]
    pages = [f.page for f in floors]
    try:
        validate_floors(floors, page_count)  # the same rules the marker worker is held to
    except FloorError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
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

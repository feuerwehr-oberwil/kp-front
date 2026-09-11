"""Admin review of automatically prepared, immutable PDF page alignments."""

import math
from datetime import UTC, datetime

import anyio
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentAdmin
from ..database import get_db
from ..models import ObjectSite, PlanAlignment, PlanAlignmentEvent, PlanRevision, ReferenceDataset
from ..plan_alignment_compute import alignment_capability, render_preview
from ..plan_revision_info import revision_page_count
from .plan_scales import GeorefPair

router = APIRouter(prefix="/admin/plan-alignments", tags=["admin-plan-alignments"])


class AlignmentMutation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    edit_version: int = Field(ge=1)


class AlignmentApproval(AlignmentMutation):
    pairs: list[GeorefPair] | None = Field(default=None, min_length=2, max_length=16)


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
    return _serialize_item(row, ds, obj, page_count)


def _serialize_item(
    row: PlanAlignment, ds: ReferenceDataset | None, obj: ObjectSite | None, page_count: int | None
) -> dict:
    current = bool(ds and ds.current_version == row.plan_version)
    return {
        "page_count": page_count,
        "can_approve": current
        and page_count == 1
        and row.page == 0
        and row.status in {"ready", "needs_review", "no_match", "failed", "unavailable", "unsupported"},
        "id": row.id,
        "dataset_id": row.dataset_id,
        "plan_version": row.plan_version,
        "page": row.page,
        "object_name": obj.name if obj else row.dataset_id,
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
async def list_alignments(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db), summary: bool = False):
    # Review queues span hundreds of PDFs. Fetch their metadata together, including retained
    # revisions, rather than making three database round trips for every alignment row.
    rows = (
        await db.execute(
            select(PlanAlignment, ReferenceDataset, ObjectSite, PlanRevision)
            .outerjoin(ReferenceDataset, ReferenceDataset.id == PlanAlignment.dataset_id)
            .outerjoin(ObjectSite, ObjectSite.id == ReferenceDataset.object_id)
            .outerjoin(
                PlanRevision,
                (PlanRevision.dataset_id == PlanAlignment.dataset_id)
                & (PlanRevision.version == PlanAlignment.plan_version),
            )
            .order_by(PlanAlignment.updated_at.desc(), PlanAlignment.id.desc())
        )
    ).all()
    page_counts: dict[str, int | None] = {}
    items = []
    for row, ds, obj, revision in rows:
        page_count = None
        # A compact queue needs metadata immediately; fetch the selected item's detail before
        # offering approval. Unknown page count deliberately keeps can_approve false.
        if not summary and revision is not None:
            if revision.storage_key not in page_counts:
                page_counts[revision.storage_key] = await revision_page_count(revision.storage_key)
            page_count = page_counts[revision.storage_key]
        items.append(_serialize_item(row, ds, obj, page_count))
    return {
        "items": items,
        "capability": await anyio.to_thread.run_sync(alignment_capability),
    }


@router.get("/{item_id}")
async def get_alignment(item_id: int, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)):
    return await _item(db, await _get(db, item_id))


@router.get("/{item_id}/preview")
async def alignment_preview(item_id: int, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)):
    row = await _get(db, item_id)
    revision = await db.get(PlanRevision, (row.dataset_id, row.plan_version))
    if revision is None:
        raise HTTPException(status_code=404, detail="Planversion nicht gefunden")
    try:
        png = await anyio.to_thread.run_sync(render_preview, revision.storage_key, row.page)
    except (OSError, ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail="Planvorschau konnte nicht erstellt werden") from exc
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


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
        allowed |= {"no_match", "failed", "unavailable", "unsupported"}
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
    if page_count != 1 or row.page != 0:
        raise HTTPException(status_code=422, detail="Nur einseitige PDF-Pläne können zentral ausgerichtet werden")
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


@router.post("/{item_id}/undo")
async def undo_approval(
    item_id: int, body: AlignmentMutation, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)
):
    row = await _get(db, item_id)
    if row.status != "approved":
        raise HTTPException(status_code=409, detail="Keine Freigabe zum Zurücknehmen vorhanden")
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

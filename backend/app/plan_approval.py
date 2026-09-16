"""The ONE way a plan fit becomes published, whoever says so.

``api/reference.dataset_alignments`` hands an incident every alignment whose row says
``approved`` — so everything that may set that word goes through ``approve_fit`` here: the admin's
«Freigeben» (``POST /admin/plan-alignments/{id}/approve``) and the alignment worker, for a plan
whose own ``§GEO`` markers state the fit (``plan_markers``). The gate is the same for both: the
row must belong to the CURRENT revision, its page must be one a fit may be measured on
(``plan_floors.fit_publishable``), and its pairs must be two or more well-formed, distinct
landmarks with a usable aspect.

Why the worker approves at all (decided 16.09.2026): a ``§GEO`` fit is not a matcher's guess
that wants a second opinion — it is the plan author's own statement, written on the sheet by
the person who knows where the building corner sits. Making an admin agree with it once per
re-export, for 150 objects, buys nothing. So a marked sheet arrives «Freigegeben»; the admin
checks rather than approves, and «Freigabe zurücknehmen» puts it back in the queue.

Every decision on an alignment — approve, reject, withdraw, retry, floors — is also written the
same way (``record_change``): a CAS on ``edit_version`` plus one append-only
``PlanAlignmentEvent`` naming the ``actor`` that decided.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .api.plan_scales import GeorefPair
from .models import ObjectSite, PlanAlignment, PlanAlignmentEvent, PlanRevision, ReferenceDataset
from .plan_floors import fit_publishable, load_floors
from .plan_revision_info import revision_page_count

#: an admin acting in the review UI …
ADMIN = "admin"
#: … and the plan's own §-markers, which nobody clicked (plan_alignment_worker)
MARKERS = "markers"


class ApprovalError(Exception):
    """Why a fit may not be published: the HTTP status and the German sentence the API returns."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def snapshot(row: PlanAlignment) -> dict:
    """The reviewable state of one alignment — what a history entry stores before and after."""
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


async def record_change(
    db: AsyncSession, row: PlanAlignment, edit_version: int, action: str, values: dict, *, actor: str
) -> bool:
    """CAS guards even databases without SELECT FOR UPDATE; history and mutation commit together.

    False = somebody changed the row in between and NOTHING was written (the caller's 409).
    """
    previous = snapshot(row)
    result = await db.execute(
        update(PlanAlignment)
        .where(PlanAlignment.id == row.id, PlanAlignment.edit_version == edit_version)
        .values(**values, edit_version=PlanAlignment.edit_version + 1, updated_at=datetime.now(UTC))
        .returning(PlanAlignment.id)
        .execution_options(synchronize_session=False)
    )
    if result.scalar_one_or_none() is None:
        return False
    db.add(
        PlanAlignmentEvent(
            alignment_id=row.id,
            action=action,
            edit_version=edit_version + 1,
            snapshot={
                "actor": actor,
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
    return True


async def approve_fit(
    db: AsyncSession,
    row: PlanAlignment,
    pairs: list[GeorefPair] | None = None,
    *,
    actor: str,
    edit_version: int | None = None,
) -> None:
    """Publish one alignment to incidents, or raise ``ApprovalError``.

    ``pairs`` None approves the proposal exactly as it stands (the worker's marker fit, or an
    automatic one the admin did not touch); a list replaces it — approving by hand is also how a
    sheet that never got a proposal, or one already approved, is (re)aligned. ``edit_version``
    None means «the row as read», for a caller holding no client token of its own.
    """
    manual = pairs is not None and all(pair.kind in {"gesetzt", "korrigiert"} for pair in pairs)
    allowed = {"ready", "needs_review"}
    if manual:
        # by hand, anything can be (re)aligned – including an approval whose pairs get corrected
        allowed |= {"no_match", "failed", "unavailable", "unsupported", "rejected", "approved"}
    if row.status not in allowed:
        raise ApprovalError(409, "Kein Vorschlag zur Freigabe vorhanden")
    ds = await db.get(ReferenceDataset, row.dataset_id)
    if ds is not None and ds.object_id is not None:
        await db.execute(select(ObjectSite).where(ObjectSite.id == ds.object_id).with_for_update())
        await db.refresh(ds)
    if ds is None or ds.current_version != row.plan_version:
        raise ApprovalError(409, "Dieser Plan wurde ersetzt – aktuelle Version prüfen")
    revision = await db.get(PlanRevision, (row.dataset_id, row.plan_version))
    page_count = await revision_page_count(revision.storage_key, fresh=True) if revision else None
    if not fit_publishable(page_count, row.page, await load_floors(db, row.dataset_id, row.plan_version)):
        raise ApprovalError(422, "Nur einseitige PDF-Pläne oder Geschoss-Seiten können zentral ausgerichtet werden")
    proposed = [p.model_dump() for p in pairs] if pairs is not None else row.pairs
    try:
        checked = [GeorefPair.model_validate(p) for p in proposed]
    except ValueError as exc:
        raise ApprovalError(422, "Ungültige Ausrichtung") from exc
    has_auto = any(pair.kind == "auto" for pair in checked)
    if (
        len(checked) < 2
        or (has_auto and len(checked) != 2)
        or not row.aspect
        or not math.isfinite(row.aspect)
        or row.aspect <= 0
    ):
        raise ApprovalError(422, "Ungültige Ausrichtung")
    for i, a in enumerate(checked):
        for b in checked[i + 1 :]:
            if a.plan == b.plan or a.lngLat == b.lngLat:
                raise ApprovalError(422, "Ausrichtung braucht verschiedene Punkte")
    # Preserve the actual origin. Moving an automatic fit must keep its auto markers;
    # newly placed manual correspondences retain their measured-pair vocabulary.
    values = {"status": "approved", "pairs": [p.model_dump() for p in checked], "approved_at": datetime.now(UTC)}
    written = await record_change(
        db,
        row,
        row.edit_version if edit_version is None else edit_version,
        "approve",
        values,
        actor=actor,
    )
    if not written:
        raise ApprovalError(409, "Ausrichtung wurde zwischenzeitlich geändert – neu laden")

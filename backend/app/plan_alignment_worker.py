"""Lease one durable alignment job at a time; a computed fit never publishes itself.

The one exception, and it is not the worker's own judgement: a plan that states its fit in its
own ``§GEO`` markers is approved on import (``approve_marker_fit`` → ``plan_approval``), because
that fit is the plan author's statement and not a matcher's guess.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime, timedelta
from functools import partial

import anyio
from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .database import async_session_maker
from .models import DeploymentConfig, ObjectSite, PlanAlignment, PlanRevision, ReferenceDataset
from .plan_alignment_compute import (
    AlignmentResult,
    calibrated_scale,
    compute_alignment,
    module_alignment,
    module_is_floor_pack,
    render_page,
)
from .plan_approval import MARKERS, ApprovalError, approve_fit
from .plan_floors import FloorError, PlanFloor, load_floors, replace_floors, validate_floors
from .plan_markers import MarkerPlan, admin_overrides, apply_overrides, marker_snapshot, read_plan
from .plan_markers import text as marker_text
from .reference_buildings import ensure_snapshot
from .schemas import load_stored_config

logger = logging.getLogger(__name__)
LEASE_SECONDS = 600
MAX_ATTEMPTS = 3
POLL_SECONDS = 10
_render_limiter = anyio.CapacityLimiter(1)


@dataclass(frozen=True)
class Claim:
    id: int
    dataset_id: str
    version: int
    page: int
    attempt: int
    edit_version: int


async def claim_job(db: AsyncSession, now: datetime | None = None) -> Claim | None:
    """Compare-and-swap claim with a bounded crash-recovery lease, committed by the caller."""
    now = now or datetime.now(UTC)
    eligible = or_(
        PlanAlignment.status == "pending",
        and_(
            PlanAlignment.status == "processing",
            or_(
                PlanAlignment.claimed_at.is_(None),
                PlanAlignment.claimed_at < now - timedelta(seconds=LEASE_SECONDS),
            ),
        ),
    )
    await db.execute(
        update(PlanAlignment)
        .where(eligible, PlanAlignment.attempts >= MAX_ATTEMPTS)
        .values(
            status="failed",
            reason="worker_retry_limit",
            claimed_at=None,
            edit_version=PlanAlignment.edit_version + 1,
        )
    )
    candidate = (
        select(PlanAlignment.id)
        .where(eligible, PlanAlignment.attempts < MAX_ATTEMPTS)
        .order_by(PlanAlignment.created_at, PlanAlignment.id)
        .limit(1)
        .with_for_update(skip_locked=True)
        .scalar_subquery()
    )
    row = (
        await db.execute(
            update(PlanAlignment)
            .where(PlanAlignment.id == candidate, eligible, PlanAlignment.attempts < MAX_ATTEMPTS)
            .values(
                status="processing",
                reason=None,
                claimed_at=now,
                attempts=PlanAlignment.attempts + 1,
                edit_version=PlanAlignment.edit_version + 1,
            )
            .returning(
                PlanAlignment.id,
                PlanAlignment.dataset_id,
                PlanAlignment.plan_version,
                PlanAlignment.page,
                PlanAlignment.attempts,
                PlanAlignment.edit_version,
            )
        )
    ).one_or_none()
    return Claim(row.id, row.dataset_id, row.plan_version, row.page, row.attempts, row.edit_version) if row else None


async def finish_job(
    db: AsyncSession,
    claim: Claim,
    result: AlignmentResult,
    *,
    digest: str | None = None,
) -> bool:
    """A lost lease cannot overwrite a successor, an edited proposal or an approval."""
    finished = (
        await db.execute(
            update(PlanAlignment)
            .where(
                PlanAlignment.id == claim.id,
                PlanAlignment.status == "processing",
                PlanAlignment.attempts == claim.attempt,
                PlanAlignment.edit_version == claim.edit_version,
            )
            .values(**asdict(result), claimed_at=None, edit_version=PlanAlignment.edit_version + 1)
            .returning(PlanAlignment.id)
        )
    ).scalar_one_or_none()
    if finished is None:
        return False
    if digest is not None:
        await db.execute(
            update(PlanRevision)
            .where(
                PlanRevision.dataset_id == claim.dataset_id,
                PlanRevision.version == claim.version,
                PlanRevision.content_digest.is_(None),
            )
            .values(content_digest=digest)
        )
    return True


async def apply_marker_plan(db: AsyncSession, claim: Claim, plan: MarkerPlan) -> bool:
    """Write the floor pack a PDF's own ``§`` markers propose onto this revision.

    Returns True when the pack's ONE fit belongs on a page other than the one this job holds:
    the job is then re-queued there and the next tick renders the right drawing, exactly as
    ``PUT /floors`` does when an admin moves the fit page by hand.

    **What the markers may overwrite.** A pack the markers never made is the admin's own work
    and is left alone entirely. Otherwise the export is followed wherever it moved, and every
    field a human had corrected away from the previous export's proposal is laid back on top
    (`plan_markers.admin_overrides`), keyed by storey index AND drawing — so a re-export costs the
    station nothing it had already fixed, and states nothing it had already been told.
    """
    if not plan.floors:
        return False
    current = await load_floors(db, claim.dataset_id, claim.version)
    # nothing carried onto this revision (a re-export with a different page count)? then the
    # previous revision's pack is what the admin's corrections live in
    base = current or (await load_floors(db, claim.dataset_id, claim.version - 1) if claim.version > 1 else [])
    if base and not any(f.marker for f in base):
        return False
    floors = apply_overrides(plan.floors, admin_overrides(base))
    try:
        validate_floors(floors, plan.page_count)
    except FloorError:
        logger.warning(
            "Plan markers %s v%s: kept edits make no valid pack — using the markers alone",
            claim.dataset_id,
            claim.version,
        )
        floors = plan.floors
    proposal = {f.key: marker_snapshot(f, claim.version) for f in plan.floors}
    await replace_floors(db, claim.dataset_id, claim.version, [replace(f, marker=proposal[f.key]) for f in floors])
    if plan.fit_page == claim.page:
        return False
    taken = (
        await db.execute(
            select(PlanAlignment.id).where(
                PlanAlignment.dataset_id == claim.dataset_id,
                PlanAlignment.plan_version == claim.version,
                PlanAlignment.page == plan.fit_page,
                PlanAlignment.id != claim.id,
            )
        )
    ).first()
    if taken is not None:  # another job already owns that page – leave both where they are
        return False
    moved = (
        await db.execute(
            update(PlanAlignment)
            .where(
                PlanAlignment.id == claim.id,
                PlanAlignment.status == "processing",
                PlanAlignment.attempts == claim.attempt,
                PlanAlignment.edit_version == claim.edit_version,
            )
            .values(
                page=plan.fit_page,
                status="pending",
                reason=None,
                pairs=[],
                aspect=None,
                scale_m_per_u=None,
                score=None,
                coverage=None,
                claimed_at=None,
                attempts=0,
                edit_version=PlanAlignment.edit_version + 1,
            )
            .returning(PlanAlignment.id)
        )
    ).scalar_one_or_none()
    return moved is not None


async def write_marker_notes(db: AsyncSession, claim: Claim, plan: MarkerPlan | None, floors: list[PlanFloor]) -> None:
    """What this run READ, onto the row: the warnings as codes, plus how much survived them.

    Every marker run overwrites it whole — the note describes the export as it is NOW, and a
    §-marker the author has since fixed must not keep accusing them. A sheet with no markers at
    all clears it to NULL.

    Deliberately NOT through ``plan_approval.record_change``: this is a report about the PDF, not
    a decision about the fit, so it writes no history row and does not touch ``edit_version`` —
    bumping the CAS token here would make ``finish_job`` lose the very result it is reporting on.
    """
    notes = (
        {
            "warnings": [dict(w) for w in plan.warnings],
            "storeys_found": plan.storeys,
            # STOREYS, not drawings: a 1. OG drawn as two wings is one Geschoss on the row
            "storeys_written": len({f.index for f in floors if (f.marker or {}).get("version") == claim.version}),
            "geo_pairs": len(plan.pairs),
        }
        if plan
        else None
    )
    await db.execute(update(PlanAlignment).where(PlanAlignment.id == claim.id).values(marker_notes=notes))
    if plan and plan.warnings:
        logger.info(
            "Plan markers %s v%s: %s",
            claim.dataset_id,
            claim.version,
            " | ".join(marker_text(w) for w in plan.warnings),
        )


def marker_result(plan: MarkerPlan, rendered, scale: float | None) -> AlignmentResult:
    """A fit the plan author stated outright: no matcher, no OSM, no coverage to judge.

    Its landmarks are measured coordinates somebody wrote on the drawing, not geometry a matcher
    guessed — so it is not a proposal anybody needs to agree with: ``approve_marker_fit`` puts it
    straight through the shared approval (16.09.2026). ``ready``/``markers`` is what it looks like
    for the moment between the two writes, and where it stays if the approval is refused.
    """
    return AlignmentResult(
        "ready",
        "markers",
        pairs=plan.pairs,
        aspect=rendered.aspect,
        scale_m_per_u=rendered.printed_scale or scale,
        reference_source="markers",
        reference_at=datetime.now(UTC),
    )


async def approve_marker_fit(db: AsyncSession, alignment_id: int) -> bool:
    """Freigeben, with the markers as the actor: the sheet says where it is, so nobody has to.

    The same gate and the same audit row as an admin's «Freigeben» (``plan_approval``), only
    without a click – the plan author already stated the fit on the drawing. A refusal (the
    revision was replaced while this job ran, the fit page is not one a fit may be measured on)
    is not an error: the row stays exactly where ``finish_job`` left it, «Vorschlag bereit», and
    a human decides.
    """
    row = await db.get(PlanAlignment, alignment_id)
    if row is None:
        return False
    try:
        await approve_fit(db, row, actor=MARKERS)
    except ApprovalError as refused:
        logger.info("Marker fit %s stays a proposal: %s", alignment_id, refused.detail)
        return False
    return True


async def run_once(factory: async_sessionmaker[AsyncSession] = async_session_maker) -> bool:
    """One timer tick, one PDF page; no session/row lock is held during rendering or HTTP."""
    async with factory() as db:
        claim = await claim_job(db)
        await db.commit()
        if claim is None:
            return False
        revision = await db.get(PlanRevision, (claim.dataset_id, claim.version))
        dataset = await db.get(ReferenceDataset, claim.dataset_id)
        obj = await db.get(ObjectSite, dataset.object_id) if dataset and dataset.object_id else None
        station = await db.get(DeploymentConfig, 1)
        # Copy scalar inputs before leaving the session (expire_on_commit is not assumed).
        key = revision.storage_key if revision else None
        expected_digest = revision.content_digest if revision else None
        module = dataset.module if dataset and dataset.module else ""
        object_id = str(obj.id) if obj else ""
        lng = float(obj.lng) if obj and obj.lng is not None else None
        lat = float(obj.lat) if obj and obj.lat is not None else None
        calibration = station.plan_scales_json if station else None
        # the catalogue's say on this module (auto / manual / none) – resolved here, in the
        # session, so compute never touches the database
        modules = load_stored_config((station.config_json if station else None) or {}).modules
        alignment = module_alignment(modules, module)
        # the station-wide building snapshot – fetched once, clipped per sheet (reference_buildings)
        reference = await ensure_snapshot(db)
        # A sheet that could carry a floor pack or a fit is worth reading for §-markers; one the
        # catalogue keeps off the Karte entirely (alignment: none, no stack) is not.
        marked = module_is_floor_pack(modules, module) or alignment != "none"

    plan: MarkerPlan | None = None
    if key is not None and marked:
        try:
            plan = await anyio.to_thread.run_sync(partial(read_plan, key), limiter=_render_limiter)
        except Exception:
            logger.exception("Plan markers unreadable for job %s", claim.id)
    async with factory() as db:
        requeued = await apply_marker_plan(db, claim, plan) if plan else False
        floors = await load_floors(db, claim.dataset_id, claim.version)
        # …and WHY it is what it is: a pack the markers could not make must not leave the admin
        # with an empty Geschoss list and no sentence about it (16.09.2026).
        await write_marker_notes(db, claim, plan, floors)
        await db.commit()
    floor_page = any(f.page == claim.page for f in floors)
    # this page is a Geschoss THESE markers wrote – so the fit below is the marked plan's own,
    # not one laid over a pack an admin built by hand (which apply_marker_plan refuses to touch)
    marked_pack = any(f.page == claim.page and (f.marker or {}).get("version") == claim.version for f in floors)
    if requeued:
        # the pack's one fit sits on another page; the job now waits there
        return True

    digest = None
    rendered = None
    scale = None
    try:
        if key is None:
            result = AlignmentResult("failed", "revision_missing")
        else:
            rendered = await anyio.to_thread.run_sync(
                partial(render_page, key, claim.page, expected_digest),
                limiter=_render_limiter,
            )
            digest = rendered.digest
            scale = calibrated_scale(calibration, object_id, module, claim.page, rendered.aspect)
            result = (
                marker_result(plan, rendered, scale)
                if plan and plan.pairs and plan.fit_page == claim.page
                else await compute_alignment(rendered, module, lng, lat, scale, alignment, reference, floor_page)
            )
    except (ImportError, OSError):
        logger.exception("Plan alignment preparation unavailable for job %s", claim.id)
        result = AlignmentResult(
            "unavailable",
            "pdf_unavailable",
            aspect=rendered.aspect if rendered else None,
            scale_m_per_u=(rendered.printed_scale or scale) if rendered else None,
        )
    except Exception:  # persist failure instead of leaving an apparently live job
        logger.exception("Plan alignment preparation failed for job %s", claim.id)
        result = AlignmentResult(
            "failed",
            "preparation_failed",
            aspect=rendered.aspect if rendered else None,
            scale_m_per_u=(rendered.printed_scale or scale) if rendered else None,
        )
    async with factory() as db:
        written = await finish_job(db, claim, result, digest=digest)
        if written and result.reason == "markers" and marked_pack:
            await approve_marker_fit(db, claim.id)
        await db.commit()
    return True

"""Lease one durable alignment job at a time; a computed fit never publishes itself.

The one exception, and it is not the worker's own judgement: a plan that states its fit in its
own ``§GEO`` markers is approved on import (``approve_marker_fit`` → ``plan_approval``), because
that fit is the plan author's statement and not a matcher's guess.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime, timedelta
from functools import partial

import anyio
from pydantic import ValidationError
from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from . import plans
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
from .plans import limit_lock_wait, lock_object_plans, lock_wait_exceeded, plan_target
from .reference_buildings import ensure_snapshot
from .schemas import load_stored_config

logger = logging.getLogger(__name__)
LEASE_SECONDS = 600
MAX_ATTEMPTS = 3
#: how long a job given back for a held object stays out of the queue (`give_back`)
BUSY_RETRY_SECONDS = 60
#: a job given back for this long logs one WARNING: a holder that never lets go is visible
BUSY_WARN_MINUTES = 30

#: Give-backs that could not be written because the row itself was held (a re-key): claim id →
#: claim. Settled before the next claims (`_settle_owed`), so a lock timeout never leaves an
#: attempt charged; only a worker restart in that window does, and that is a lost run.
_owed: dict[int, Claim] = {}
#: …tried again at most once per OWED_RETRY_SECONDS each (≈ one alignment tick), not before every
#: claim of a tick: each try may wait WORKER_LOCK_WAIT_MS, and a tick claims up to 20 jobs
OWED_RETRY_SECONDS = 10
_owed_due: dict[int, datetime] = {}
#: claim id → when it was first given back, and the ones already warned about
_busy_since: dict[int, datetime] = {}
_busy_warned: set[int] = set()
_render_limiter = anyio.CapacityLimiter(1)


@dataclass(frozen=True)
class Claim:
    id: int
    dataset_id: str
    version: int
    page: int
    attempt: int
    edit_version: int


async def claim_job(db: AsyncSession, now: datetime | None = None, *, owed: Iterable[int] = ()) -> Claim | None:
    """Compare-and-swap claim with a bounded crash-recovery lease, committed by the caller.

    ``owed`` – jobs whose give-back is still to be written (`_owed`): neither claimed nor failed by
    the retry sweep until it is, or their lease would charge the attempt the give-back returns."""
    now = now or datetime.now(UTC)
    eligible = and_(
        PlanAlignment.id.not_in(list(owed)),
        or_(
            and_(
                PlanAlignment.status == "pending",
                # a job given back for a held object carries the moment it was given back
                or_(
                    PlanAlignment.claimed_at.is_(None),
                    PlanAlignment.claimed_at < now - timedelta(seconds=BUSY_RETRY_SECONDS),
                ),
            ),
            and_(
                PlanAlignment.status == "processing",
                or_(
                    PlanAlignment.claimed_at.is_(None),
                    PlanAlignment.claimed_at < now - timedelta(seconds=LEASE_SECONDS),
                ),
            ),
        ),
    )
    # SKIP LOCKED like the claim below: a row a SharePoint re-key holds must not stall the queue
    exhausted = (
        select(PlanAlignment.id)
        .where(eligible, PlanAlignment.attempts >= MAX_ATTEMPTS)
        .with_for_update(skip_locked=True)
    )
    await db.execute(
        update(PlanAlignment)
        .where(PlanAlignment.id.in_(exhausted))
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


async def give_back(db: AsyncSession, claim: Claim, now: datetime | None = None) -> bool:
    """Put a claimed job back because its object is held – a SharePoint run or an S3 pull holds it to
    its one commit, minutes away (`plans` › the lock order). ``pending`` again, the attempt NOT
    counted, no reason on the row, and not claimed before BUSY_RETRY_SECONDS have passed, so the
    worker goes on with the next job. False = the claim was lost meanwhile and nothing changed."""
    now = now or datetime.now(UTC)
    given = await db.execute(
        update(PlanAlignment)
        .where(
            PlanAlignment.id == claim.id,
            PlanAlignment.status == "processing",
            PlanAlignment.attempts == claim.attempt,
            PlanAlignment.edit_version == claim.edit_version,
        )
        .values(
            status="pending",
            claimed_at=now,
            attempts=PlanAlignment.attempts - 1,
            edit_version=PlanAlignment.edit_version + 1,
        )
        .returning(PlanAlignment.id)
    )
    return given.scalar_one_or_none() is not None


async def _try_give_back(db: AsyncSession, claim: Claim) -> bool:
    """`give_back` in its own bounded transaction. False = the row itself is held (a re-key) and
    nothing was written; True = written, or the claim is gone (requeued or dropped by the re-key)."""
    try:
        await limit_lock_wait(db, plans.WORKER_LOCK_WAIT_MS)
        await give_back(db, claim)
        await db.commit()
        return True
    except DBAPIError as exc:
        if not lock_wait_exceeded(exc):
            raise
        await db.rollback()
        return False


def _note_busy(claim_id: int) -> None:
    """A lock timeout on this job: the clock starts at the first, and past BUSY_WARN_MINUTES one
    WARNING says that something holds its object's plans (or its row) that long."""
    now = datetime.now(UTC)
    since = _busy_since.setdefault(claim_id, now)
    if now - since > timedelta(minutes=BUSY_WARN_MINUTES) and claim_id not in _busy_warned:
        _busy_warned.add(claim_id)
        logger.warning(
            "Plan alignment job %s: held for over %d min — something keeps its object's plans or its row",
            claim_id,
            BUSY_WARN_MINUTES,
        )
    else:
        logger.info("Plan alignment job %s: its object is held — back in the queue", claim_id)


def _settled(claim_id: int) -> None:
    """The job reached an outcome: forget it was ever busy."""
    _busy_since.pop(claim_id, None)
    _busy_warned.discard(claim_id)


async def _given_back(db: AsyncSession, claim: Claim, exc: DBAPIError) -> bool:
    """After a statement failed: True when it gave up waiting for a lock and the job went back."""
    if not lock_wait_exceeded(exc):
        return False
    await db.rollback()  # …which ends the wait limit too, so the give-back sets its own
    _note_busy(claim.id)
    if not await _try_give_back(db, claim):
        _owed[claim.id] = claim
        _owed_due[claim.id] = datetime.now(UTC) + timedelta(seconds=OWED_RETRY_SECONDS)
        logger.info("Plan alignment job %s: its row is held too — given back on a later tick", claim.id)
    return True


async def _settle_owed(factory: async_sessionmaker[AsyncSession]) -> None:
    """Write the give-backs a held row refused (`_owed`), each bounded; the rest wait for the next
    tick. Before any claim, so the lease never re-claims (and charges) a job that is owed back – the
    claim skips every owed job, due or not (`claim_job(owed=…)`)."""
    now = datetime.now(UTC)
    for claim_id, claim in list(_owed.items()):
        if _owed_due.get(claim_id, now) > now:
            continue
        async with factory() as db:
            if await _try_give_back(db, claim):
                del _owed[claim_id]
                _owed_due.pop(claim_id, None)
            else:
                _owed_due[claim_id] = now + timedelta(seconds=OWED_RETRY_SECONDS)
                _note_busy(claim_id)


async def finish_job(
    db: AsyncSession,
    claim: Claim,
    result: AlignmentResult,
    *,
    digest: str | None = None,
) -> bool:
    """A lost lease cannot overwrite a successor, an edited proposal, an approval or a job that a
    merge or re-key moved onto another dataset."""
    finished = (
        await db.execute(
            update(PlanAlignment)
            .where(
                PlanAlignment.id == claim.id,
                # a merge or re-key moved the job onto another dataset (and object) meanwhile: the
                # object this run locked is not its owner any more, so leave it to the next claim
                PlanAlignment.dataset_id == claim.dataset_id,
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


async def _still_owned(db: AsyncSession, claim: Claim) -> bool:
    """The job still belongs to the dataset (and so the object) this run read and locked."""
    owner = select(PlanAlignment.id).where(PlanAlignment.id == claim.id, PlanAlignment.dataset_id == claim.dataset_id)
    return (await db.execute(owner)).first() is not None


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
    await _settle_owed(factory)
    async with factory() as db:
        claim = await claim_job(db, owed=_owed)
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
        # whose «plans» lock 3 is – also for a row from before plans had an object, whose id still
        # names one (plan_approval.lock_plans_of takes it the same way): the approval below locks
        # it after finish_job's row lock otherwise, against the lock order
        named = plan_target(claim.dataset_id)
        object_uuid = obj.id if obj else (named[0] if named else None)
        object_id = str(obj.id) if obj else ""
        lng = float(obj.lng) if obj and obj.lng is not None else None
        lat = float(obj.lat) if obj and obj.lat is not None else None
        calibration = station.plan_scales_json if station else None
        # the catalogue's say on this module (auto / manual / none) – resolved here, in the
        # session, so compute never touches the database.
        # ⚠️ Not `deployment_config.read_config`: its fallback would align against the SHIPPED
        # catalogue, which the station did not choose. An unreadable document ends the job here,
        # before anything is written, and the admin reads why; a retry would only fail the same.
        stored = station.config_json if station else None
        try:
            modules = load_stored_config({} if stored is None else stored).modules
        except ValidationError:
            logger.warning("Plan alignment job %s: the station config cannot be read", claim.id, exc_info=True)
            try:
                await limit_lock_wait(db, plans.WORKER_LOCK_WAIT_MS)  # a re-key may hold the row
                await finish_job(db, claim, AlignmentResult("failed", "config_unreadable"))
                await db.commit()
                _settled(claim.id)
            except DBAPIError as exc:
                if not await _given_back(db, claim, exc):
                    raise
            return True
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
        try:
            # a bounded wait (plans › the lock order): a run holds its objects for minutes
            await limit_lock_wait(db, plans.WORKER_LOCK_WAIT_MS)
            if object_uuid is not None:
                # lock 3 before the floors and the row: a merge or a re-key holds the object while
                # it moves this revision's alignment and floors
                await lock_object_plans(db, object_uuid)
            if not await _still_owned(db, claim):
                return True  # moved onto another dataset meanwhile – the next claim takes it there
            requeued = await apply_marker_plan(db, claim, plan) if plan else False
            floors = await load_floors(db, claim.dataset_id, claim.version)
            # …and WHY it is what it is: a pack the markers could not make must not leave the admin
            # with an empty Geschoss list and no sentence about it (16.09.2026).
            await write_marker_notes(db, claim, plan, floors)
            await db.commit()
        except DBAPIError as exc:
            if not await _given_back(db, claim, exc):
                raise
            return True
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
    approves = result.reason == "markers" and marked_pack
    async with factory() as db:
        try:
            await limit_lock_wait(db, plans.WORKER_LOCK_WAIT_MS)
            if approves and object_uuid is not None:
                # the approval takes the object row (plans › the lock order): take it BEFORE
                # finish_job locks the alignment row, or an admin's Geschoss save on this row could
                # deadlock with it
                await lock_object_plans(db, object_uuid)
            written = await finish_job(db, claim, result, digest=digest)
            if written and approves:
                await approve_marker_fit(db, claim.id)
            await db.commit()
            _settled(claim.id)
        except DBAPIError as exc:
            if not await _given_back(db, claim, exc):
                raise
    return True

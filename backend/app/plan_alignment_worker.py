"""Lease one durable alignment job at a time; completion never publishes a revision."""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from functools import partial

import anyio
from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .database import async_session_maker
from .models import DeploymentConfig, ObjectSite, PlanAlignment, PlanRevision, ReferenceDataset
from .plan_alignment_compute import AlignmentResult, calibrated_scale, compute_alignment, module_alignment, render_page
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
        alignment = module_alignment(
            load_stored_config((station.config_json if station else None) or {}).modules, module
        )

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
            result = await compute_alignment(rendered, module, lng, lat, scale, alignment)
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
        await finish_job(db, claim, result, digest=digest)
        await db.commit()
    return True

"""APScheduler: periodic Divera poll (~2 min). Webhook + manual refresh cover the gaps.

Started/stopped from the FastAPI lifespan. No-op when no Divera access key is set.
"""

import logging

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI

from .config import settings
from .database import async_session_maker

logger = logging.getLogger(__name__)

_scheduler: AsyncIOScheduler | None = None


async def _poll_divera() -> None:
    from .divera import fetch_and_upsert

    async with async_session_maker() as db:
        try:
            new = await fetch_and_upsert(db)
            await db.commit()
            if new:
                logger.info("Divera poll: %d new alarm(s)", new)
        except Exception:  # noqa: BLE001
            await db.rollback()
            logger.exception("Divera poll failed")


async def _push_sweep() -> None:
    from .push import check_and_push

    async with async_session_maker() as db:
        try:
            sent = await check_and_push(db)
            await db.commit()
            if sent:
                logger.info("Push sweep: %d alert(s) sent", sent)
        except Exception:  # noqa: BLE001
            await db.rollback()
            logger.exception("Push sweep failed")


async def _auto_archive_sweep() -> None:
    from .alarms import auto_archive_sweep

    async with async_session_maker() as db:
        try:
            n = await auto_archive_sweep(db)
            await db.commit()
            if n:
                logger.info("Auto-archive sweep: %d incident(s)", n)
        except Exception:  # noqa: BLE001
            await db.rollback()
            logger.exception("Auto-archive sweep failed")


PRINT_JOB_RETENTION_DAYS = 7  # the paper is the artefact — the queue is transient
PRINT_JOB_SWEEP_SECONDS = 3600


async def _print_jobs_sweep() -> None:
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import delete

    from .models import PrintJob

    async with async_session_maker() as db:
        try:
            cutoff = datetime.now(UTC) - timedelta(days=PRINT_JOB_RETENTION_DAYS)
            res = await db.execute(delete(PrintJob).where(PrintJob.created_at < cutoff))
            await db.commit()
            if res.rowcount:
                logger.info("Print-job sweep: %d job(s) removed", res.rowcount)
        except Exception:  # noqa: BLE001
            await db.rollback()
            logger.exception("Print-job sweep failed")


async def _heartbeat() -> None:
    """Dead-man's-switch: ping an external check URL (healthchecks.io / cron-monitor) on a short
    cadence. If the app or its event loop dies, the pings stop and the monitor alerts — catching
    the "silently down / scheduler wedged" class a plain HTTP probe of /ready can miss. Fail-open:
    no URL = disabled; a failed ping never disturbs the app."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.get(settings.healthcheck_ping_url)
    except Exception:
        logger.warning("Heartbeat ping failed (non-fatal)")


async def start_scheduler(app: FastAPI) -> None:
    global _scheduler
    from .push import push_enabled

    jobs: list[str] = []
    _scheduler = AsyncIOScheduler()
    if settings.divera_access_key:
        _scheduler.add_job(
            _poll_divera,
            "interval",
            seconds=settings.divera_poll_interval_seconds,
            id="divera_poll",
            max_instances=1,
            coalesce=True,
        )
        jobs.append(f"divera poll ({settings.divera_poll_interval_seconds}s)")
    else:
        logger.info("Divera poll disabled (no DIVERA_ACCESS_KEY)")
    if push_enabled():
        _scheduler.add_job(
            _push_sweep,
            "interval",
            seconds=settings.push_check_seconds,
            id="push_sweep",
            max_instances=1,
            coalesce=True,
        )
        jobs.append(f"push sweep ({settings.push_check_seconds}s)")
    else:
        logger.info("Web push disabled (no VAPID keys)")
    if settings.print_agent_secret:
        _scheduler.add_job(
            _print_jobs_sweep,
            "interval",
            seconds=PRINT_JOB_SWEEP_SECONDS,
            id="print_jobs_sweep",
            max_instances=1,
            coalesce=True,
        )
        jobs.append(f"print-job sweep ({PRINT_JOB_SWEEP_SECONDS}s)")
    # Always on: a cheap no-op unless auto-opened incidents exist AND alarms.autoArchiveDays > 0.
    _scheduler.add_job(
        _auto_archive_sweep,
        "interval",
        seconds=settings.auto_archive_check_seconds,
        id="auto_archive",
        max_instances=1,
        coalesce=True,
    )
    jobs.append(f"auto-archive sweep ({settings.auto_archive_check_seconds}s)")
    if settings.healthcheck_ping_url:
        _scheduler.add_job(_heartbeat, "interval", seconds=60, id="heartbeat", max_instances=1, coalesce=True)
        jobs.append("heartbeat (60s)")
    _scheduler.start()
    logger.info("Scheduler running: %s", ", ".join(jobs))


async def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None

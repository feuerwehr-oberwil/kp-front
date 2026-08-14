"""APScheduler: periodic Divera poll (~2 min). Webhook + manual refresh cover the gaps.

Started/stopped from the FastAPI lifespan. No-op when no Divera access key is set.
"""

import logging
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import FastAPI

from .config import settings
from .database import async_session_maker, execute_dml
from .models import INCIDENT_ACTIVE_STATUSES

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
        except Exception:  # never let diagnostics wedge the scheduler
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
        except Exception:
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
        except Exception:
            await db.rollback()
            logger.exception("Auto-archive sweep failed")


async def _plan_pull() -> None:
    from .plans import pull_plans

    async with async_session_maker() as db:
        try:
            res = await pull_plans(db)
            await db.commit()
            if res.get("updated"):
                logger.info("Objektplan-Pull: %s plan(s) updated", res["updated"])
        except Exception:
            await db.rollback()
            logger.exception("Objektplan-Pull failed")


PRINT_JOB_RETENTION_DAYS = 7  # the paper is the artefact — the queue is transient
PRINT_JOB_SWEEP_SECONDS = 3600


async def _print_jobs_sweep() -> None:
    from sqlalchemy import delete

    from .models import PrintJob

    async with async_session_maker() as db:
        try:
            cutoff = datetime.now(UTC) - timedelta(days=PRINT_JOB_RETENTION_DAYS)
            res = await execute_dml(db, delete(PrintJob).where(PrintJob.created_at < cutoff))
            await db.commit()
            if res.rowcount:
                logger.info("Print-job sweep: %d job(s) removed", res.rowcount)
        except Exception:
            await db.rollback()
            logger.exception("Print-job sweep failed")


#: How often the vehicle feed is sampled into the incident record. Not the 15 s the map polls
#: at: this is a TRACK for the replay, and half-minute resolution draws the same route with a
#: fraction of the rows.
VEHICLE_SAMPLE_SECONDS = 30

#: A vehicle that has not moved this far is not sampled again — a fleet parked at the Magazin
#: would otherwise write a row per truck every 30 s for the whole Einsatz, and the replay would
#: scrub through hours of nothing. Roughly GPS noise plus a truck length.
VEHICLE_SAMPLE_MIN_MOVE_M = 20.0

#: …but a stationary vehicle still gets one row this often, so a replay can tell «parked here
#: the whole time» from «we stopped hearing from it». Measured in DEVICE time, like the move
#: threshold — see the note in the sweep.
VEHICLE_SAMPLE_HEARTBEAT_SECONDS = 600

#: What we last wrote per (incident, device): the device fix time and where it was.
#:
#: In memory rather than queried back, because the question is «what did WE last record for
#: this device», and the table cannot answer it — `VehicleSample.ts` is the DEVICE's fix time,
#: which for a parked tracker stops advancing and can be hours behind the wall clock. The first
#: version asked the table with a `ts >= now - 20min` filter and compared against `ts`, so a
#: parked vehicle matched nothing and looked permanently stale: it wrote a row on every single
#: tick, 8 rows a minute across the fleet, every one at an identical position. A restart simply
#: costs one extra row per vehicle, which is honest — it is where things stood when we came up.
_last_sample: dict[tuple[str, int], tuple[datetime, float, float]] = {}


async def _vehicle_samples_sweep() -> None:
    """Record where the vehicles were, so the Verlauf can replay them.

    This is the job `api/events.samples` has been reading an empty table for: the endpoint, the
    schema and the client-side replay all shipped, and nothing ever wrote a row
    (PLAN-audit-trail §4, Phase 6). Vehicles are station assets, not people — unlike the
    self-reported crew positions this one IS a history, kept with the incident and cascading
    with it.
    """
    from sqlalchemy import select

    from .geo_util import haversine_m
    from .models import Incident, VehicleSample
    from .traccar import traccar_client

    if not traccar_client.is_configured:
        return
    async with async_session_maker() as db:
        try:
            open_ids = list(
                (
                    await db.execute(
                        select(Incident.id).where(
                            Incident.is_archived.is_(False),
                            Incident.status.in_(INCIDENT_ACTIVE_STATUSES),
                        )
                    )
                ).scalars()
            )
            if not open_ids:
                return
            positions = await traccar_client.get_vehicle_positions()
            if not positions:
                return

            live = {str(i) for i in open_ids}
            for key in [k for k in _last_sample if k[0] not in live]:
                del _last_sample[key]  # an Einsatz that ended takes its memo with it

            written = 0
            for incident_id in open_ids:
                for p in positions:
                    key = (str(incident_id), p.device_id)
                    ts = p.last_update if p.last_update.tzinfo else p.last_update.replace(tzinfo=UTC)
                    prev = _last_sample.get(key)
                    if prev is None:
                        # Cold memo — a restart, or the first tick of a new Einsatz. Seed it from
                        # the newest row we already have for this device, or the deploy would
                        # re-record whatever fix the tracker is currently repeating and put a
                        # duplicate of it in the track. No time filter: the whole point is that a
                        # parked tracker's fix can be arbitrarily old.
                        seed = (
                            await db.execute(
                                select(VehicleSample.ts, VehicleSample.lat, VehicleSample.lng)
                                .where(
                                    VehicleSample.incident_id == incident_id,
                                    VehicleSample.device_id == p.device_id,
                                )
                                .order_by(VehicleSample.ts.desc())
                                .limit(1)
                            )
                        ).first()
                        if seed is not None:
                            seed_ts = seed[0] if seed[0].tzinfo else seed[0].replace(tzinfo=UTC)
                            prev = (seed_ts, float(seed[1]), float(seed[2]))
                            _last_sample[key] = prev
                    if prev is not None:
                        prev_ts, prev_lat, prev_lng = prev
                        # Nothing NEW from the device — Traccar re-serves the last fix on every
                        # poll, and re-recording it would stamp the same instant again and again.
                        # This is also what makes «we stopped hearing from it» legible: the track
                        # simply stops, instead of filling with copies of its final position.
                        if ts <= prev_ts:
                            continue
                        moved = haversine_m(prev_lat, prev_lng, p.latitude, p.longitude)
                        elapsed = (ts - prev_ts).total_seconds()
                        if moved < VEHICLE_SAMPLE_MIN_MOVE_M and elapsed < VEHICLE_SAMPLE_HEARTBEAT_SECONDS:
                            continue
                    db.add(
                        VehicleSample(
                            incident_id=incident_id,
                            device_id=p.device_id,
                            ts=ts,
                            lat=p.latitude,
                            lng=p.longitude,
                            course=p.course,
                            speed=p.speed,
                        )
                    )
                    _last_sample[key] = (ts, p.latitude, p.longitude)
                    written += 1
            await db.commit()
            if written:
                logger.info("Vehicle samples: %d row(s) recorded", written)
        except Exception:
            await db.rollback()
            logger.exception("Vehicle sample sweep failed")


POSITION_SWEEP_SECONDS = 3600


async def _positions_sweep() -> None:
    """Drop self-reported crew positions that have gone quiet (`position_ttl_hours`).

    Closing the Einsatz already deletes them; this is the backstop for the one nobody ever
    closes, so a name-and-coordinate pair can't sit in the database for days after the phone
    that reported it went home. The row is the only copy — there is no history to keep.
    """
    from sqlalchemy import delete

    from .models import PersonPosition

    async with async_session_maker() as db:
        try:
            cutoff = datetime.now(UTC) - timedelta(hours=settings.position_ttl_hours)
            res = await execute_dml(db, delete(PersonPosition).where(PersonPosition.updated_at < cutoff))
            await db.commit()
            if res.rowcount:
                logger.info("Position sweep: %d stale position(s) removed", res.rowcount)
        except Exception:
            await db.rollback()
            logger.exception("Position sweep failed")


async def _demo_reset() -> None:
    """DEMO ONLY: wipe + reseed the synthetic Musterdorf incident/roster (see demo_reset.reset).
    Runs in-process so the public demo self-cleans on an exact cadence, instead of relying on the
    GitHub Actions cron, which delays/skips scheduled runs (the demo drifted to 2.5 h+ between
    resets). `reset()` owns its own session + commit, so there's nothing to manage here.

    `wipe_objects=False`: the in-process job never reloads the reference Einsatzobjekte (only the
    GitHub workflow's `scripts/demo-reset.sh` does), so it must NOT delete them — otherwise the
    Schloss's Modul 1 / 2-3 / 6 plans vanish from the plan rail until the next GitHub reload."""
    from .demo_reset import reset

    try:
        await reset(wipe_objects=False)
    except Exception:
        logger.exception("Demo reset sweep failed")


async def _heartbeat() -> None:
    """Dead-man's-switch: ping an external check URL (healthchecks.io / cron-monitor) on a short
    cadence. If the app or its event loop dies, the pings stop and the monitor alerts — catching
    the "silently down / scheduler wedged" class a plain HTTP probe of /ready can miss. Fail-open:
    no URL = disabled; a failed ping never disturbs the app."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.get(settings.healthcheck_ping_url)
    except Exception:  # noqa: BLE001 — fail-open: a dead monitor must not disturb the app
        logger.warning("Heartbeat ping failed (non-fatal)")


async def _telemetry_flush() -> None:
    """Drain the telemetry outbox, if there is anything in it and consent still stands.

    Registered unconditionally but genuinely free when telemetry is off: `flush` returns at
    the first env check without touching the DB. Registering it always (rather than behind
    the env flag) means an admin who switches consent on does not have to restart anything.
    """
    from .telemetry.forwarder import flush
    from .telemetry.outbox import sweep

    async with async_session_maker() as db:
        try:
            await flush(db)
            await sweep(db)
            await db.commit()
        except Exception:
            await db.rollback()
            logger.exception("Telemetry flush failed")


async def start_scheduler(app: FastAPI) -> None:
    global _scheduler
    from .plans import plans_pull_enabled
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
    if plans_pull_enabled():
        _scheduler.add_job(
            _plan_pull,
            "interval",
            minutes=max(1, settings.plans_pull_interval_minutes),
            id="plan_pull",
            max_instances=1,
            coalesce=True,
        )
        jobs.append(f"Objektplan-Pull ({settings.plans_pull_interval_minutes}min)")
    else:
        logger.info("Objektplan-Pull disabled (no PLANS_S3_* store configured)")
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
    # Always on: a cheap no-op unless there is something for one of its two clocks to sweep
    # (alarms.autoArchiveDays for untouched auto-opened ones, alarms.staleIncidentDays for the
    # worked-on-but-never-closed ones); both at 0 makes it two indexed queries and done.
    _scheduler.add_job(
        _auto_archive_sweep,
        "interval",
        seconds=settings.auto_archive_check_seconds,
        id="auto_archive",
        max_instances=1,
        coalesce=True,
    )
    jobs.append(f"auto-archive sweep ({settings.auto_archive_check_seconds}s)")
    # Always on: a cheap no-op unless somebody is sharing their position. Not optional — this
    # is the deletion half of a privacy promise, so it must not hang off a feature flag.
    _scheduler.add_job(
        _positions_sweep,
        "interval",
        seconds=POSITION_SWEEP_SECONDS,
        id="positions_sweep",
        max_instances=1,
        coalesce=True,
    )
    jobs.append(f"position sweep ({POSITION_SWEEP_SECONDS}s)")
    # Only where a fleet is actually tracked — the job no-ops without Traccar, but there is no
    # point holding a timer for it.
    from .traccar import traccar_client

    if traccar_client.is_configured:
        _scheduler.add_job(
            _vehicle_samples_sweep,
            "interval",
            seconds=VEHICLE_SAMPLE_SECONDS,
            id="vehicle_samples",
            max_instances=1,
            coalesce=True,
        )
        jobs.append(f"vehicle samples ({VEHICLE_SAMPLE_SECONDS}s)")
    if settings.healthcheck_ping_url:
        _scheduler.add_job(_heartbeat, "interval", seconds=60, id="heartbeat", max_instances=1, coalesce=True)
        jobs.append("heartbeat (60s)")
    # Always on, and a no-op unless an admin has opted in — see _telemetry_flush.
    _scheduler.add_job(
        _telemetry_flush,
        "interval",
        minutes=max(1, settings.telemetry_flush_minutes),
        id="telemetry_flush",
        max_instances=1,
        coalesce=True,
    )
    jobs.append(f"telemetry flush ({settings.telemetry_flush_minutes}min)")
    # DEMO daily hard-reset. Prefer a crontab (Europe/Zurich local midnight) so the demo persists
    # edits during the day and only resets nightly; fall back to the legacy fixed-interval job.
    if settings.demo_reset_cron:
        _scheduler.add_job(
            _demo_reset,
            CronTrigger.from_crontab(settings.demo_reset_cron, timezone=ZoneInfo("Europe/Zurich")),
            id="demo_reset",
            max_instances=1,
            coalesce=True,
        )
        jobs.append(f"DEMO reset (cron '{settings.demo_reset_cron}' Europe/Zurich)")
        logger.warning(
            "DEMO auto-reset ACTIVE: this deployment WIPES + reseeds ALL incident data on cron "
            "'%s' (Europe/Zurich). If this is NOT the public demo, unset DEMO_RESET_CRON now.",
            settings.demo_reset_cron,
        )
    elif settings.demo_reset_seconds > 0:
        _scheduler.add_job(
            _demo_reset,
            "interval",
            seconds=settings.demo_reset_seconds,
            id="demo_reset",
            max_instances=1,
            coalesce=True,
        )
        jobs.append(f"DEMO reset ({settings.demo_reset_seconds}s)")
        # Loud, so an accidental prod activation is unmissable in the boot logs.
        logger.warning(
            "DEMO auto-reset ACTIVE: this deployment WIPES + reseeds ALL incident data every %ds. "
            "If this is NOT the public demo, unset DEMO_RESET_SECONDS now.",
            settings.demo_reset_seconds,
        )
    _scheduler.start()
    logger.info("Scheduler running: %s", ", ".join(jobs))


async def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None

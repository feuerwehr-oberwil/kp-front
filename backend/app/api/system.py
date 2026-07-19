"""Batch E — editor-only system/maintenance status (GET /api/system).

A single read-only endpoint backing the admin "System" tab: build/version, a trivial
DB liveness probe, row counts, media-storage + disk usage, and the env-derived
integration flags (handy on the same screen).

Resilience is the contract: this endpoint must NEVER 500. Each sub-section is computed
defensively — a failing probe yields a null/error section while the rest still render.
There is no new schema class; the response is a plain dict (docs/CONFIGURATION.md is the
source of truth for the config document, not this status payload).
"""

import logging
import os
import shutil

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentAdmin
from ..config import settings
from ..database import get_db
from ..models import Incident, Personnel, ReferenceDataset, User
from ..providers import integrations as provider_integrations

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/system", tags=["system"])


def _version() -> dict:
    """Build/version string from Railway's injected git env vars (fallbacks for dev)."""
    commit = os.getenv("RAILWAY_GIT_COMMIT_SHA") or "dev"
    branch = os.getenv("RAILWAY_GIT_BRANCH") or None
    return {
        "commit": commit,
        "branch": branch,
        "env": "production" if settings.is_production else "dev",
    }


async def _database_ok(db: AsyncSession) -> dict:
    """Trivial liveness probe; any failure → ok:false (never raises)."""
    try:
        await db.execute(text("SELECT 1"))
        return {"ok": True}
    except Exception:  # noqa: BLE001
        logger.warning("system: SELECT 1 probe failed", exc_info=True)
        return {"ok": False}


async def _count(db: AsyncSession, stmt) -> int | None:  # noqa: ANN001
    """Run a COUNT, returning None on failure so one bad query can't sink the section."""
    try:
        return int((await db.execute(stmt)).scalar_one())
    except Exception:  # noqa: BLE001
        logger.warning("system: count query failed", exc_info=True)
        return None


async def _counts(db: AsyncSession) -> dict:
    return {
        "incidents": await _count(db, select(func.count()).select_from(Incident)),
        "incidents_open": await _count(
            db,
            select(func.count())
            .select_from(Incident)
            .where(Incident.is_archived.is_(False)),
        ),
        "personnel_active": await _count(
            db,
            select(func.count())
            .select_from(Personnel)
            .where(Personnel.is_active.is_(True)),
        ),
        "users": await _count(db, select(func.count()).select_from(User)),
        "reference_datasets": await _count(
            db, select(func.count()).select_from(ReferenceDataset)
        ),
    }


def _storage() -> dict:
    """Walk the media dir summing file sizes + count, plus disk total/free.

    Never reads file contents. A missing dir reports zeros for used/count but still
    tries disk_usage on the nearest existing parent so the disk bar stays meaningful.
    """
    media_dir = os.path.abspath(settings.media_storage_dir)
    used_bytes = 0
    file_count = 0
    if os.path.isdir(media_dir):
        for dirpath, _dirnames, filenames in os.walk(media_dir):
            for name in filenames:
                fp = os.path.join(dirpath, name)
                try:
                    used_bytes += os.path.getsize(fp)
                    file_count += 1
                except OSError:
                    continue  # broken symlink / vanished file — skip

    disk_total_bytes: int | None = None
    disk_free_bytes: int | None = None
    # disk_usage needs an existing path; climb to the nearest existing ancestor.
    probe = media_dir
    while probe and not os.path.exists(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    try:
        usage = shutil.disk_usage(probe or os.sep)
        disk_total_bytes = usage.total
        disk_free_bytes = usage.free
    except OSError:
        logger.warning("system: disk_usage failed for %s", probe, exc_info=True)

    return {
        "media_dir": media_dir,
        "used_bytes": used_bytes,
        "file_count": file_count,
        "disk_total_bytes": disk_total_bytes,
        "disk_free_bytes": disk_free_bytes,
    }


async def _connectors(db: AsyncSession) -> list[dict]:
    """Every consumer/producer this deployment talks to, read-only — one row each for the
    admin System card. Direction is from the backend's point of view: 'in' = something
    sends/fetches data into us (webhooks, QR capture, stats pull, print agent), 'out' =
    we push/call an external service (web push, STT). Divera/Traccar polling lives in the
    provider registry above and is not repeated here."""
    from ..models import DeploymentConfig
    from ..push import push_enabled
    from .print_relay import relay_status

    row = (
        await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()

    relay = relay_status()
    return [
        {
            "id": "print_relay",
            "direction": "in",
            "configured": relay["configured"],
            "state": ("online" if relay["online"] else "offline") if relay["configured"] else None,
            "detail": relay["last_seen"],
        },
        {
            "id": "capture",
            "direction": "in",
            "configured": bool(row and row.capture_secret),
            "state": None,
            "detail": None,
        },
        {
            "id": "stats",
            "direction": "in",
            "configured": bool(row and row.stats_secret),
            "state": None,
            "detail": None,
        },
        {
            "id": "divera_webhook",
            "direction": "in",
            "configured": bool(settings.divera_webhook_secret),
            "state": None,
            "detail": None,
        },
        {
            "id": "alarm_webhook",
            "direction": "in",
            "configured": bool(settings.alarm_webhook_secret),
            "state": None,
            "detail": None,
        },
        {
            "id": "push",
            "direction": "out",
            "configured": push_enabled(),
            "state": None,
            "detail": None,
        },
        {
            "id": "stt",
            "direction": "out",
            "configured": bool(settings.stt_base_url),
            "state": None,
            "detail": settings.stt_base_url or None,
        },
    ]


@router.get("")
async def get_system(
    _admin: CurrentAdmin,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Admin-only maintenance/status snapshot. Resilient: each section is guarded
    so a partial failure returns that section as null/error and the rest fine.
    """
    try:
        version = _version()
    except Exception:  # noqa: BLE001
        logger.warning("system: version section failed", exc_info=True)
        version = None

    database = await _database_ok(db)

    try:
        counts = await _counts(db)
    except Exception:  # noqa: BLE001
        logger.warning("system: counts section failed", exc_info=True)
        counts = None

    try:
        storage = _storage()
    except Exception:  # noqa: BLE001
        logger.warning("system: storage section failed", exc_info=True)
        storage = None

    try:
        integrations = provider_integrations().model_dump()
    except Exception:  # noqa: BLE001
        logger.warning("system: integrations section failed", exc_info=True)
        integrations = None

    try:
        connectors = await _connectors(db)
    except Exception:  # noqa: BLE001
        logger.warning("system: connectors section failed", exc_info=True)
        connectors = None

    return {
        "version": version,
        "database": database,
        "counts": counts,
        "storage": storage,
        "integrations": integrations,
        "connectors": connectors,
    }

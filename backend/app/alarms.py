"""Alarm auto-open + auto-archive: the source-agnostic half of alarm intake.

`create_incident_from_alarm` is the one place an alarm becomes an Incident without a human
(generic `/api/alarms` intake and the Divera `alarms.autoOpen` path both land here); the
manual paths (wizard, pool take) keep their own endpoints. Auto-opened incidents are
marked `auto_opened` so the sweep can archive the untouched ones (`workspace_rev == 0`,
nobody ever synced a workspace) after `alarms.autoArchiveDays`.
"""

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import audit
from .geocode import geocode
from .models import DeploymentConfig, Incident
from .schemas import AlarmsConfig, DeploymentConfigIn

logger = logging.getLogger(__name__)


async def get_config_model(db: AsyncSession) -> DeploymentConfigIn:
    """The full validated deployment config; safe defaults on a missing/corrupt row."""
    row = (
        await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()
    raw = row.config_json if (row and row.config_json) else {}
    try:
        return DeploymentConfigIn.model_validate(raw)
    except Exception:  # noqa: BLE001 — a bad stored row must never break intake
        logger.warning("deployment_config failed validation; using defaults")
        return DeploymentConfigIn()


async def get_alarms_config(db: AsyncSession) -> AlarmsConfig:
    """The deployment's `alarms` config section; safe defaults on a missing/corrupt row."""
    return (await get_config_model(db)).alarms


async def is_demo_deployment(db: AsyncSession) -> bool:
    """True on the public demo (deployment config `identity.demoMode`). Single source of truth —
    the same flag the frontend reads — so no separate env var. Used to block creating NEW incidents
    while leaving edits to the existing demo incident fully open."""
    identity = (await get_config_model(db)).identity
    return bool(identity and identity.demoMode)


def passes_auto_open_filter(cfg: AlarmsConfig, *, title: str, text: str | None, priority: str) -> bool:
    """None filters accept everything; keywords are case-insensitive substrings of title+text."""
    if cfg.autoOpenPriorities is not None and priority not in cfg.autoOpenPriorities:
        return False
    if cfg.autoOpenKeywords is not None:
        combined = f"{title} {text or ''}".upper()
        if not any(k.upper() in combined for k in cfg.autoOpenKeywords if k):
            return False
    return True


async def find_by_source_ref(db: AsyncSession, source: str, source_ref: str) -> Incident | None:
    return (
        await db.execute(
            select(Incident).where(Incident.source == source, Incident.source_ref == source_ref)
        )
    ).scalar_one_or_none()


async def create_incident_from_alarm(
    db: AsyncSession,
    *,
    source: str,
    title: str,
    text: str | None = None,
    address: str | None = None,
    lat: float | None = None,
    lng: float | None = None,
    type_: str | None = None,
    priority: str | None = None,
    source_ref: str | None = None,
    divera_id: int | None = None,
    started_at: datetime | None = None,
) -> Incident:
    """Create an auto-opened incident from an alarm (no human in the loop).

    Mirrors the pool-take path: type/priority inferred from the title keywords when the
    sender didn't provide them, address geocoded only when no coordinate is available.
    """
    from .divera import detect_type, infer_priority  # lazy — avoids an import cycle

    title = title or "(ohne Titel)"
    # 0/0 is "no location", never a real coordinate (Divera's convention; also guards any
    # generic-intake sender) — clearing it lets the address geocoder below take over.
    if lat is not None and lng is not None and abs(lat) < 1e-6 and abs(lng) < 1e-6:
        lat = lng = None
    if (lat is None or lng is None) and address:
        coords = await geocode(address)
        if coords:
            lat, lng = coords
    if source == "divera" and source_ref is None and divera_id is not None:
        source_ref = str(divera_id)
    inc = Incident(
        # Deprecated dual-write for one compatibility release; source/source_ref is canonical.
        divera_id=divera_id if source == "divera" else None,
        source=source,
        source_ref=source_ref,
        title=title,
        type=type_ or detect_type(title),
        priority=priority or infer_priority(title, text),
        text=text,
        address=address,
        lat=lat,
        lng=lng,
        status="offen",
        auto_opened=True,
        created_by=None,
    )
    if started_at:
        inc.started_at = started_at
    db.add(inc)
    await db.flush()
    await audit.append_event(
        db, incident_id=inc.id, op_type="incident.create", source="status", user_id=None,
        payload={"title": inc.title, "source": inc.source, "auto": True},
    )
    from .webhooks import notify_incident_created  # lazy — avoids an import cycle

    await notify_incident_created(db, inc)
    return inc


async def auto_archive_sweep(db: AsyncSession) -> int:
    """Archive auto-opened incidents nobody ever touched (`workspace_rev == 0`) once they
    are older than `alarms.autoArchiveDays`. Human-created incidents are never swept."""
    cfg = await get_alarms_config(db)
    if cfg.autoArchiveDays <= 0:
        return 0
    cutoff = datetime.now(UTC) - timedelta(days=cfg.autoArchiveDays)
    rows = list(
        (
            await db.execute(
                select(Incident).where(
                    Incident.is_archived.is_(False),
                    Incident.auto_opened.is_(True),
                    Incident.workspace_rev == 0,
                    Incident.started_at < cutoff,
                )
            )
        ).scalars()
    )
    if not rows:
        return 0
    from .api.journal import append_system_row  # lazy — service module must not pull the API layer at import

    for inc in rows:
        inc.is_archived = True
        if inc.closed_at is None:
            inc.closed_at = datetime.now(UTC)
        await audit.append_event(
            db, incident_id=inc.id, op_type="status.change", source="status", user_id=None,
            payload={"archived": True, "auto": True},
        )
        await append_system_row(
            db, inc.id, icon="flag", text="Einsatz automatisch archiviert (nicht verwendet)"
        )
    logger.info("Auto-archive sweep: %d untouched incident(s) archived", len(rows))
    return len(rows)

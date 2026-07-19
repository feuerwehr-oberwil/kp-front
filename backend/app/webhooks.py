"""Outbound incident webhooks — the OSS-clean delivery layer for alarm side effects.

kp-front core knows nothing about printers, pagers, or chat bots: it POSTs one JSON payload
to every URL in `alarms.webhooks` when an incident is created (manual, Divera take,
auto-open, or generic intake), and the station wires whatever adapter it likes (see
docs/ALARM-INTEGRATIONS.md — e.g. a few-line forwarder to kp-rueck's QR slip printer).

Fail-open by design: delivery runs detached from the request (own task, own HTTP client,
no DB session), retries with backoff, and only ever logs — an unreachable receiver must
never delay or break alarm intake.
"""

import asyncio
import logging
from urllib.parse import urlsplit

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .models import Incident

logger = logging.getLogger(__name__)

RETRY_DELAYS_S = (0, 2, 8)  # first attempt immediate, then backoff


def build_incident_payload(inc: Incident, capture_token: str | None) -> dict:
    """The webhook body: incident facts + (when composable) the capture deep link."""
    capture_url = (
        f"{settings.public_url.rstrip('/')}/e/{capture_token}"
        if capture_token and settings.public_url
        else None
    )
    return {
        "event": "incident.created",
        "incident": {
            "id": str(inc.id),
            "title": inc.title,
            "type": inc.type,
            "priority": inc.priority,
            "address": inc.address,
            "lat": float(inc.lat) if inc.lat is not None else None,
            "lng": float(inc.lng) if inc.lng is not None else None,
            "source": inc.source,
            "started_at": inc.started_at.isoformat() if inc.started_at else None,
            "auto_opened": inc.auto_opened,
        },
        "capture_url": capture_url,
    }


async def _deliver(url: str, payload: dict) -> None:
    for delay in RETRY_DELAYS_S:
        if delay:
            await asyncio.sleep(delay)
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.post(url, json=payload)
            if r.status_code < 300:
                return
            logger.warning("Incident webhook %s answered %s", url, r.status_code)
        except Exception as e:  # noqa: BLE001 — fail-open, keep retrying
            logger.warning("Incident webhook %s failed: %s", url, e)
    logger.error("Incident webhook %s gave up after %d attempts", url, len(RETRY_DELAYS_S))


async def notify_incident_created(db: AsyncSession, inc: Incident) -> int:
    """Schedule delivery to every configured webhook. Returns how many were scheduled.

    Reads config + capture token NOW (while the session is alive), then detaches — the
    fired tasks own no DB state and outlive the request safely.
    """
    try:
        from sqlalchemy import select

        from .alarms import get_alarms_config
        from .models import DeploymentConfig

        cfg = await get_alarms_config(db)
        urls = [u for u in cfg.webhooks if urlsplit(u).scheme in ("http", "https")]
        if not urls:
            return 0
        row = (
            await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
        ).scalar_one_or_none()
        payload = build_incident_payload(inc, row.capture_secret if row else None)
        for url in urls:
            asyncio.create_task(_deliver(url, payload))
        return len(urls)
    except Exception:  # noqa: BLE001 — webhooks must never break intake
        logger.exception("Scheduling incident webhooks failed")
        return 0

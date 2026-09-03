"""Outbound incident webhooks — the OSS-clean delivery layer for alarm side effects.

kp-front core knows nothing about printers, pagers, or chat bots: it POSTs one JSON payload
to every URL in `alarms.webhooks`, and the station wires whatever adapter it likes (see
docs/ALARM-INTEGRATIONS.md — e.g. a few-line forwarder to kp-rueck's QR slip printer).

Two events, both to the same URLs, told apart by `event` — receivers switch on it:

* `incident.created` — an Einsatz opened (manual, Divera take, auto-open, generic intake);
* `alarm.attached`   — an upstream alarm was pinned onto an Einsatz that already existed.

Fail-open by design: delivery runs detached from the request (own task, own HTTP client,
no DB session), retries with backoff, and only ever logs — an unreachable receiver must
never delay or break alarm intake.
"""

import asyncio
import logging
from collections.abc import Callable
from functools import partial
from urllib.parse import urlsplit

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .models import Incident
from .transaction_hooks import after_commit

logger = logging.getLogger(__name__)

RETRY_DELAYS_S = (0, 2, 8)  # first attempt immediate, then backoff

# Strong references to in-flight delivery tasks; see notify_incident_created.
_inflight: set[asyncio.Task] = set()


def _schedule(url: str, payload: dict) -> None:
    """Start one detached delivery after its incident transaction committed."""
    task = asyncio.create_task(_deliver(url, payload))
    _inflight.add(task)
    task.add_done_callback(_inflight.discard)


def build_incident_payload(inc: Incident, capture_token: str | None) -> dict:
    """The webhook body: incident facts + (when composable) the capture deep link."""
    capture_url = (
        f"{settings.public_url.rstrip('/')}/e/{capture_token}" if capture_token and settings.public_url else None
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
            # The upstream's OWN id for this alarm (Divera alarm id, pager ref, …). Without
            # it a receiver can see that an incident opened but not WHICH of its alarms it
            # is, so anything it holds pending for that alarm can only be matched by
            # guessing. The alarm pipeline uses it to flush queued milestones the instant
            # the incident exists, instead of waiting out its retry cadence.
            "source_ref": inc.source_ref,
            "started_at": inc.started_at.isoformat() if inc.started_at else None,
            "auto_opened": inc.auto_opened,
        },
        "capture_url": capture_url,
    }


def build_alarm_attached_payload(inc: Incident, source: str, source_ref: str) -> dict:
    """The `alarm.attached` body: which upstream alarm now routes to which incident.

    An attach opens nothing. A second dispatch for the same physical Einsatz (Nachalarm,
    reworded group dispatch) is pinned onto an incident that already exists — very often a
    manually created one or an Übung, whose own `source`/`source_ref` say nothing about the
    alarm. So the alarm rides in its own block: a receiver holding something pending for
    THAT alarm learns where it belongs now, instead of waiting out its retry cadence.
    """
    return {
        "event": "alarm.attached",
        "incident": {"id": str(inc.id), "title": inc.title, "source": inc.source},
        "alarm": {"source": source, "source_ref": source_ref},
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


async def _notify(db: AsyncSession, build_payload: Callable[[str | None], dict]) -> int:
    """Queue one event's delivery to every configured webhook. Returns how many were queued.

    Reads config + capture token NOW (while the session is alive) and hands the token to
    `build_payload`, but starts detached delivery only after COMMIT. A later audit/incident
    write failure therefore cannot tell another system about an Einsatz — or an attach —
    which never happened. Fired tasks own no DB state.
    """
    try:
        from sqlalchemy import select

        from .alarms import get_alarms_config
        from .models import DeploymentConfig

        cfg = await get_alarms_config(db)
        urls = [u for u in cfg.webhooks if urlsplit(u).scheme in ("http", "https")]
        if not urls:
            return 0
        row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        payload = build_payload(row.capture_secret if row else None)
        for url in urls:
            # Keep a strong reference once started. asyncio only holds a WEAK one, so a
            # fire-and-forget task can otherwise be collected mid-flight.
            after_commit(db, partial(_schedule, url, payload))
        return len(urls)
    except Exception:  # webhooks must never break intake
        logger.exception("Scheduling incident webhooks failed")
        return 0


async def notify_incident_created(db: AsyncSession, inc: Incident) -> int:
    """An Einsatz opened — announce it, with the capture deep link where one is composable."""
    return await _notify(db, partial(build_incident_payload, inc))


async def notify_alarm_attached(db: AsyncSession, inc: Incident, source: str, source_ref: str) -> int:
    """A pooled alarm was attached to an existing Einsatz — announce where it routes now.

    No capture link: nothing was created, and the incident has had its own since it opened.
    """
    return await _notify(db, lambda _capture_token: build_alarm_attached_payload(inc, source, source_ref))

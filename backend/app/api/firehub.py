"""FireHub (Tercero) webhook integration.

FireHub fires a station-configured webhook on its ``Einsatzstart`` and ``Einsatzende``
triggers. This adapter maps that payload onto KP Front's alarm intake:

* ``start`` — auto-opens an incident, exactly like the generic ``POST /api/alarms`` path and
  like every other intake since 2026-08-02 (an alarm becomes an Einsatz on arrival). It is
  idempotent on ``(source="firehub", source_id=opsID)``: a redelivery returns the existing
  incident instead of opening a second one.
* ``end`` — stamps the Einsatzende on that incident's Rapport. KP Front owns the
  Einsatzrapport (KP Rück, which does not, only records an end as an audit note). FireHub
  carries no distinct end timestamp, so the receipt time is used.

Why ``start`` does NOT go through the Divera pool: the ``DiveraEmergency`` pool is keyed by an
integer ``divera_id`` and has no ``source`` column — it is Divera's, and an opsID is a
different namespace. KP Front's provider-neutral intake path (``alarms.create_incident_from_alarm``,
deduped on ``Incident.source``/``source_ref``) is the one built for exactly this, and it is
what the app's own «auto-open on arrival» flow now is. So FireHub rides it, source-tagged.

Why ``end`` stamps ``closed_at`` and nothing else: ``Incident.closed_at`` is the model's «first
Einsatzende» timestamp, and the Rapport reads ``reportMeta.endedAt ?? incident.closed_at`` (see
src/lib/reportPdfDirect.ts) — so writing it surfaces the Einsatzende on the sheet while an
operator-entered value still wins. It is NOT archived/closed: retiring the Einsatz and releasing
its crew stays the operator's decision (``is_open`` deliberately ignores ``closed_at``), the same
split KP Rück draws. A Wehr that does not want the stamp simply does not wire the Einsatzende
webhook.

Auth is the same shared secret as ``POST /api/alarms`` (``alarm_webhook_secret``) — ``?secret=``
or ``X-Webhook-Secret`` — and fails closed when none is configured. FireHub's JSON schema and
headers are FIXED (not per-webhook configurable), so a custom auth header is not an option; the
station puts ``?secret=…`` directly in the freely-choosable target URL, which is the auth path.

See docs/ALARM-INTEGRATIONS.md.
"""

import logging
import secrets
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from .. import audit
from ..alarms import create_incident_from_alarm, find_by_source_ref, lock_alarm_identity
from ..credentials import get as credential
from ..credentials import load as load_credentials
from ..database import get_db
from ..push import notify_new_alarm
from ..schemas import FireHubWebhook

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/firehub", tags=["firehub"])

SOURCE = "firehub"


def _check_secret(provided: str | None) -> None:
    """⚠️ Preceded by ``await load_credentials(db)`` at every call site — the secret is
    settable from /admin and must be live on the next request, not the next restart.

    The same ``alarm_webhook_secret`` the generic ``POST /api/alarms`` path checks: one
    intake secret for every non-Divera sender, FireHub included."""
    expected = credential("alarm_webhook_secret")
    if not expected:
        # Fail CLOSED: with no secret configured, anyone could open incidents remotely.
        # Setting ALARM_WEBHOOK_SECRET is the deployment's opt-in to generic intake.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Alarm-Intake deaktiviert (ALARM_WEBHOOK_SECRET nicht gesetzt)",
        )
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Ungültiges Webhook-Secret")


@router.post("/webhook", status_code=200)
async def webhook(
    payload: FireHubWebhook,
    request: Request,
    x_webhook_secret: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Receive a FireHub Einsatzstart/Einsatzende webhook. Secret via ?secret= or
    X-Webhook-Secret (same convention as the Divera and generic-intake webhooks). Always 200 —
    a redelivered start and an end for an unknown operation are both idempotent no-ops."""
    await load_credentials(db)
    _check_secret(request.query_params.get("secret") or x_webhook_secret)

    source_id = str(payload.operation.ops_id)
    if payload.trigger.action.lower() == "end":
        return await _handle_end(db, source_id)
    return await _handle_start(db, payload, source_id)


async def _handle_start(db: AsyncSession, payload: FireHubWebhook, source_id: str) -> dict:
    """Auto-open an incident from an Einsatzstart, deduping on (source, opsID)."""
    await lock_alarm_identity(db, SOURCE, source_id)
    existing = await find_by_source_ref(db, SOURCE, source_id)
    if existing is not None:
        logger.info("Duplicate FireHub alarm ignored: firehub:%s", source_id)
        return {"ok": True, "action": "start", "created": False, "incident_id": str(existing.id)}

    alarm = payload.to_alarm()
    inc = await create_incident_from_alarm(
        db,
        source=alarm.source,
        source_ref=alarm.source_id,
        title=alarm.title,
        text=alarm.text,
        address=alarm.address,
        lat=alarm.lat,
        lng=alarm.lng,
        type_=alarm.type,
        priority=alarm.priority,
        started_at=alarm.started_at,
    )
    logger.info("New FireHub alarm: firehub:%s, Title: %s", source_id, inc.title)
    await notify_new_alarm(db, tag=f"firehub-{source_id}", title=inc.title, address=inc.address, target=None)
    return {"ok": True, "action": "start", "created": True, "incident_id": str(inc.id)}


async def _handle_end(db: AsyncSession, source_id: str) -> dict:
    """Stamp the Einsatzende on the matching incident's Rapport, without closing the card.

    FireHub sends no end timestamp, so the receipt time is used. ``closed_at`` is write-once
    («the first Einsatzende», kept across a reopen), so a redelivered end — or an end that
    lands after an operator already closed the Einsatz — leaves the stamp untouched. An end
    for an operation we never opened (start lost, already archived away) is a no-op.
    """
    inc = await find_by_source_ref(db, SOURCE, source_id)
    if inc is None:
        logger.info("FireHub end for unknown operation firehub:%s — nothing to stamp", source_id)
        return {"ok": True, "action": "end", "stamped": False, "incident_id": None, "ended_at": None}

    if inc.closed_at is not None:
        logger.info("FireHub end for firehub:%s — Einsatzende already stamped", source_id)
        # DB datetimes are UTC; normalize to aware so the response format is identical whether
        # this call stamped closed_at or a prior one did (Postgres hands it back aware, SQLite naive).
        ended = inc.closed_at if inc.closed_at.tzinfo else inc.closed_at.replace(tzinfo=UTC)
        return {
            "ok": True,
            "action": "end",
            "stamped": False,
            "incident_id": str(inc.id),
            "ended_at": ended.isoformat(),
        }

    now = datetime.now(UTC)
    inc.closed_at = now
    await audit.append_event(
        db,
        incident_id=inc.id,
        op_type="status.change",
        source="status",
        user_id=None,
        payload={"source": SOURCE, "ops_id": source_id, "einsatzende": now.isoformat()},
    )
    from .journal import append_system_row  # lazy — API layer, avoid import cycle at module load

    when = now.astimezone(ZoneInfo("Europe/Zurich")).strftime("%H:%M")
    await append_system_row(db, inc.id, icon="flag", text=f"Einsatzende von FireHub gemeldet ({when})")
    await db.flush()
    logger.info("FireHub end stamped Einsatzende for firehub:%s (incident=%s)", source_id, inc.id)
    return {"ok": True, "action": "end", "stamped": True, "incident_id": str(inc.id), "ended_at": now.isoformat()}

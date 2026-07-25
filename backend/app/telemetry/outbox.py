"""The queue, and the transparency log that makes it inspectable.

Every payload is written to the station's OWN log, in full, before it is written to the
queue — and the queue row keeps it verbatim afterwards. Two independent copies on the
deployer's own infrastructure, neither of which we can see. That is the whole reason this
feature can be defended: "trust us" is not an argument you can make to a fire station, but
"here is the exact JSON, in your log, before it leaves, and in a table you can SELECT after"
is not an argument at all — it is just a fact they can check.

Home Assistant does the same thing with its analytics payload, and for the same reason.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import TelemetryOutbox

logger = logging.getLogger("kp.telemetry")

# How long a delivered row is kept so the deployer can still audit it after the fact. The
# payload is already in their log too; this is the convenient copy, not the record.
SENT_RETENTION = timedelta(days=14)
# An undeliverable row is not worth keeping forever — after this many tries the ingest is
# either gone or refusing us, and neither is fixed by a 200th attempt.
MAX_ATTEMPTS = 8
# One flush must not be able to hold the connection for long, so batches stay small.
BATCH = 20


def _log_payload(channel: str, payload: dict) -> None:
    """Print the outgoing payload to the deployer's log, in full, at INFO.

    INFO and not DEBUG on purpose: a station running default log levels must see this
    without being told to turn something on. It is a handful of lines per incident at
    most — this app does not generate enough errors for the volume to be a problem, and if
    it ever does, that is itself the thing worth seeing.
    """
    try:
        logger.info(
            "telemetry: queuing %s payload for upstream — exact content follows:\n%s",
            channel,
            json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True),
        )
    except Exception:  # noqa: BLE001 — logging must never break the caller
        logger.info("telemetry: queuing %s payload (not serialisable for display)", channel)


async def enqueue(db: AsyncSession, *, channel: str, payload: dict) -> TelemetryOutbox:
    """Log it, then queue it. Caller commits."""
    _log_payload(channel, payload)
    row = TelemetryOutbox(channel=channel, payload_json=payload)
    db.add(row)
    return row


async def pending(db: AsyncSession, *, limit: int = BATCH) -> list[TelemetryOutbox]:
    """Oldest-first batch of rows still waiting, skipping ones that have given up."""
    result = await db.execute(
        select(TelemetryOutbox)
        .where(TelemetryOutbox.sent_at.is_(None), TelemetryOutbox.attempts < MAX_ATTEMPTS)
        .order_by(TelemetryOutbox.created_at)
        .limit(limit)
    )
    return list(result.scalars().all())


def mark_sent(row: TelemetryOutbox) -> None:
    row.sent_at = datetime.now(UTC)
    row.last_error = None


def mark_failed(row: TelemetryOutbox, reason: str) -> None:
    row.attempts += 1
    # Bounded and never the remote body — an error string from someone else's server is not
    # something this instance should be storing verbatim.
    row.last_error = str(reason)[:200]


async def drop_unsent(db: AsyncSession, *, channel: str | None = None) -> int:
    """Delete everything still queued — what "switch it off" must actually mean.

    An operator who revokes consent expects the queue to stop, not to drain. Anything not
    yet delivered is deleted; delivered rows stay so the audit trail of what DID leave is
    not quietly rewritten by the same click.
    """
    stmt = delete(TelemetryOutbox).where(TelemetryOutbox.sent_at.is_(None))
    if channel:
        stmt = stmt.where(TelemetryOutbox.channel == channel)
    result = await db.execute(stmt)
    n = result.rowcount or 0
    if n:
        logger.info("telemetry: %d queued payload(s) discarded, nothing was sent", n)
    return n


async def sweep(db: AsyncSession) -> int:
    """Retention: drop delivered rows past SENT_RETENTION and rows that gave up."""
    cutoff = datetime.now(UTC) - SENT_RETENTION
    result = await db.execute(
        delete(TelemetryOutbox).where(
            (TelemetryOutbox.sent_at.is_not(None) & (TelemetryOutbox.sent_at < cutoff))
            | (TelemetryOutbox.sent_at.is_(None) & (TelemetryOutbox.attempts >= MAX_ATTEMPTS))
        )
    )
    return result.rowcount or 0

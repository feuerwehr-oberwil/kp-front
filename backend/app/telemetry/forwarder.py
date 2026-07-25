"""The only code in this repository that talks to a server we run.

Design constraints, in the order they mattered:

* **It must never wake up a tablet mid-incident.** Nothing here runs in a request path.
  A crash on the tablet posts to the station's own backend and that request ends there; the
  forward happens later, from the server, on a timer. An Einsatz never waits on our ingest
  being reachable, and an offline station simply queues.
* **It must fail silently and completely.** Every failure mode — no DSN, no consent, DNS
  gone, ingest 500, ingest 429 — leaves the instance running normally with a row still in
  the queue. A diagnostics path that can take down an Einsatzführungs-app has negative value.
* **Consent is re-checked at send time, not at queue time.** An admin who switches off
  between queue and flush must see nothing leave, so the flush drops the queue instead of
  draining it. Checking only at enqueue would let a revoked consent still ship a payload.
"""

from __future__ import annotations

import logging

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from . import outbox
from .consent import CONSENT_OFF, env_allows_outbound, get_consent
from .dsn import parse_dsn
from .envelope import serialise_envelope

logger = logging.getLogger("kp.telemetry")

# Short: the instance is not waiting on this, and a hung connection to our ingest must not
# hold a scheduler slot. If it can't be delivered in 10s it can be delivered in 5 minutes.
TIMEOUT = 10.0


async def flush(db: AsyncSession) -> int:
    """Send what's queued. Returns the number delivered. Never raises."""
    if not env_allows_outbound():
        return 0

    dsn = parse_dsn(settings.telemetry_dsn)
    if dsn is None:
        # Placeholder or malformed DSN — the normal state until the ingest is deployed.
        # Debug, not warning: this is not a problem an operator needs to act on.
        logger.debug("telemetry: no usable ingest DSN, nothing forwarded")
        return 0

    rows = await outbox.pending(db)
    if not rows:
        return 0

    # The manual channel carries its own consent (the operator pressed send), the background
    # channel needs the admin switch to still be on right now.
    consent = await get_consent(db)
    if consent == CONSENT_OFF:
        stale = [r for r in rows if r.channel == "error"]
        if stale:
            await outbox.drop_unsent(db, channel="error")
            rows = [r for r in rows if r.channel != "error"]
        if not rows:
            return 0

    sent = 0
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        for row in rows:
            try:
                response = await client.post(
                    dsn.envelope_url,
                    content=serialise_envelope(row.payload_json),
                    headers={
                        "Content-Type": "application/x-sentry-envelope",
                        "X-Sentry-Auth": dsn.auth_header,
                    },
                )
            except Exception as exc:  # noqa: BLE001 — offline is the expected case, not an error
                outbox.mark_failed(row, f"{type(exc).__name__}")
                logger.debug("telemetry: delivery failed (%s), staying queued", type(exc).__name__)
                continue

            if response.status_code == 429:
                # Rate-limited by our own ingest. Stop the whole batch rather than burning
                # through the queue against a closed door; the next tick tries again.
                outbox.mark_failed(row, "rate-limited")
                logger.info("telemetry: ingest rate-limited us, retrying later")
                break
            if response.is_success:
                outbox.mark_sent(row)
                sent += 1
            else:
                outbox.mark_failed(row, f"HTTP {response.status_code}")

    if sent:
        logger.info("telemetry: %d payload(s) delivered upstream", sent)
    return sent

"""Diagnostics: the station's own error sink, and the bundle an operator can hand over.

The sink came first and is still the primary thing this module does — a solo operator can't
see a frontend crash that the ErrorBoundary swallows, so the browser posts uncaught errors
here and they surface in the SERVER log, on the station's own machine, where the deployer
already looks. That path needs no consent and no network: it is the app telling its own
operator what happened.

* ``POST /client-error`` — the sink. Always logged and always buffered locally
  (``telemetry/recent.py``); additionally queued for an upstream ingest only when an admin
  has switched telemetry on AND the deployer configured a DSN. Unauthenticated (a crash can
  happen on the login screen), so it is capped per hour on top of the client's own cap.
* ``GET /export`` — the bundle an operator downloads and attaches to a mail or a GitHub
  issue. Any logged-in user, no consent involved: it hands them their own instance's
  sanitised error traces so a Rückmeldung can say more than "es ist abgestürzt". Nothing is
  transmitted by this route — the operator is, quite literally, the transport.

There used to be a third, ``POST /report``: the Rückmeldung sheet posted the operator's text
here and the forwarder carried it upstream. It went when the maintainer's ingest did. A
queued report with no destination is worse than no route at all, because the sheet says
«gesendet» and nothing ever arrives — so the sheet now opens a mail or an issue form
directly, and the only thing this module owes it is the export above.

The contract for all of it: never 500, never trust the payload. A diagnostics sink that
becomes a source of errors is worse than no sink.
"""

import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentAdmin, CurrentUser
from ..config import settings
from ..database import get_db
from ..models import TelemetryOutbox
from ..telemetry import consent as consent_mod
from ..telemetry import outbox, recent, scrub
from ..telemetry.envelope import build_event

logger = logging.getLogger("kpfront.clienterror")

router = APIRouter(prefix="/diag", tags=["diag"])

# Ceiling on background payloads queued per hour, per instance. The client already caps
# itself at 20 per session, but that cap lives in code an attacker controls — this one is
# ours. A wedged app producing 60 distinct errors an hour is a story we can already tell
# from the first 60; everything after that is noise we'd pay to store.
MAX_QUEUED_PER_HOUR = 60

APP_NAME = "kp-front"


class ClientError(BaseModel):
    """A bounded report of a frontend error. All fields optional/length-capped."""

    message: str = Field(default="", max_length=2000)
    stack: str | None = Field(default=None, max_length=8000)
    component_stack: str | None = Field(default=None, max_length=8000, alias="componentStack")
    # 'render' (ErrorBoundary) | 'error' (window.onerror) | 'unhandledrejection'
    kind: str = Field(default="error", max_length=40)
    path: str | None = Field(default=None, max_length=400)
    build: str | None = Field(default=None, max_length=120)


async def _queued_last_hour(db: AsyncSession) -> int:
    since = datetime.now(UTC) - timedelta(hours=1)
    return int(
        (
            await db.execute(
                select(func.count()).select_from(TelemetryOutbox).where(TelemetryOutbox.created_at >= since)
            )
        ).scalar()
        or 0
    )


@router.post("/client-error", status_code=204)
async def report_client_error(
    payload: ClientError,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Log a client-reported error at WARNING (visible without DEBUG). Never raises."""
    ua = request.headers.get("user-agent", "?")[:300]
    try:  # noqa: SIM105 — contextlib.suppress would hide which call is the fragile one
        logger.warning(
            "client-error kind=%s build=%s path=%s ua=%s :: %s%s%s",
            payload.kind,
            payload.build,
            payload.path,
            ua,
            payload.message,
            f"\n{payload.stack}" if payload.stack else "",
            f"\ncomponentStack:{payload.component_stack}" if payload.component_stack else "",
        )
    except Exception:  # noqa: BLE001, S110 — a diagnostics sink must never raise
        pass

    # Sanitised once, read twice. The local buffer below and the upstream envelope further
    # down share this object, so there is no path by which one of them carries a field the
    # other scrubbed away.
    error = scrub.build_error(
        kind=payload.kind,
        message=payload.message,
        stack=payload.stack,
        component_stack=payload.component_stack,
        path=payload.path,
    )

    # The local buffer, filled BEFORE and REGARDLESS of consent — it is what an operator's
    # diagnostics export attaches to a mail, and it never leaves this machine on its own.
    # Consent gates transmission; this is not transmission. See telemetry/recent.py.
    recent.record(error=error, release=payload.build or settings.version, device=scrub.device_class(ua))

    # Second hop: only with consent, and only if we haven't already queued enough this hour.
    try:
        if await consent_mod.get_consent(db) != consent_mod.CONSENT_ERRORS:
            return
        if await _queued_last_hour(db) >= MAX_QUEUED_PER_HOUR:
            logger.debug("telemetry: hourly queue cap reached, dropping")
            return
        install_id = await consent_mod.get_install_id(db, mint=True)
        event = build_event(
            channel="error",
            context=scrub.build_context(
                install_id=install_id or "unknown",
                app=APP_NAME,
                release=payload.build or settings.version,
                user_agent=ua,
            ),
            error=error,
        )
        await outbox.enqueue(db, channel="error", payload=event)
        await db.commit()
    except Exception:  # noqa: BLE001 — telemetry must never break the sink it hangs off
        await db.rollback()
        logger.debug("telemetry: could not queue client error", exc_info=True)


@router.get("/export")
async def export_diagnostics(
    request: Request,
    _user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The diagnostics bundle an operator attaches to a Rückmeldung.

    This is the answer to "pls fix". A mailed report carries a sentence and a build number;
    what makes a bug findable is the stack trace, and until this endpoint existed there was
    no way for the person who hit it to get one out of the app — the traces were in the
    server log, which needs a shell and is not something you attach to an e-mail.

    Logged-in user, not admin, deliberately: the person who hit the bug is whoever was
    holding the tablet, and a report they cannot complete is a report that does not arrive.
    Nothing here is new exposure — every field is the same sanitised text the app already
    shows that user verbatim in the Rückmeldung sheet before they send anything.

    Returns JSON rather than a file download so the caller keeps its session headers; the
    frontend turns it into the ``.json`` the operator attaches.
    """
    return {
        "generatedAt": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "app": APP_NAME,
        "release": settings.version,
        # Same random per-instance id the reports carry, so a mailed bundle and a report that
        # arrived some other way can be recognised as the same station without naming it.
        "install": await consent_mod.get_install_id(db),
        "device": scrub.device_class(request.headers.get("user-agent")),
        "errors": recent.snapshot(),
        # Stated so the absence of a trace is readable as "the process restarted" rather than
        # "the app has no errors" — the two look identical in an empty list.
        "errorsKept": recent.MAX_RECENT,
        "note": (
            "Bereinigte Fehlerprotokolle dieser Installation, seit dem letzten Neustart des "
            "Servers. Keine Einsatzdaten, keine Adressen, keine Namen, keine Zugangsdaten – "
            "siehe PRIVACY.md."
        ),
    }


# --- Admin surface --------------------------------------------------------------------


class ConsentUpdate(BaseModel):
    consent: str = Field(max_length=16)


@router.get("/telemetry")
async def telemetry_status(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    """Everything the admin screen needs to answer "what is this instance sending".

    Includes the last few payloads verbatim. The queue is the honest answer to that
    question and there is no reason to summarise it — a fire station should be able to read
    the actual JSON without opening psql.
    """
    rows = list(
        (await db.execute(select(TelemetryOutbox).order_by(TelemetryOutbox.created_at.desc()).limit(10)))
        .scalars()
        .all()
    )
    pending = sum(1 for r in rows if r.sent_at is None)
    return {
        "consent": await consent_mod.get_consent(db),
        # NULL consent is off, but it is not an ANSWER — the UI asks once rather than
        # letting "nobody looked at it yet" read as a decision.
        "decided": await consent_mod.is_decided(db),
        "installId": await consent_mod.get_install_id(db),
        # False when the DEPLOYER disabled it in env — the UI must then explain that the
        # switch it is showing cannot do anything, rather than pretend it can.
        "outboundAllowed": consent_mod.env_allows_outbound(),
        "ingestConfigured": bool(settings.telemetry_dsn),
        "pending": pending,
        "recent": [
            {
                "id": str(r.id),
                "channel": r.channel,
                "createdAt": r.created_at.isoformat() if r.created_at else None,
                "sentAt": r.sent_at.isoformat() if r.sent_at else None,
                "attempts": r.attempts,
                "lastError": r.last_error,
                "payload": r.payload_json,
            }
            for r in rows
        ],
    }


@router.put("/telemetry/consent")
async def update_consent(body: ConsentUpdate, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    """Turn the background channel on or off. Off also discards whatever is still queued."""
    try:
        value = await consent_mod.set_consent(db, body.consent)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None
    discarded = 0
    if value == consent_mod.CONSENT_OFF:
        discarded = await outbox.drop_unsent(db, channel="error")
    await db.commit()
    return {"consent": value, "discarded": discarded}


@router.post("/telemetry/install-id")
async def rotate_install_id(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    """Mint a fresh install id, cutting the link to everything sent so far."""
    new_id = await consent_mod.regenerate_install_id(db)
    await db.commit()
    return {"installId": new_id}

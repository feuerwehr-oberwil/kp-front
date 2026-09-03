"""Divera endpoints: webhook intake, pool list/refresh, open-or-correct, attach, archive."""

import uuid
from datetime import UTC
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import audit
from .. import divera as divera_svc
from ..alarms import is_demo_deployment
from ..auth.dependencies import CurrentEditor, EditorOrAdmin
from ..auth.secret_token import SecretGate
from ..credentials import get as credential
from ..credentials import load as load_credentials
from ..database import get_db
from ..geocode import geocode
from ..models import DiveraEmergency, Incident
from ..push import notify_new_alarm
from ..schemas import DiveraEmergencyOut, DiveraTakeBody, DiveraWebhookPayload, IncidentFull
from .incidents import get_incident_or_404

router = APIRouter(prefix="/divera", tags=["divera"])


#: Fail-closed like every other intake: with no secret configured, anyone could inject fake
#: alarms that an editor then "takes" into a real incident. Setting DIVERA_WEBHOOK_SECRET
#: enables the webhook; the polling path (pool/refresh) works without it.
_WEBHOOK = SecretGate(
    query_param="secret",
    disabled_detail="Webhook deaktiviert (DIVERA_WEBHOOK_SECRET nicht gesetzt)",
    invalid_detail="Ungültiges Webhook-Secret",
)


def _check_secret(request: Request, header_token: str | None) -> None:
    """⚠️ Call ``await load_credentials(db)`` before this — it reads the cached snapshot, and a
    secret set in /admin thirty seconds ago has to be live now, not at the next restart."""
    _WEBHOOK.check_request(credential("divera_webhook_secret"), request, header_token)


@router.post("/webhook", status_code=200)
async def webhook(
    payload: DiveraWebhookPayload,
    request: Request,
    x_webhook_secret: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Receive an alarm. Secret via ?secret= or X-Webhook-Secret. 200 even on duplicate."""
    await load_credentials(db)
    _check_secret(request, x_webhook_secret)
    em = await divera_svc.upsert_emergency(db, payload)
    inc = None
    if em is not None:
        inc = await divera_svc.maybe_auto_open(db, em)
        await notify_new_alarm(
            db,
            tag=f"divera-{payload.id}",
            title=payload.title,
            address=payload.address,
            target=None if inc else "divera",
        )
    return {"ok": True, "new": em is not None, "incident_id": str(inc.id) if inc else None}


@router.get("/pool", response_model=list[DiveraEmergencyOut])
async def pool(_user: CurrentEditor, db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(DiveraEmergency)
            .where(DiveraEmergency.is_taken.is_(False), DiveraEmergency.is_archived.is_(False))
            .order_by(DiveraEmergency.received_at.desc())
        )
    ).scalars()
    return list(rows)


@router.post("/pool/refresh")
async def refresh(_user: EditorOrAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    await load_credentials(db)
    if not credential("divera_access_key"):
        raise HTTPException(status_code=503, detail="Divera nicht konfiguriert (kein Access Key)")
    # A refused key is the ordinary failure here (rotated, or its scope changed), and it is
    # worth an answer rather than a 500. `DiveraApiError` carries the status code and never
    # the request URL — the URL is where the access key rides. See divera.DiveraApiError.
    try:
        new = await divera_svc.fetch_and_upsert(db)
    except divera_svc.DiveraApiError as e:
        raise HTTPException(status_code=502, detail=f"Divera nicht erreichbar: {e}") from None
    return {"new": new}


@router.post("/pool/{divera_id}/take", response_model=IncidentFull, status_code=201)
async def take(
    divera_id: int,
    user: CurrentEditor,
    response: Response,
    overrides: DiveraTakeBody | None = None,
    db: AsyncSession = Depends(get_db),
) -> Incident:
    """Open a pooled alarm — or, if it is already open, apply the EL's corrections to it.

    The intake wizard this endpoint was built for is gone (2026-08-02): an alarm becomes an
    Einsatz on arrival and the expert corrects it afterwards from the incident view. The
    endpoint stays, for two reasons that outlive the wizard. (1) The split-dispatch guard
    still parks alarms in the pool while an Einsatz is running, and this is how the EL opens
    one of those on purpose. (2) It is a published API surface — a client that still calls it
    with corrections gets them applied instead of a 409, which is the friendlier failure and
    keeps the EL's corrections working either way.

    What it must never do again is create a SECOND incident for an alarm that already has
    one; `taken_incident_id` is checked first, so a repeat call corrects rather than
    duplicates and answers `200` instead of `201`.
    """
    em = (await db.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == divera_id))).scalar_one_or_none()
    if em is None:
        raise HTTPException(status_code=404, detail="Alarm nicht im Pool")

    # EL corrections win over the mirrored Divera fields; anything left unset falls back to
    # the alarm (empty/absent body = the alarm verbatim).
    o = overrides or DiveraTakeBody()

    existing = await db.get(Incident, em.taken_incident_id) if em.taken_incident_id else None
    if existing is not None:
        if existing.is_archived:
            raise HTTPException(status_code=409, detail="Einsatz ist archiviert")
        await _apply_corrections(db, existing, o, user_id=user.id, divera_id=em.divera_id)
        response.status_code = status.HTTP_200_OK
        await db.refresh(existing)
        return existing
    if em.is_taken:
        # Taken but the incident is gone (hard-deleted Übung, or a legacy row) — nothing left
        # to open or correct, and re-creating it would resurrect a record someone removed.
        raise HTTPException(status_code=409, detail="Alarm bereits übernommen")
    if await is_demo_deployment(db):
        raise HTTPException(status_code=403, detail="In der Demo können keine neuen Einsätze übernommen werden.")

    title = o.title or em.title
    text = o.text if o.text is not None else em.text
    address = o.address if o.address is not None else em.address
    vocab = await divera_svc.active_vocabulary()
    type_ = o.type or divera_svc.detect_type(title, vocab=vocab)
    priority = o.priority or divera_svc.infer_priority(title, text, vocab=vocab)

    # Explicit coord override (pin moved / object picked) wins; else use the alarm's, and
    # geocode the (possibly corrected) address only when no coordinate is available at all.
    lat, lng = (o.lat, o.lng) if o.lat is not None and o.lng is not None else (em.lat, em.lng)
    # 0/0 = "no location" (Divera convention) — legacy pool rows predate the ingestion
    # validator and may still carry it verbatim; clear so the address geocoder takes over.
    if lat is not None and lng is not None and abs(lat) < 1e-6 and abs(lng) < 1e-6:
        lat = lng = None
    geocoded = False
    if (lat is None or lng is None) and address:
        coords = await geocode(address)
        if coords:
            lat, lng = coords
            geocoded = True

    inc = Incident(
        # Deprecated dual-write; generic provenance above is authoritative.
        divera_id=em.divera_id,
        title=title,
        type=type_,
        priority=priority,
        text=text,
        address=address,
        lat=lat,
        lng=lng,
        source="divera",
        source_ref=str(em.divera_id),
        status="offen",
        created_by=user.id,
    )
    # Alarmierungszeit = the alarm's own stamp. A take happens whenever somebody reaches the
    # tablet — the intake wizard hides the time field on this path precisely because it
    # promises «Divera take keeps the alarm's own time» (EinsatzWizard.tsx). Without this it
    # kept the INSERT time instead, and the Rapport printed the wrong Alarmierung.
    alarmed = divera_svc.alarm_time(em.ts_create)
    if alarmed:
        inc.started_at = alarmed
        inc.started_at_source = "alarm"
    db.add(inc)
    await db.flush()

    em.is_taken = True
    em.taken_incident_id = inc.id

    await audit.append_event(
        db,
        incident_id=inc.id,
        op_type="incident.create",
        source="status",
        user_id=user.id,
        payload={"title": inc.title, "source": "divera"},
    )
    await audit.append_event(
        db,
        incident_id=inc.id,
        op_type="divera.update",
        source="divera",
        user_id=user.id,
        payload={"divera_id": em.divera_id, "geocoded": geocoded},
    )
    from ..webhooks import notify_incident_created

    await notify_incident_created(db, inc)
    await db.refresh(inc)
    return inc


async def _apply_corrections(
    db: AsyncSession,
    inc: Incident,
    o: DiveraTakeBody,
    *,
    user_id: uuid.UUID | None,
    divera_id: int,
) -> None:
    """Write the EL's corrections onto an already-open incident. Only fields the caller
    actually sent are touched — an empty body is a no-op, not a reset to the alarm."""
    changed: dict[str, object] = {}
    for field in ("title", "type", "priority", "text", "address"):
        value = getattr(o, field)
        if value is not None and value != getattr(inc, field):
            setattr(inc, field, value)
            changed[field] = value
    if o.lat is not None and o.lng is not None:
        inc.lat, inc.lng = o.lat, o.lng
        changed["coord"] = [o.lng, o.lat]
    if not changed:
        return
    await db.flush()
    await audit.append_event(
        db,
        incident_id=inc.id,
        op_type="divera.update",
        source="divera",
        user_id=user_id,
        payload={"divera_id": divera_id, "corrected": sorted(changed)},
    )


@router.post("/pool/{divera_id}/attach/{incident_id}", status_code=200)
async def attach(
    divera_id: int,
    incident_id: uuid.UUID,
    user: CurrentEditor,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Attach a pool alarm to an EXISTING incident instead of opening a new one.

    The dispatch center may split one physical Einsatz into several Divera alarms
    (re-worded group dispatches, Nachalarm); taking each would create duplicate
    incidents (2026-07-15: PIO's GPS milestones landed in a duplicate nobody had
    open). Attach marks the alarm taken against the existing incident, so milestone
    routing (`/api/alarms/milestones`) follows it there via `taken_incident_id`.
    The incident's own title/address/coords are deliberately NOT touched — the
    alarm's Meldung lands as a Verlauf row instead."""
    em = (await db.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == divera_id))).scalar_one_or_none()
    if em is None:
        raise HTTPException(status_code=404, detail="Alarm nicht im Pool")
    if em.is_taken:
        raise HTTPException(status_code=409, detail="Alarm bereits übernommen")
    inc = await get_incident_or_404(db, incident_id)
    if inc.is_archived:
        raise HTTPException(status_code=409, detail="Einsatz ist archiviert")

    em.is_taken = True
    em.taken_incident_id = inc.id

    # DB datetimes are UTC; SQLite (tests) hands them back naive, Postgres tz-aware.
    recv = em.received_at if em.received_at.tzinfo else em.received_at.replace(tzinfo=UTC)
    when = recv.astimezone(ZoneInfo("Europe/Zurich")).strftime("%H:%M")
    text = f"Alarm hinzugefügt ({when}): {em.title}"
    if em.text:
        text += f" — {em.text}"
    if em.address:
        text += f" · {em.address}"
    from .journal import append_system_row

    await append_system_row(db, inc.id, icon="bell", text=text)
    await audit.append_event(
        db,
        incident_id=inc.id,
        op_type="divera.update",
        source="divera",
        user_id=user.id,
        payload={"divera_id": em.divera_id, "attached": True},
    )
    return {"ok": True, "incident_id": str(inc.id)}


@router.delete("/pool/{divera_id}", status_code=200)
async def archive(divera_id: int, _user: CurrentEditor, db: AsyncSession = Depends(get_db)) -> dict:
    em = (await db.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == divera_id))).scalar_one_or_none()
    if em is None:
        raise HTTPException(status_code=404, detail="Alarm nicht im Pool")
    em.is_archived = True
    return {"ok": True}

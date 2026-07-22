"""Divera endpoints: webhook intake, pool list/refresh, take → incident, attach, archive."""

import secrets
import uuid
from datetime import UTC
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import audit
from .. import divera as divera_svc
from ..alarms import is_demo_deployment
from ..auth.dependencies import CurrentEditor, EditorOrAdmin
from ..config import settings
from ..database import get_db
from ..geocode import geocode
from ..models import DiveraEmergency, Incident
from ..push import notify_new_alarm
from ..schemas import DiveraEmergencyOut, DiveraTakeBody, DiveraWebhookPayload, IncidentFull

router = APIRouter(prefix="/divera", tags=["divera"])


def _check_secret(provided: str | None) -> None:
    expected = settings.divera_webhook_secret
    if not expected:
        # Fail CLOSED: with no secret configured, anyone could inject fake alarms that an
        # editor then "takes" into a real incident. Set DIVERA_WEBHOOK_SECRET to enable
        # the webhook; the polling path (pool/refresh) works without it.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Webhook deaktiviert (DIVERA_WEBHOOK_SECRET nicht gesetzt)",
        )
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Ungültiges Webhook-Secret")


@router.post("/webhook", status_code=200)
async def webhook(
    payload: DiveraWebhookPayload,
    request: Request,
    x_webhook_secret: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Receive an alarm. Secret via ?secret= or X-Webhook-Secret. 200 even on duplicate."""
    _check_secret(request.query_params.get("secret") or x_webhook_secret)
    em = await divera_svc.upsert_emergency(db, payload)
    inc = None
    if em is not None:
        inc = await divera_svc.maybe_auto_open(db, em)
        await notify_new_alarm(
            db, tag=f"divera-{payload.id}", title=payload.title, address=payload.address,
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
    if not settings.divera_access_key:
        raise HTTPException(status_code=503, detail="Divera nicht konfiguriert (kein Access Key)")
    new = await divera_svc.fetch_and_upsert(db)
    return {"new": new}


@router.post("/pool/{divera_id}/take", response_model=IncidentFull, status_code=201)
async def take(
    divera_id: int,
    user: CurrentEditor,
    overrides: DiveraTakeBody | None = None,
    db: AsyncSession = Depends(get_db),
) -> Incident:
    if await is_demo_deployment(db):
        raise HTTPException(status_code=403, detail="In der Demo können keine neuen Einsätze übernommen werden.")
    em = (
        await db.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == divera_id))
    ).scalar_one_or_none()
    if em is None:
        raise HTTPException(status_code=404, detail="Alarm nicht im Pool")
    if em.is_taken:
        raise HTTPException(status_code=409, detail="Alarm bereits übernommen")

    # EL corrections from the intake wizard win over the mirrored Divera fields; anything
    # left unset falls back to the alarm. An empty/absent body = take verbatim (legacy).
    o = overrides or DiveraTakeBody()
    title = o.title or em.title
    text = o.text if o.text is not None else em.text
    address = o.address if o.address is not None else em.address
    type_ = o.type or divera_svc.detect_type(title)
    priority = o.priority or divera_svc.infer_priority(title, text)

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
    db.add(inc)
    await db.flush()

    em.is_taken = True
    em.taken_incident_id = inc.id

    await audit.append_event(
        db, incident_id=inc.id, op_type="incident.create", source="status", user_id=user.id,
        payload={"title": inc.title, "source": "divera"},
    )
    await audit.append_event(
        db, incident_id=inc.id, op_type="divera.update", source="divera", user_id=user.id,
        payload={"divera_id": em.divera_id, "geocoded": geocoded},
    )
    from ..webhooks import notify_incident_created

    await notify_incident_created(db, inc)
    await db.refresh(inc)
    return inc


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
    em = (
        await db.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == divera_id))
    ).scalar_one_or_none()
    if em is None:
        raise HTTPException(status_code=404, detail="Alarm nicht im Pool")
    if em.is_taken:
        raise HTTPException(status_code=409, detail="Alarm bereits übernommen")
    inc = await db.get(Incident, incident_id)
    if inc is None:
        raise HTTPException(status_code=404, detail="Einsatz nicht gefunden")
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
        db, incident_id=inc.id, op_type="divera.update", source="divera", user_id=user.id,
        payload={"divera_id": em.divera_id, "attached": True},
    )
    return {"ok": True, "incident_id": str(inc.id)}


@router.delete("/pool/{divera_id}", status_code=200)
async def archive(divera_id: int, _user: CurrentEditor, db: AsyncSession = Depends(get_db)) -> dict:
    em = (
        await db.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == divera_id))
    ).scalar_one_or_none()
    if em is None:
        raise HTTPException(status_code=404, detail="Alarm nicht im Pool")
    em.is_archived = True
    return {"ok": True}

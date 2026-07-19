"""Divera 24/7 intake logic: keyword maps, alarm parsing, pool upsert.

Keyword maps are lifted from kp-rueck. The title→type map yields a German *display
label* (kp-front carries `type` as a string, not an enum); the HIGH/LOW priority map is
verbatim. Improvement over kp-rueck: an existing pool alarm whose `ts_update` advanced
gets its fields refreshed.
"""

import logging
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import audit
from .config import settings
from .models import DiveraEmergency, Incident
from .push import notify_new_alarm
from .schemas import DiveraWebhookPayload

logger = logging.getLogger(__name__)

# Title keyword → display label (order matters; first hit wins).
TYPE_LABELS: dict[str, str] = {
    "FEUER": "Brandbekämpfung",
    "BRAND": "Brandbekämpfung",
    "HOCHWASSER": "Elementarereignis",
    "UNWETTER": "Elementarereignis",
    "STURM": "Elementarereignis",
    "VU": "Strassenrettung",
    "VERKEHR": "Strassenrettung",
    "UNFALL": "Strassenrettung",
    "THL": "Technische Hilfeleistung",
    "TECH": "Technische Hilfeleistung",
    "ÖL": "Ölwehr",
    "OELWEHR": "Ölwehr",
    "CHEMIE": "Chemiewehr",
    "STRAHLEN": "Strahlenwehr",
    "BAHN": "Einsatz Bahnanlagen",
    "BMA": "BMA / unechte Alarme",
    "FEHLALARM": "BMA / unechte Alarme",
    "DIENST": "Dienstleistungen",
    "TIER": "Gerettete Tiere",
}

HIGH_PRIORITY_KEYWORDS = [
    "BRAND", "FEUER", "FEUERALARM", "VOLLBRAND", "RAUCH", "FLAMMEN",
    "BMA", "BRANDMELDEANLAGE", "BRANDMELDER", "RAUCHMELDER",
    "PERSON IN", "PERSON IM", "EINGEKLEMMT", "EINGESCHLOSSEN", "ABSTURZ",
    "VERMISST", "BEWUSSTLOS", "VERLETZT",
    "VU", "VERKEHRSUNFALL",
    "GAS", "GASGERUCH", "GASAUSTRITT", "CHEMIE", "CHEMIKALIEN", "GEFAHRGUT", "GEFAHRSTOFF",
    "MED USTÜ", "MED.", "MEDIZINISCH", "REANIMATION", "NOTARZT", "RETTUNGSDIENST",
    "EXPLOSION", "DETONATION",
    "EINSTURZ", "EINGESTÜRZT",
    "LIFT", "AUFZUG", "FAHRSTUHL",
]


def detect_type(title: str) -> str:
    up = (title or "").upper()
    for keyword, label in TYPE_LABELS.items():
        if keyword in up:
            return label
    return "Diverse Einsätze"


def infer_priority(title: str, text: str | None = None) -> str:
    combined = f"{title} {text or ''}".upper()
    for keyword in HIGH_PRIORITY_KEYWORDS:
        if keyword in combined:
            return "HIGH"
    return "LOW"


def parse_alarms_response(data: dict) -> list[DiveraWebhookPayload]:
    """Parse Divera /alarms into payloads (skipping closed/archived)."""
    out: list[DiveraWebhookPayload] = []
    if not data.get("success"):
        logger.warning("Divera API returned success=false")
        return out
    items = data.get("data", {}).get("items", {})
    if isinstance(items, dict):
        items = list(items.values())
    for item in items:
        if item.get("closed") or item.get("archived"):
            continue
        try:
            out.append(
                DiveraWebhookPayload(
                    id=int(item.get("id", 0)),
                    number=item.get("foreign_id") or item.get("number") or None,
                    title=item.get("title", ""),
                    text=item.get("text", ""),
                    address=item.get("address", ""),
                    lat=item.get("lat"),
                    lng=item.get("lng"),
                    ts_create=item.get("ts_create") or item.get("date"),
                    ts_update=item.get("ts_update"),
                )
            )
        except (ValueError, TypeError) as e:
            logger.warning("Failed to parse alarm: %s", e)
    out.sort(key=lambda a: a.ts_create or 0, reverse=True)
    return out


async def upsert_emergency(db: AsyncSession, payload: DiveraWebhookPayload) -> DiveraEmergency | None:
    """Insert a new pool alarm or refresh an existing one if ts_update advanced.

    Returns the row if a *new* alarm was created, None for a known one (an update to a
    known alarm refreshes fields but is never a second alarm — dedupe by divera_id).
    """
    existing = (
        await db.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == payload.id))
    ).scalar_one_or_none()

    if existing is not None:
        if payload.ts_update and (existing.ts_update or 0) < payload.ts_update and not existing.is_taken:
            existing.title = payload.title or existing.title
            existing.text = payload.text
            existing.address = payload.address
            existing.lat = payload.lat
            existing.lng = payload.lng
            existing.ts_update = payload.ts_update
            existing.raw_payload_json = payload.model_dump()
        return None

    em = DiveraEmergency(
        divera_id=payload.id,
        divera_number=payload.number,
        title=payload.title or "(ohne Titel)",
        text=payload.text,
        address=payload.address,
        lat=payload.lat,
        lng=payload.lng,
        ts_update=payload.ts_update,
        raw_payload_json=payload.model_dump(),
    )
    db.add(em)
    return em


async def maybe_auto_open(db: AsyncSession, em: DiveraEmergency) -> Incident | None:
    """Auto-take a NEW pool alarm into an incident when `alarms.autoOpen` says so.

    The pool row stays (marked taken, like a manual take) so the intake UI history is
    unchanged; with the flag off — or a filter miss — the alarm simply waits in the pool
    for the manual take, exactly as before.
    """
    from .alarms import create_incident_from_alarm, get_alarms_config, passes_auto_open_filter

    cfg = await get_alarms_config(db)
    if not cfg.autoOpen:
        return None
    priority = infer_priority(em.title, em.text)
    if not passes_auto_open_filter(cfg, title=em.title, text=em.text, priority=priority):
        return None
    # Split-dispatch guard: while an Einsatz is RUNNING (open incident started within the
    # last few hours), a new alarm is far more likely a re-dispatch of the same Einsatz
    # (Nachalarm, reworded group SMS — 2026-07-15 Grenzweg 1) than a concurrent second
    # incident. Auto-opening would create the duplicate with no human in the loop; hold
    # it in the pool instead — the incoming-alarm banner offers both take AND attach.
    # The 4h window matches the dispatch pipeline's active-alarm timeout; an older open
    # incident (unfinished rapport, days later) must not suppress a genuinely new alarm.
    cutoff = datetime.now(UTC) - timedelta(hours=4)
    running = (
        await db.execute(
            select(func.count())
            .select_from(Incident)
            .where(Incident.is_archived.is_(False), Incident.started_at > cutoff)
        )
    ).scalar_one()
    if running:
        logger.info(
            "Auto-open suppressed for Divera %s: %d running incident(s) — pooled for take/attach",
            em.divera_id, running,
        )
        return None
    inc = await create_incident_from_alarm(
        db,
        source="divera",
        source_ref=str(em.divera_id),
        divera_id=em.divera_id,
        title=em.title,
        text=em.text,
        address=em.address,
        lat=float(em.lat) if em.lat is not None else None,
        lng=float(em.lng) if em.lng is not None else None,
        priority=priority,
    )
    em.is_taken = True
    em.taken_incident_id = inc.id
    await audit.append_event(
        db, incident_id=inc.id, op_type="divera.update", source="divera", user_id=None,
        payload={"divera_id": em.divera_id, "auto": True},
    )
    return inc


async def fetch_and_upsert(db: AsyncSession) -> int:
    """Poll Divera /alarms once and upsert into the pool. Returns new-alarm count."""
    if not settings.divera_access_key:
        return 0
    url = f"{settings.divera_api_url}/alarms"
    # SSRF defence-in-depth: divera_api_url is config-driven (not user input), but pin it to
    # https so a mis-set value can't be aimed at an internal endpoint with our access key.
    if urlsplit(url).scheme != "https":
        logger.warning("Divera API URL is not https; skipping fetch")
        return 0
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(url, params={"accesskey": settings.divera_access_key})
        r.raise_for_status()
        data = r.json()
    new = 0
    for alarm in parse_alarms_response(data)[: settings.divera_poll_max_alarms]:
        em = await upsert_emergency(db, alarm)
        if em is not None:
            new += 1
            inc = await maybe_auto_open(db, em)
            await notify_new_alarm(
                db, tag=f"divera-{alarm.id}", title=alarm.title, address=alarm.address,
                target=None if inc else "divera",
            )
    return new

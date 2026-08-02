"""Divera 24/7 intake logic: keyword maps, alarm parsing, pool upsert.

The keyword vocabulary is no longer a literal here. It lives in `data/divera_keywords.json`,
vendored byte-for-byte into kp-rueck and pinned by checksum in both — the same mechanism as
`app/telemetry/`, and for the same reason: the two products may not share a library
(`RUNNING-BOTH.md`), so the copies stay copies and a test compares them. It used to be two
hand-maintained tables that nobody compared, and they had already drifted.

What stays local is what is genuinely ours: the German labels (kp-front carries `type` as a
display string, not an enum) and the matcher. kp-rueck's matcher is not identical to this one
— see the JSON's `known_matcher_divergence`.

Improvement over kp-rueck: an existing pool alarm whose `ts_update` advanced gets its fields
refreshed.
"""

import logging
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import audit
from .config import settings
from .divera_keywords import FALLBACK_CATEGORY, HIGH_PRIORITY_KEYWORDS, KEYWORD_TO_CATEGORY
from .models import DiveraEmergency, Incident
from .push import notify_new_alarm
from .schemas import DiveraWebhookPayload

logger = logging.getLogger(__name__)

# Category key → the German string kp-front stores on the incident and shows the operator.
# This half is OURS: `incidents.type` is a display string here, the values are already in the
# database of every running station, and kp-rueck spells one of them differently
# ("BMA / Unechte Alarme"). Migrating a stored value to settle a capital letter is not worth
# it, so the disagreement is named in the JSON and the labels stay local.
#
# Mirrored for the operator-facing wizard in src/config/copy/de.ts (`intake.kategorien`),
# which copy.test.ts checks against the shared keyword file.
CATEGORY_LABELS: dict[str, str] = {
    "brandbekaempfung": "Brandbekämpfung",
    "elementarereignis": "Elementarereignis",
    "strassenrettung": "Strassenrettung",
    "technische_hilfeleistung": "Technische Hilfeleistung",
    "oelwehr": "Ölwehr",
    "chemiewehr": "Chemiewehr",
    "strahlenwehr": "Strahlenwehr",
    "einsatz_bahnanlagen": "Einsatz Bahnanlagen",
    "bma_unechte_alarme": "BMA / unechte Alarme",
    "dienstleistungen": "Dienstleistungen",
    "gerettete_tiere": "Gerettete Tiere",
    "diverse_einsaetze": "Diverse Einsätze",
}


def category_label(category: str) -> str:
    """German label for a shared category key, degrading to the fallback label if it is new.

    A category kp-rueck adds to the shared file before kp-front has a label for it must not
    stop this app from booting: it sits on the alarm intake path, and refusing to start is a
    far worse answer than filing one rare alarm under «Diverse Einsätze». The *loud* half of
    that trade lives in tests/test_divera_keywords.py, which fails the build on exactly this
    condition — so the gap is caught before it ships, and survivable if it ever ships anyway.
    """
    return CATEGORY_LABELS.get(category) or CATEGORY_LABELS[FALLBACK_CATEGORY]


# Title keyword → display label (order matters; first hit wins). Derived, not typed: the
# keyword half comes from the shared file so it cannot drift from kp-rueck's copy unnoticed.
TYPE_LABELS: dict[str, str] = {keyword: category_label(category) for keyword, category in KEYWORD_TO_CATEGORY}


def alarm_time(ts_create: int | None) -> datetime | None:
    """Divera's ``ts_create`` (unix seconds, UTC) as an aware datetime — the Alarmierungszeit.

    ``None`` for a missing or non-positive stamp: an incident opened from such an alarm keeps
    the server default and is marked as having no known alarm time, rather than inheriting
    epoch 0 or the moment the tablet was picked up.
    """
    if not ts_create or ts_create <= 0:
        return None
    try:
        return datetime.fromtimestamp(ts_create, tz=UTC)
    except (OverflowError, OSError, ValueError):
        logger.warning("Divera ts_create out of range: %r", ts_create)
        return None


def detect_type(title: str) -> str:
    up = (title or "").upper()
    for keyword, label in TYPE_LABELS.items():
        if keyword in up:
            return label
    return category_label(FALLBACK_CATEGORY)


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
            # ts_create is the alarm's birth time — an update never moves it, it only fills
            # it in for a row that arrived before the sender started sending it.
            existing.ts_create = existing.ts_create or payload.ts_create
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
        ts_create=payload.ts_create,
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
            em.divera_id,
            running,
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
        # The alarm's own time, not this moment: auto-open can trail the alarm by a poll
        # interval, and the pool row may have been waiting far longer than that.
        started_at=alarm_time(em.ts_create),
        started_at_source="alarm",
    )
    em.is_taken = True
    em.taken_incident_id = inc.id
    await audit.append_event(
        db,
        incident_id=inc.id,
        op_type="divera.update",
        source="divera",
        user_id=None,
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
                db,
                tag=f"divera-{alarm.id}",
                title=alarm.title,
                address=alarm.address,
                target=None if inc else "divera",
            )
    return new

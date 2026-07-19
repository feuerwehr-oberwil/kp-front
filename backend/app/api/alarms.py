"""Generic alarm intake: `POST /api/alarms` for non-Divera alerting systems.

Any upstream (canton dispatch, pager gateway, a curl script) POSTs an alarm and gets an
auto-opened incident back — this endpoint IS the auto-open for third-party sources, so it
is not gated by `alarms.autoOpen` (that flag covers the Divera pool path, which has a
manual-take UX to preserve). Idempotent on (source, source_id): a retried webhook returns
the existing incident. Fail-closed like the Divera webhook: no ALARM_WEBHOOK_SECRET → 403.
"""

import secrets
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..alarms import create_incident_from_alarm, find_by_source_ref, get_config_model
from ..config import settings
from ..database import get_db
from ..models import DiveraEmergency, Incident
from ..push import notify_new_alarm
from ..schemas import RESERVED_ALARM_SOURCES, AlarmIn, AlarmOut, MilestonesIn, MilestonesOut

router = APIRouter(prefix="/alarms", tags=["alarms"])


def _check_secret(provided: str | None) -> None:
    expected = settings.alarm_webhook_secret
    if not expected:
        # Fail CLOSED: with no secret configured, anyone could open incidents remotely.
        # Setting ALARM_WEBHOOK_SECRET is the deployment's opt-in to generic intake.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Alarm-Intake deaktiviert (ALARM_WEBHOOK_SECRET nicht gesetzt)",
        )
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Ungültiges Webhook-Secret")


@router.post("", response_model=AlarmOut, status_code=201)
async def intake(
    payload: AlarmIn,
    request: Request,
    response: Response,
    x_webhook_secret: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Receive an alarm. Secret via ?secret= or X-Webhook-Secret (same convention as the
    Divera webhook). Returns 201 with the new incident id, or 200 with the existing one
    when the same (source, source_id) was already delivered."""
    _check_secret(request.query_params.get("secret") or x_webhook_secret)
    if payload.source in RESERVED_ALARM_SOURCES:
        raise HTTPException(
            status_code=422,
            detail=f"source '{payload.source}' ist reserviert (Divera nutzt die eigene Integration)",
        )

    existing = await find_by_source_ref(db, payload.source, payload.source_id)
    if existing is not None:
        response.status_code = status.HTTP_200_OK
        return AlarmOut(incident_id=existing.id, created=False)

    inc = await create_incident_from_alarm(
        db,
        source=payload.source,
        source_ref=payload.source_id,
        title=payload.title,
        text=payload.text,
        address=payload.address,
        lat=payload.lat,
        lng=payload.lng,
        type_=payload.type,
        priority=payload.priority,
        started_at=payload.started_at,
    )
    await notify_new_alarm(
        db, tag=f"alarm-{payload.source}-{payload.source_id}", title=inc.title,
        address=inc.address, target=None,
    )
    return AlarmOut(incident_id=inc.id, created=True)


# --- Milestone enrichment --------------------------------------------------------------
# The alarm pipeline (e.g. fwo-divera's Traccar geofence state machine) pushes per-group
# alarm times and per-vehicle Ausrück/Vor-Ort/Zurück times as they happen. They land as
# structured reportMeta entries (the Zeiten grid + stats export read them) plus one
# journal row per NEW value, so the Verlauf shows «TLF ausgerückt 03:16» for free.


def _fmt_clock(dt: datetime) -> str:
    return dt.astimezone(ZoneInfo("Europe/Zurich")).strftime("%H:%M")


def apply_milestones(
    ws: dict | None,
    payload: MilestonesIn,
    group_labels: dict[str, str],
    vehicle_labels: dict[str, str],
) -> tuple[dict, int, list[str]]:
    """Pure upsert of milestone values into a workspace blob's reportMeta.

    Idempotent: replayed identical values change nothing. Operator edits win: an entry
    carrying `manual: True` is never touched. Unknown ids are stored verbatim (the form
    renders them as unmatched lines — never dropped). Returns (new_ws, changed_count,
    journal_texts)."""
    base = dict(ws or {})
    rm = dict(base.get("reportMeta") or {})
    changed = 0
    journal: list[str] = []

    gruppen = [dict(g) for g in (rm.get("gruppen") or []) if isinstance(g, dict)]
    by_id = {g.get("id"): g for g in gruppen}
    for g in payload.groups:
        iso = g.alarmedAt.isoformat()
        cur = by_id.get(g.id)
        if cur is None:
            entry = {"id": g.id, "alarmedAt": iso}
            gruppen.append(entry)
            by_id[g.id] = entry
            changed += 1
            journal.append(f"{group_labels.get(g.id, g.id)} alarmiert {_fmt_clock(g.alarmedAt)}")
        elif not cur.get("manual") and cur.get("alarmedAt") != iso:
            cur["alarmedAt"] = iso
            changed += 1

    fahrzeuge = [dict(v) for v in (rm.get("fahrzeuge") or []) if isinstance(v, dict)]
    vby_id = {v.get("id"): v for v in fahrzeuge}
    verbs = {"ausgerueckt": "ausgerückt", "vorOrt": "vor Ort", "zurueck": "zurück"}
    for v in payload.vehicles:
        cur = vby_id.get(v.id)
        if cur is None:
            cur = {"id": v.id}
            fahrzeuge.append(cur)
            vby_id[v.id] = cur
        if cur.get("manual"):
            continue
        for field, verb in verbs.items():
            val = getattr(v, field)
            if val is None:
                continue
            iso = val.isoformat()
            if cur.get(field) != iso:
                first = cur.get(field) is None
                cur[field] = iso
                changed += 1
                if first:
                    journal.append(f"{vehicle_labels.get(v.id, v.id.upper())} {verb} {_fmt_clock(val)}")

    rm["gruppen"] = gruppen
    rm["fahrzeuge"] = fahrzeuge
    base["reportMeta"] = rm
    return base, changed, journal


@router.post("/milestones", response_model=MilestonesOut)
async def milestones(
    payload: MilestonesIn,
    request: Request,
    x_webhook_secret: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Apply milestone times to an existing incident. 404 while no incident matches —
    the sender retries with backoff (dispatch precedes take/auto-open by minutes at most)."""
    _check_secret(request.query_params.get("secret") or x_webhook_secret)

    inc: Incident | None = None
    if payload.divera_id is not None:
        inc = (
            await db.execute(
                select(Incident).where(
                    Incident.source == "divera", Incident.source_ref == str(payload.divera_id)
                )
            )
        ).scalar_one_or_none()
        if inc is None:  # compatibility with incidents created before the provenance migration
            inc = (
                await db.execute(select(Incident).where(Incident.divera_id == payload.divera_id))
            ).scalar_one_or_none()
        if inc is None:
            # Alarm attached to an existing incident (POST /divera/pool/…/attach/…) instead
            # of opening its own: follow the pool entry's taken_incident_id so a split
            # dispatch's milestones land where the crew actually works (2026-07-15: PIO's
            # times went to a duplicate incident because each Divera alarm routed itself).
            em = (
                await db.execute(
                    select(DiveraEmergency).where(DiveraEmergency.divera_id == payload.divera_id)
                )
            ).scalar_one_or_none()
            if em is not None and em.taken_incident_id is not None:
                inc = await db.get(Incident, em.taken_incident_id)
    elif payload.source and payload.source_id:
        inc = await find_by_source_ref(db, payload.source, payload.source_id)
    else:
        raise HTTPException(status_code=422, detail="divera_id oder source+source_id erforderlich")
    if inc is None:
        raise HTTPException(status_code=404, detail="Kein passender Einsatz (später erneut versuchen)")

    cfg = await get_config_model(db)
    group_labels = {g.id: g.label for g in cfg.alarms.groups}
    vehicle_labels = {v.id: v.label for v in cfg.fleet.vehicles}

    new_ws, changed, journal_texts = apply_milestones(
        inc.map_workspace_json if isinstance(inc.map_workspace_json, dict) else None,
        payload, group_labels, vehicle_labels,
    )
    if changed:
        # Server-side blob write: bump the rev so polling clients pick it up and merge.
        # A racing client PUT can win LWW on these keys; the next milestone heals it.
        inc.map_workspace_json = new_ws
        inc.workspace_rev = (inc.workspace_rev or 0) + 1
        from .journal import append_system_row

        for text in journal_texts:
            await append_system_row(db, inc.id, icon="truck", text=text)
        await db.flush()
    return MilestonesOut(incident_id=inc.id, applied=changed)

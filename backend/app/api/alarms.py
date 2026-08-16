"""Generic alarm intake: `POST /api/alarms` for non-Divera alerting systems.

Any upstream (canton dispatch, pager gateway, a curl script) POSTs an alarm and gets an
auto-opened incident back. That is now what every intake path does — the Divera poll and
webhook opened theirs behind a config flag and a human take until 2026-08-02, and this
endpoint's unconditional behaviour is the one the others were moved to, not the exception.
Idempotent on (source, source_id): a retried webhook returns the existing incident.
Fail-closed like the Divera webhook: no ALARM_WEBHOOK_SECRET → 403.
"""

import secrets
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..alarms import create_incident_from_alarm, find_by_source_ref, get_config_model
from ..credentials import get as credential
from ..credentials import load as load_credentials
from ..database import execute_dml, get_db
from ..models import DiveraEmergency, Incident
from ..push import notify_new_alarm
from ..schemas import RESERVED_ALARM_SOURCES, AlarmIn, AlarmOut, MilestonesIn, MilestonesOut

router = APIRouter(prefix="/alarms", tags=["alarms"])


def _check_secret(provided: str | None) -> None:
    """⚠️ Preceded by ``await load_credentials(db)`` at every call site — the secret is now
    settable from /admin and must be live on the next request, not the next restart."""
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
    await load_credentials(db)
    _check_secret(request.query_params.get("secret") or x_webhook_secret)
    if payload.source in RESERVED_ALARM_SOURCES:
        raise HTTPException(
            status_code=422,
            detail=f"source '{payload.source}' ist reserviert (Divera nutzt die eigene Integration)",
        )

    # Only dedupe when the sender gave us an id to dedupe ON. `source_id` is optional now
    # (KP Rück always allowed it to be), and matching on None would collapse every
    # id-less alarm from one source into the first one ever received.
    if payload.source_id is not None:
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
        db,
        tag=f"alarm-{payload.source}-{payload.source_id}",
        title=inc.title,
        address=inc.address,
        target=None,
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


# Two milestones routinely land milliseconds apart — one vehicle crossing the geofence and
# reaching the scene fires both in the same breath. A plain read-modify-write on the blob
# then loses one of them (2026-07-31: PIO «ausgerückt» and «vor Ort» arrived 5 ms apart, the
# Verlauf kept both rows but the Ausrückzeit was gone from the record). So the write is a
# compare-and-swap on workspace_rev, exactly like the client save path in incidents.py:
# bump only if nobody moved the rev underneath us, else re-read and re-apply on top.
_CAS_ATTEMPTS = 5


async def _apply_and_store(
    db: AsyncSession,
    incident_id: uuid.UUID,
    payload: MilestonesIn,
    group_labels: dict[str, str],
    vehicle_labels: dict[str, str],
) -> tuple[int, list[str]]:
    """Upsert the milestone values into the incident's workspace blob. Returns
    (changed_count, journal_texts) — both empty when the values were already there."""
    for _ in range(_CAS_ATTEMPTS):
        # populate_existing: a losing round has to see the winner's blob, not the copy the
        # identity map still holds from before their UPDATE landed.
        inc = (
            await db.execute(
                select(Incident).where(Incident.id == incident_id).execution_options(populate_existing=True)
            )
        ).scalar_one()
        base_rev = inc.workspace_rev or 0
        new_ws, changed, journal_texts = apply_milestones(
            inc.map_workspace_json if isinstance(inc.map_workspace_json, dict) else None,
            payload,
            group_labels,
            vehicle_labels,
        )
        if not changed:
            return 0, []
        result = await execute_dml(
            db,
            update(Incident)
            .where(Incident.id == incident_id, Incident.workspace_rev == base_rev)
            .values(map_workspace_json=new_ws, workspace_rev=base_rev + 1),
        )
        if result.rowcount:
            return changed, journal_texts
    # Someone rewrote the blob under us five times running. The sender retries with backoff
    # and the upsert is idempotent, so a 503 costs a delay, never a milestone.
    raise HTTPException(status_code=503, detail="Workspace zu stark umkämpft — später erneut versuchen")


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
                select(Incident).where(Incident.source == "divera", Incident.source_ref == str(payload.divera_id))
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
                await db.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == payload.divera_id))
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

    # Server-side blob write: bumps the rev so polling clients pick it up and merge.
    # A racing client PUT can win LWW on these keys; the next milestone heals it.
    changed, journal_texts = await _apply_and_store(db, inc.id, payload, group_labels, vehicle_labels)

    # Where the alarm came in from. WRITE-ONCE: stamped by whichever milestone carries it
    # first and never rewritten, for the same reason `editor_opened_at` is a latch —
    # provenance is not an editable field, and a late edit from an alerting system must not
    # be able to change where an alarm came from. It deliberately does NOT count towards
    # `applied` and writes no journal row: it is a property of the alarm, not a milestone
    # someone reached, and the Verlauf is for what happened during the Einsatz.
    #
    # ⚠ Must come AFTER _apply_and_store, not before: that function re-selects the incident
    # with populate_existing=True (so a losing CAS round sees the winner's blob), which
    # overwrites this object's attributes from the database and would silently discard a
    # pending assignment made above it.
    if payload.origin and inc.alarm_origin is None:
        inc.alarm_origin = payload.origin
    if changed:
        from .journal import append_system_row

        for text in journal_texts:
            await append_system_row(db, inc.id, icon="truck", text=text)
        await db.flush()
    return MilestonesOut(incident_id=inc.id, applied=changed)

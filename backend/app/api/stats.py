"""Statistics export (`/api/stats/*`) — the read-only feed for external analytics.

One flat JSON record per incident (metadata + the capture-domain slices of the workspace
blob: Anwesenheit von–bis, Mittel totals, Partner, Rapport fields) so a consumer like the
private fwo-stats dashboard can join incidents against WinFAP without ever touching the
operational API.

Auth is a station-level, admin-rotatable token (`stats_secret`, same pattern as the
capture poster secret): NULL → the whole surface answers 403 (fail-closed). Strictly
read-only — no workspace blobs, no mutation endpoints on this token.

Two default exclusions keep the reported figures honest: Übungen, and incidents no editor
ever opened (`editor_opened_at IS NULL`). See `stats_incidents` for the second one — it is
what stops auto-opened alarms nobody attended being counted as Einsätze.

JOIN KEYS. The record has no shared identifier with a station's record system, so a consumer
matches on Alarmierungszeit + address and eats the error rate that comes with free-text
places. Three neutral fields exist to do better where a deployment can: `source` and
`source_ref` (whose alarm this was, as the alerting system named it) and `alarm_ref` — the
reference the alerting system printed on the alarm, which is what a station can transcribe
into its record system's free case-number field and join on exactly. None of them is a vendor
identifier and none of them is required; `alarm_ref` is simply null where nothing states one.
"""

import secrets
import uuid
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentAdmin
from ..database import get_db
from ..models import DeploymentConfig, DiveraEmergency, Incident

router = APIRouter(prefix="/stats", tags=["stats"])

# The record's local-year boundary. Deployment locale is de-CH; a 31.12. 23:30 incident
# must count in the old year, so the filter converts to local time, not UTC.
TZ = ZoneInfo("Europe/Zurich")

# Mirrors src/lib/rapportStatus.ts: the completing PATCH bumps updated_at moments after
# report_done_at — inside this window it's the completion itself, not a later change.
SELF_PATCH_EPSILON_S = 90


# --- admin: the export token ----------------------------------------------------------


async def _config_row(db: AsyncSession) -> DeploymentConfig:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db.add(row)
        await db.flush()
    return row


@router.get("/secret")
async def get_stats_secret(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    row = await _config_row(db)
    return {"configured": bool(row.stats_secret), "token": row.stats_secret}


@router.post("/secret/rotate")
async def rotate_stats_secret(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    """Mint a fresh export token — every consumer must be reconfigured at once."""
    row = await _config_row(db)
    row.stats_secret = secrets.token_urlsafe(24)
    await db.flush()
    return {"configured": True, "token": row.stats_secret}


@router.delete("/secret")
async def disable_stats(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    row = await _config_row(db)
    row.stats_secret = None
    await db.flush()
    return {"configured": False}


# --- the export -------------------------------------------------------------------------


async def _check_token(db: AsyncSession, request: Request, header_token: str | None) -> None:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    expected = row.stats_secret if row else None
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Statistik-Export deaktiviert (kein Export-Token gesetzt)",
        )
    provided = request.query_params.get("t") or header_token
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Ungültiger Export-Token")


def _rapport_state(report_done_at: datetime | None, updated_at: datetime | None) -> str:
    if report_done_at is None:
        return "open"
    if updated_at and (updated_at - report_done_at).total_seconds() > SELF_PATCH_EPSILON_S:
        return "changed"
    return "done"


def _mittel_key(e: dict) -> str:
    """Port of src/lib/mittel.ts mittelKey — one line per material·unit·source."""
    m = e.get("materialId") or f"~{str(e.get('label', '')).strip().lower()}"
    u = str(e.get("unit", "")).strip().lower()
    s = e.get("sourceId") or (f"~{str(e['sourceLabel']).strip().lower()}" if e.get("sourceLabel") else "")
    return f"{m}|{u}|{s}"


def _current_mittel(entries: Any) -> list[dict]:
    """Latest event per key wins (append-only running totals); zero lines drop out."""
    if not isinstance(entries, list):
        return []
    latest: dict[str, dict] = {}
    for e in entries:
        if not isinstance(e, dict) or not e.get("label"):
            continue
        key = _mittel_key(e)
        prev = latest.get(key)
        if prev is None or str(e.get("at", "")) >= str(prev.get("at", "")):
            latest[key] = e
    out = []
    for e in latest.values():
        menge = e.get("menge")
        if isinstance(menge, (int, float)) and menge > 0:
            out.append(
                {"label": e["label"], "menge": menge, "unit": e.get("unit") or "Stk", "source": e.get("sourceLabel")}
            )
    return sorted(out, key=lambda x: str(x["label"]))


def _attendance(att: Any) -> list[dict]:
    """One row per executed presence BLOCK.

    Someone who left and came back has several blocks; emitting only the outer span would bill
    the hours they were away. Entries written before blocks existed carry no ``intervals`` and
    project their single ``checkedInAt``/``leftAt`` pair, so both shapes read the same here.
    """
    if not isinstance(att, dict):
        return []
    out = []
    for pid, a in att.items():
        if not isinstance(a, dict):
            continue
        name = a.get("displayNameSnapshot") or pid
        raw = a.get("intervals")
        blocks = [b for b in raw if isinstance(b, dict)] if isinstance(raw, list) else []
        if not blocks:
            blocks = [{"from": a.get("checkedInAt"), "to": a.get("leftAt")}]
        for b in blocks:
            out.append(
                {
                    "name": name,
                    "von": b.get("from"),
                    "bis": b.get("to"),
                    "status": a.get("status"),
                }
            )
    return sorted(out, key=lambda x: (str(x["name"]), str(x["von"] or "")))


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _alarmiert_at(inc: Incident, rm: dict) -> str | None:
    """The effective Alarmierungszeit, or null when this record does not know one.

    Precedence mirrors every other surface (ReportPreflight, the Rapport-PDF, the capture
    app): an explicit ``reportMeta.alarmiertAt`` first, else ``started_at`` — which is the
    Alarmierungszeit column. The export used to read only the override, so it published null
    on every incident whose alarm time was never hand-edited, i.e. nearly all of them.

    The one thing it must NOT do is fall back to a ``started_at`` that nobody set: on those
    rows the column still holds the insert time, and handing that to a join keyed on alarm
    time produces confident nonsense. No provenance → null, and ``started_at`` plus
    ``started_at_source`` are right there for a consumer that wants to see the raw value.
    """
    override = rm.get("alarmiertAt")
    if override:
        return override
    return _iso(inc.started_at) if inc.started_at_source else None


async def _alarm_refs(db: AsyncSession) -> dict[uuid.UUID, str]:
    """incident id → the reference the alerting system printed on the alarm.

    Kept as its own lookup rather than an OUTER JOIN on purpose: an incident can absorb a
    SECOND pool alarm (the split-dispatch attach path in ``alarms.open_pooled_alarm``), so a
    join would silently emit that incident twice and double it in the consumer's figures.
    Earliest arrival wins — the merged re-dispatch carries the same reference anyway, and if
    it does not, the first alarm is the one whose slip was printed.

    Source-agnostic by intent. The pool is the only place an alerting system currently states
    an alarm reference, so today Divera's is the only branch; a second intake with a reference
    of its own adds its lookup here and the exported field keeps its meaning.
    """
    rows = (
        await db.execute(
            select(DiveraEmergency.taken_incident_id, DiveraEmergency.divera_number)
            .where(DiveraEmergency.taken_incident_id.is_not(None))
            .where(DiveraEmergency.divera_number.is_not(None))
            .order_by(DiveraEmergency.received_at.asc())
        )
    ).all()
    out: dict[uuid.UUID, str] = {}
    for incident_id, ref in rows:
        out.setdefault(incident_id, ref)
    return out


def _record(inc: Incident, alarm_ref: str | None = None) -> dict:
    ws = inc.map_workspace_json if isinstance(inc.map_workspace_json, dict) else {}
    # Bind before the isinstance so the narrowing sticks (and so reportMeta is looked up once).
    raw_rm = ws.get("reportMeta")
    rm = raw_rm if isinstance(raw_rm, dict) else {}
    return {
        "id": str(inc.id),
        "started_at": _iso(inc.started_at),
        # Where started_at came from: 'alarm' | 'manual' | null. NULL says the value is the
        # record-open time — the incident is real, one column just isn't an alarm time.
        "started_at_source": inc.started_at_source,
        # When the record was opened in the app. Kept as its own field so «how long after the
        # alarm did somebody reach the tablet» stays measurable instead of being smuggled
        # into started_at, which is what it used to be.
        "created_at": _iso(inc.created_at),
        "closed_at": _iso(inc.closed_at),
        "title": inc.title,
        "text": inc.text,
        "kategorie": inc.type,
        "priority": inc.priority,
        "address": inc.address,
        "lat": inc.lat,
        "lng": inc.lng,
        "source": inc.source,
        # The neutral provenance pair. `source_ref` is the alerting system's own id for the
        # alarm and is what the intake deduplicates on — it identifies the ALARM, not the
        # incident, and for a Divera deployment it is a bare integer.
        "source_ref": inc.source_ref,
        # The reference the alerting system printed on the alarm — the string that ends up on
        # the Einsatz slip and therefore in the paper report's free field. Null when no
        # alerting system stated one. ⚠️ It is not unique per incident: Oberwil's is derived
        # from the address alone, so incidents at the same place repeat it (measured 52.9%).
        # Match it INSIDE a time window; a repeated reference is ambiguous, not a pair.
        "alarm_ref": alarm_ref,
        "is_archived": inc.is_archived,
        "is_exercise": inc.is_exercise,
        "confirmed_at": _iso(inc.editor_opened_at),
        "rapport": _rapport_state(inc.report_done_at, inc.updated_at),
        "report_done_at": _iso(inc.report_done_at),
        # reportMeta slices (ISO strings maintained by the app; passed through verbatim)
        "alarmiertAt": _alarmiert_at(inc, rm),
        "ausgeruecktAt": rm.get("ausgeruecktAt"),
        "endedAt": rm.get("endedAt"),
        "einsatzleiter": rm.get("einsatzleiter"),
        "kontaktperson": rm.get("kontaktperson"),
        "summary": rm.get("summary"),
        "partner": [
            {"org": p.get("org"), "name": p.get("name")}
            for p in (rm.get("partnerContacts") or [])
            if isinstance(p, dict) and p.get("org")
        ],
        # Phase-3 fields (Gruppen/Fahrzeuge grids, G4) pass through once the app writes them
        "gruppen": rm.get("gruppen") or [],
        "fahrzeuge": rm.get("fahrzeuge") or [],
        "eigentuemer": rm.get("eigentuemer"),
        "gerettete": rm.get("gerettete"),
        "rueckmeldungElz": rm.get("rueckmeldungElz"),
        "attendance": _attendance(ws.get("attendance")),
        "mittel": _current_mittel(ws.get("mittel")),
    }


@router.get("/incidents")
async def stats_incidents(
    request: Request,
    year: int | None = Query(default=None, ge=2000, le=2100),
    include_exercises: bool = Query(default=False),
    include_unconfirmed: bool = Query(default=False),
    x_stats_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """All confirmed incidents (optionally one local calendar year), oldest first, flat records.

    Übungen are excluded by default — they must not land in the WinFAP/fwo-stats numbers;
    ?include_exercises=1 exports them too (each record carries is_exercise).

    So are UNCONFIRMED incidents, and that filter is the one doing real work since alarms
    started opening themselves (2026-08-02). An incident now exists for every alarm that ever
    arrived — test alarms, Nachbarhilfe, re-dispatches, an Einsatz-Link tapped for something
    the station never turned out for. The line between «an alarm arrived» and «we attended an
    Einsatz» is `editor_opened_at`: stamped the first time an authenticated *editor* opens the
    workspace, never for a viewer or a link guest. NULL means nobody at the station ever had
    this incident on a tablet, and such a row must not reach the canton's figures.
    ?include_unconfirmed=1 exports them too (each record carries `confirmed_at`), for a
    consumer that wants the alarm volume rather than the Einsatz count."""
    await _check_token(db, request, x_stats_token)
    q = select(Incident).order_by(Incident.started_at.asc())
    if not include_exercises:
        q = q.where(Incident.is_exercise.is_(False))
    if not include_unconfirmed:
        q = q.where(Incident.editor_opened_at.is_not(None))
    rows = (await db.execute(q)).scalars()
    alarm_refs = await _alarm_refs(db)
    out = []
    for inc in rows:
        if year is not None:
            started = inc.started_at
            if started is None:
                continue
            if started.tzinfo is None:
                started = started.replace(tzinfo=UTC)
            if started.astimezone(TZ).year != year:
                continue
        out.append(_record(inc, alarm_refs.get(inc.id)))
    return out

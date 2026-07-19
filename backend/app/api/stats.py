"""Statistics export (`/api/stats/*`) — the read-only feed for external analytics.

One flat JSON record per incident (metadata + the capture-domain slices of the workspace
blob: Anwesenheit von–bis, Mittel totals, Partner, Rapport fields) so a consumer like the
private fwo-stats dashboard can join incidents against WinFAP without ever touching the
operational API.

Auth is a station-level, admin-rotatable token (`stats_secret`, same pattern as the
capture poster secret): NULL → the whole surface answers 403 (fail-closed). Strictly
read-only — no workspace blobs, no mutation endpoints on this token.
"""

import secrets
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentAdmin
from ..database import get_db
from ..models import DeploymentConfig, Incident

router = APIRouter(prefix="/stats", tags=["stats"])

# The record's local-year boundary. Deployment locale is de-CH; a 31.12. 23:30 incident
# must count in the old year, so the filter converts to local time, not UTC.
TZ = ZoneInfo("Europe/Zurich")

# Mirrors src/lib/rapportStatus.ts: the completing PATCH bumps updated_at moments after
# report_done_at — inside this window it's the completion itself, not a later change.
SELF_PATCH_EPSILON_S = 90


# --- admin: the export token ----------------------------------------------------------


async def _config_row(db: AsyncSession) -> DeploymentConfig:
    row = (
        await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()
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
    row = (
        await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()
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
            out.append({"label": e["label"], "menge": menge, "unit": e.get("unit") or "Stk",
                        "source": e.get("sourceLabel")})
    return sorted(out, key=lambda x: str(x["label"]))


def _attendance(att: Any) -> list[dict]:
    if not isinstance(att, dict):
        return []
    out = []
    for pid, a in att.items():
        if not isinstance(a, dict):
            continue
        out.append({
            "name": a.get("displayNameSnapshot") or pid,
            "von": a.get("checkedInAt"),
            "bis": a.get("leftAt"),
            "status": a.get("status"),
        })
    return sorted(out, key=lambda x: str(x["name"]))


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _record(inc: Incident) -> dict:
    ws = inc.map_workspace_json if isinstance(inc.map_workspace_json, dict) else {}
    rm = ws.get("reportMeta") if isinstance(ws.get("reportMeta"), dict) else {}
    return {
        "id": str(inc.id),
        "started_at": _iso(inc.started_at),
        "closed_at": _iso(inc.closed_at),
        "title": inc.title,
        "text": inc.text,
        "kategorie": inc.type,
        "priority": inc.priority,
        "address": inc.address,
        "lat": inc.lat,
        "lng": inc.lng,
        "source": inc.source,
        "is_archived": inc.is_archived,
        "is_exercise": inc.is_exercise,
        "rapport": _rapport_state(inc.report_done_at, inc.updated_at),
        "report_done_at": _iso(inc.report_done_at),
        # reportMeta slices (ISO strings maintained by the app; passed through verbatim)
        "alarmiertAt": rm.get("alarmiertAt"),
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
    x_stats_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """All incidents (optionally one local calendar year), oldest first, flat records.

    Übungen are excluded by default — they must not land in the WinFAP/fwo-stats numbers;
    ?include_exercises=1 exports them too (each record carries is_exercise)."""
    await _check_token(db, request, x_stats_token)
    q = select(Incident).order_by(Incident.started_at.asc())
    if not include_exercises:
        q = q.where(Incident.is_exercise.is_(False))
    rows = (await db.execute(q)).scalars()
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
        out.append(_record(inc))
    return out

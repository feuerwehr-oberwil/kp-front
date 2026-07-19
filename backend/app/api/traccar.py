"""Traccar endpoints — replace the kp-rueck proxy; same response shape as today.

503 when unconfigured, 502 on upstream failure. Auth required (editor or viewer).

Fake mode (TRACCAR_FAKE=1, dev/testing only): `/positions` serves an injected in-memory
fleet instead of a real Traccar server, so the Fahrzeuge layer can be exercised without
GPS hardware — see `app.fake_scenario`. Injection is double-gated: the env flag AND the
ALARM_WEBHOOK_SECRET (same secret convention as the alarm intake), both fail-closed.
"""

import secrets
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, Header, HTTPException, Request, status
from pydantic import BaseModel, Field

from ..auth.dependencies import UserOrAdmin
from ..config import settings
from ..traccar import VehiclePosition, VehicleTrail, traccar_client

router = APIRouter(prefix="/traccar", tags=["traccar"])

# Injected fake fleet — in-memory only (a restart clears it; the scenario CLI re-injects).
# Never consulted while the TRACCAR_FAKE flag is off.
_fake_positions: list[VehiclePosition] = []


class FakeVehicleIn(BaseModel):
    """One fake vehicle position. `name` should match a `fleet.vehicles[].id`/label so the
    map and the milestone times tell the same story."""

    name: str = Field(min_length=1, max_length=32)
    lat: float
    lng: float
    status: str = "online"
    speed: float | None = None  # km/h
    course: float | None = None
    address: str | None = None


def _check_fake_access(request: Request, x_webhook_secret: str | None) -> None:
    if not settings.traccar_fake:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Fake-Positionen deaktiviert (TRACCAR_FAKE nicht gesetzt)",
        )
    expected = settings.alarm_webhook_secret
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Fake-Positionen deaktiviert (ALARM_WEBHOOK_SECRET nicht gesetzt)",
        )
    provided = request.query_params.get("secret") or x_webhook_secret
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Ungültiges Webhook-Secret")


@router.post("/fake", status_code=200)
async def set_fake_positions(
    payload: list[FakeVehicleIn],
    request: Request,
    x_webhook_secret: str | None = Header(default=None),
) -> dict:
    """Replace the injected fake fleet (secret via ?secret= or X-Webhook-Secret)."""
    _check_fake_access(request, x_webhook_secret)
    now = datetime.now(UTC)
    _fake_positions[:] = [
        VehiclePosition(
            device_id=i + 1,
            device_name=v.name,
            unique_id=v.name.lower(),
            status=v.status,
            latitude=v.lat,
            longitude=v.lng,
            speed=v.speed,
            course=v.course,
            last_update=now,
            address=v.address,
        )
        for i, v in enumerate(payload)
    ]
    return {"ok": True, "count": len(_fake_positions)}


@router.delete("/fake", status_code=200)
async def clear_fake_positions(
    request: Request,
    x_webhook_secret: str | None = Header(default=None),
) -> dict:
    _check_fake_access(request, x_webhook_secret)
    _fake_positions.clear()
    return {"ok": True, "count": 0}


@router.get("/status")
async def traccar_status(_user: UserOrAdmin) -> dict:
    if settings.traccar_fake:
        return {"configured": True, "host": "fake"}
    # host is the non-secret server name (no scheme/credentials), for status display.
    return {"configured": traccar_client.is_configured, "host": traccar_client.host}


@router.get("/positions", response_model=list[VehiclePosition])
async def positions(_user: UserOrAdmin) -> list[VehiclePosition]:
    if settings.traccar_fake:
        return list(_fake_positions)
    if not traccar_client.is_configured:
        raise HTTPException(status_code=503, detail="Traccar nicht konfiguriert")
    try:
        return await traccar_client.get_vehicle_positions()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Traccar nicht erreichbar: {e}") from e


@router.get("/trails", response_model=list[VehicleTrail])
async def trails(_user: UserOrAdmin, minutes: int = 30) -> list[VehicleTrail]:
    if settings.traccar_fake:
        return []  # fake fleet has no history
    if not traccar_client.is_configured:
        raise HTTPException(status_code=503, detail="Traccar nicht konfiguriert")
    try:
        return await traccar_client.get_trails(minutes=minutes)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Traccar nicht erreichbar: {e}") from e

"""Traccar GPS integration — lifted from kp-rueck (severing the kp-rueck dependency).

Stateless: a fresh session per call. Speed converted knots→km/h. The VehiclePosition
shape is byte-for-byte what the frontend's useVehiclePositions already consumes.
"""

import asyncio
from datetime import datetime
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel

from .config import settings


class TraccarDevice(BaseModel):
    id: int
    name: str
    uniqueId: str
    status: str
    lastUpdate: datetime | None = None
    positionId: int | None = None
    category: str | None = None


class TraccarPosition(BaseModel):
    id: int
    deviceId: int
    latitude: float
    longitude: float
    altitude: float | None = None
    speed: float | None = None  # knots
    course: float | None = None
    accuracy: float | None = None
    deviceTime: datetime
    serverTime: datetime | None = None
    fixTime: datetime | None = None
    address: str | None = None
    attributes: dict | None = None


class VehiclePosition(BaseModel):
    device_id: int
    device_name: str
    unique_id: str
    status: str
    latitude: float
    longitude: float
    speed: float | None = None  # km/h
    course: float | None = None
    last_update: datetime
    address: str | None = None


class VehicleTrail(BaseModel):
    device_id: int
    device_name: str
    points: list[dict]  # [{lat, lng, ts, course, speed}]


class TraccarClient:
    def __init__(self) -> None:
        self.base_url = settings.traccar_url.rstrip("/") if settings.traccar_url else ""
        self.email = settings.traccar_email
        self.password = settings.traccar_password

    @property
    def host(self) -> str | None:
        """The Traccar server hostname (no scheme/credentials) for status display, or None."""
        return urlsplit(self.base_url).hostname if self.base_url else None

    @property
    def is_configured(self) -> bool:
        # SSRF defence-in-depth: the Traccar URL is config-driven (not user input), but pin
        # it to https so a mis-set settings.traccar_url can't be aimed at an internal http
        # endpoint. All requests build off this single base_url, so guarding it here covers
        # every outbound call below.
        if not (self.base_url and self.email and self.password):
            return False
        return urlsplit(self.base_url).scheme == "https"

    async def _session(self, client: httpx.AsyncClient) -> httpx.Cookies:
        r = await client.post(
            f"{self.base_url}/api/session",
            data={"email": self.email, "password": self.password},
            timeout=10.0,
        )
        r.raise_for_status()
        return r.cookies

    async def get_vehicle_positions(self) -> list[VehiclePosition]:
        if not self.is_configured:
            return []
        async with httpx.AsyncClient() as client:
            cookies = await self._session(client)
            dev_r = await client.get(f"{self.base_url}/api/devices", cookies=cookies, timeout=10.0)
            dev_r.raise_for_status()
            devices = {d["id"]: d for d in dev_r.json()}
            pos_r = await client.get(f"{self.base_url}/api/positions", cookies=cookies, timeout=10.0)
            pos_r.raise_for_status()
            result: list[VehiclePosition] = []
            for pos in pos_r.json():
                device = devices.get(pos["deviceId"])
                if not device:
                    continue  # positions with no matching device are dropped
                speed_kmh = pos["speed"] * 1.852 if pos.get("speed") is not None else None
                result.append(
                    VehiclePosition(
                        device_id=pos["deviceId"],
                        device_name=device["name"],
                        unique_id=device["uniqueId"],
                        status=device.get("status", "unknown"),
                        latitude=pos["latitude"],
                        longitude=pos["longitude"],
                        speed=speed_kmh,
                        course=pos.get("course"),
                        last_update=pos["deviceTime"],
                        address=pos.get("address"),
                    )
                )
            return result

    async def get_trails(self, minutes: int = 30) -> list[VehicleTrail]:
        if not self.is_configured:
            return []
        from datetime import UTC, timedelta

        now = datetime.now(UTC)
        frm = now - timedelta(minutes=minutes)
        async with httpx.AsyncClient() as client:
            cookies = await self._session(client)
            dev_r = await client.get(f"{self.base_url}/api/devices", cookies=cookies, timeout=10.0)
            dev_r.raise_for_status()
            devices = dev_r.json()

            # One history request per device — run them concurrently instead of serially so
            # the endpoint's latency is ~one request, not N. Bounded by a semaphore so a large
            # fleet can't open an unbounded number of sockets against Traccar at once.
            sem = asyncio.Semaphore(8)

            async def fetch_one(d: dict) -> VehicleTrail | None:
                async with sem:
                    hr = await client.get(
                        f"{self.base_url}/api/positions",
                        params={"deviceId": d["id"], "from": frm.isoformat(), "to": now.isoformat()},
                        cookies=cookies,
                        timeout=15.0,
                    )
                if hr.status_code != 200:
                    return None
                pts = [
                    {"lat": p["latitude"], "lng": p["longitude"], "ts": p["deviceTime"],
                     "course": p.get("course"), "speed": (p["speed"] * 1.852 if p.get("speed") is not None else None)}
                    for p in hr.json()
                ]
                if not pts:
                    return None
                return VehicleTrail(device_id=d["id"], device_name=d["name"], points=pts)

            results = await asyncio.gather(*(fetch_one(d) for d in devices))
            return [t for t in results if t is not None]


traccar_client = TraccarClient()

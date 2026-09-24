"""Traccar GPS integration — lifted from kp-rueck (severing the kp-rueck dependency).

A fresh Traccar session per call. Speed converted knots→km/h. The VehiclePosition shape is
byte-for-byte what the frontend's useVehiclePositions already consumes.

Two things sit in front of the client (24.09.2026, post-mortem of the Übung on 23.09.2026):

* ``cached_vehicle_positions`` — every open device polls ``/api/traccar/positions`` every 15 s,
  and each poll used to be one Traccar LOGIN plus two reads. One answer now serves every device
  for ``POSITIONS_CACHE_SECONDS``, single-flight.
* ``fleet_positions`` — the ONE source the scheduler's sweep reads: the injected fake fleet when
  ``TRACCAR_FAKE`` is on, else Traccar. The fake fleet used to be served to the map only, so
  nothing the server derives from the feed (the replay track, «vor Ort» / «verlassen») could be
  exercised on dev or demo data.
"""

import asyncio
import time
from datetime import datetime
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel


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
    """Stateless client whose credentials are resolved PER CALL, never at construction.

    ⚠️ They used to be read in ``__init__``, which ran at import — so the module-level
    ``traccar_client`` below froze whatever ``.env`` said at boot and a station could not
    connect its fleet tracking without a restart. Every read now goes through
    ``app.credentials``, which serves ``.env`` first and the admin-set value otherwise; the
    properties are the same three names, so nothing downstream changed.
    """

    @property
    def base_url(self) -> str:
        from .credentials import get as credential

        return credential("traccar_url").rstrip("/")

    @property
    def email(self) -> str:
        from .credentials import get as credential

        return credential("traccar_email")

    @property
    def password(self) -> str:
        from .credentials import get as credential

        return credential("traccar_password")

    @property
    def host(self) -> str | None:
        """The Traccar server hostname (no scheme/credentials) for status display, or None."""
        return urlsplit(self.base_url).hostname if self.base_url else None

    @property
    def is_configured(self) -> bool:
        # SSRF defence-in-depth: the Traccar URL is config-driven (not user input), but pin
        # it to https so a mis-set TRACCAR_URL can't be aimed at an internal http
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
                    {
                        "lat": p["latitude"],
                        "lng": p["longitude"],
                        "ts": p["deviceTime"],
                        "course": p.get("course"),
                        "speed": (p["speed"] * 1.852 if p.get("speed") is not None else None),
                    }
                    for p in hr.json()
                ]
                if not pts:
                    return None
                return VehicleTrail(device_id=d["id"], device_name=d["name"], points=pts)

            results = await asyncio.gather(*(fetch_one(d) for d in devices))
            return [t for t in results if t is not None]


traccar_client = TraccarClient()


#: How long one Traccar answer serves every device. The map polls every 15 s per device; three
#: devices on one login were three Traccar logins every 15 s for the same fleet.
POSITIONS_CACHE_SECONDS = 10.0

# (who asked — base url + account, so a credential change is a miss —, monotonic time, answer
# or the error it raised). An error is cached for the same window: with the lock below, N
# devices polling a dead Traccar would otherwise wait out N timeouts in a row.
_positions_cache: tuple[str, float, list[VehiclePosition] | Exception] | None = None
_positions_lock = asyncio.Lock()


async def cached_vehicle_positions() -> list[VehiclePosition]:
    """``traccar_client.get_vehicle_positions()``, answered at most once per
    ``POSITIONS_CACHE_SECONDS`` for everybody. Single-flight: a request that arrives while the
    fetch is running waits for it and reads its answer."""
    global _positions_cache
    key = f"{traccar_client.base_url}|{traccar_client.email}"
    async with _positions_lock:
        hit = _positions_cache
        if hit is not None and hit[0] == key and time.monotonic() - hit[1] < POSITIONS_CACHE_SECONDS:
            if isinstance(hit[2], Exception):
                raise hit[2]
            return list(hit[2])
        try:
            answer = await traccar_client.get_vehicle_positions()
        except Exception as e:
            _positions_cache = (key, time.monotonic(), e)
            raise
        _positions_cache = (key, time.monotonic(), answer)
        return list(answer)


def reset_positions_cache() -> None:
    """Tests, and nothing else."""
    global _positions_cache
    _positions_cache = None


#: The injected fake fleet (``POST /api/traccar/fake``) — in memory only, a restart clears it and
#: the scenario CLI re-injects. Never consulted while ``TRACCAR_FAKE`` is off.
fake_positions: list[VehiclePosition] = []


def fleet_source() -> str | None:
    """Where the vehicle feed comes from: ``"fake"``, ``"traccar"``, or None (no feed)."""
    from .config import settings

    if settings.traccar_fake:
        return "fake"
    return "traccar" if traccar_client.is_configured else None


async def fleet_positions() -> list[VehiclePosition]:
    """The fleet as the SERVER sees it — the same list the map is served, fake or real.

    Uncached on purpose: the sweep asks every 30 s, and a sweep that read a 10 s old answer
    would stamp nothing wrong but would make its own tests order-dependent for no gain."""
    source = fleet_source()
    if source == "fake":
        return list(fake_positions)
    if source == "traccar":
        return await traccar_client.get_vehicle_positions()
    return []

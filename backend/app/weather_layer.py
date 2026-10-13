"""The Karte's weather layer: its state and its poller – the MeteoSwiss radar every 5 min.

Ported from kp-rueck (R5, feuerwehr-oberwil/kp-rueck#167, 08.10.2026). It sits beside
app/weather (the wind/temperature READING at the Einsatz, which the scheduler also records into
the Verlauf via app/observations); this module records nothing – it is a display cache.

(The official warnings – MeteoAlarm / Alertswiss – that came with the port are gone, 10.10.2026,
owner: «drop the swissalarm thing (like the "feuerverbot") – we don't need it».)

Rules this file keeps, in order of importance:

1. **Nothing waits on it.** It runs on the scheduler, never in a request path; a request only
   reads the last state. A dead feed costs the app nothing but the layer.
2. **Old data is never shown as current.** The radar reports when it last succeeded and when
   its data is from; the app greys it out once it is older than `stale_after_seconds` (two
   missed rounds). Last-known data is KEPT through a failure, labelled with its time, rather
   than replaced by nothing – «Stand 17:05» is more use at 3am than an empty map.
3. **Be a polite client.** A radar frame is fetched once and never again (FSDI's terms forbid
   re-downloading the same content at high frequency).

State lives in this process's memory: the backend runs one uvicorn worker (start.sh), and after
a restart the first round refills it within seconds. ⚠️ So its job runs in EVERY serving process,
not only on the scheduler leader (app/scheduler · start_process_jobs): a standby replica that
answers requests must have frames to answer with, and none of this writes the database.
"""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from . import weather_radar as radar
from .config import settings

logger = logging.getLogger(__name__)

RADAR_INTERVAL_MINUTES = 5
#: One hour of radar at 5-minute steps.
RADAR_FRAMES = 12
#: Frames older than this are dropped even when nothing newer came – past it the loop would be
#: weather history, not the current situation.
RADAR_MAX_AGE = timedelta(hours=3)
#: A missing 5-minute file is retried on every round until it is this old, then given up on
#: (MeteoSwiss occasionally skips a slot; it never back-fills one hours later).
RADAR_GIVE_UP_AFTER = timedelta(minutes=20)
#: Two missed frames. The newest frame is normally 2–7 min old (5-min cadence + ~1 min
#: publication + our poll offset), so 15 min means at least two rounds brought nothing.
RADAR_STALE_AFTER = timedelta(minutes=15)

USER_AGENT = "KP-Front weather layer (+https://github.com/feuerwehr-oberwil/kp-front)"


@dataclass
class SourceStatus:
    """What the app needs to know to trust (or grey out) a source."""

    last_attempt_at: datetime | None = None
    last_success_at: datetime | None = None
    last_error: str | None = None
    last_error_at: datetime | None = None

    def ok(self, now: datetime) -> bool:
        """Record a success. True when this ends a failure streak (worth one log line)."""
        recovered = self.last_error is not None
        self.last_attempt_at = now
        self.last_success_at = now
        self.last_error = None
        return recovered

    def failed(self, now: datetime, error: str) -> bool:
        """Record a failure. True when it starts a streak – a feed down for a day must not
        write 288 warnings; the first one and the recovery are what an operator needs."""
        first = self.last_error is None
        self.last_attempt_at = now
        self.last_error = error
        self.last_error_at = now
        return first

    def as_dict(self) -> dict[str, Any]:
        return {
            "last_attempt_at": _iso(self.last_attempt_at),
            "last_success_at": _iso(self.last_success_at),
            "last_error": self.last_error,
            "last_error_at": _iso(self.last_error_at),
        }


@dataclass
class WeatherState:
    frames: OrderedDict[str, radar.RenderedFrame] = field(default_factory=OrderedDict)
    radar_status: SourceStatus = field(default_factory=SourceStatus)
    radar_given_up: set[str] = field(default_factory=set)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _short_error(exc: BaseException) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code}"
    if isinstance(exc, httpx.TimeoutException):
        return "Zeitüberschreitung"
    if isinstance(exc, httpx.TransportError):
        return "nicht erreichbar"
    return type(exc).__name__


def _decode_and_render(data: bytes) -> radar.RenderedFrame:
    return radar.render_frame(radar.parse_rzc(data))


def _log_failure(first: bool, what: str, exc: BaseException) -> None:
    if first:
        logger.warning("Weather %s poll failed: %s (logged once until it recovers)", what, _short_error(exc))
    else:
        logger.debug("Weather %s poll still failing: %s", what, _short_error(exc))


class WeatherService:
    def __init__(self) -> None:
        self.state = WeatherState()
        self._radar_lock = asyncio.Lock()

    def reset(self) -> None:
        self.state = WeatherState()

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=20.0, headers={"User-Agent": USER_AGENT}, follow_redirects=False)

    # --- Radar ------------------------------------------------------------------------------

    async def poll_radar(self, client: httpx.AsyncClient | None = None, now: datetime | None = None) -> None:
        """Fetch every 5-minute frame of the last hour that we do not have yet. Never raises."""
        async with self._radar_lock:
            now = now or datetime.now(UTC)
            own_client = client is None
            client = client or self._client()
            try:
                await self._poll_radar(client, now)
                if self.state.radar_status.ok(now):
                    logger.info("Weather radar recovered")
            except Exception as exc:  # noqa: BLE001 — a dead feed must never reach the scheduler (rule 1)
                _log_failure(self.state.radar_status.failed(now, _short_error(exc)), "radar", exc)
            finally:
                self._prune_frames(now)
                if own_client:
                    await client.aclose()

    async def _poll_radar(self, client: httpx.AsyncClient, now: datetime) -> None:
        latest = radar.floor_to_slot(now)
        slots = [latest - radar.FRAME_INTERVAL * i for i in range(RADAR_FRAMES)]
        for slot in slots:  # newest first: the current frame matters most if the round is cut short
            key = radar.frame_key(slot)
            if key in self.state.frames or key in self.state.radar_given_up:
                continue
            response = await client.get(radar.frame_url(slot))
            if response.status_code in (403, 404):
                # Not published yet (the newest slot, for a minute or so) – or skipped for good.
                if now - slot > RADAR_GIVE_UP_AFTER:
                    self.state.radar_given_up.add(key)
                continue
            response.raise_for_status()
            # Decoding and rendering are CPU work: off the event loop, so the app's requests and
            # sockets never wait on a radar frame.
            frame = await asyncio.to_thread(_decode_and_render, response.content)
            self.state.frames[frame.key] = frame
        self.state.frames = OrderedDict(sorted(self.state.frames.items()))
        if not self.state.frames:
            raise RuntimeError("no radar frame in the last hour")

    def _prune_frames(self, now: datetime) -> None:
        keep = [(k, f) for k, f in self.state.frames.items() if now - f.time <= RADAR_MAX_AGE]
        self.state.frames = OrderedDict(keep[-RADAR_FRAMES:])
        cutoff = radar.frame_key(now - RADAR_MAX_AGE)
        self.state.radar_given_up = {k for k in self.state.radar_given_up if k >= cutoff}

    def frame_png(self, key: str) -> bytes | None:
        frame = self.state.frames.get(key)
        return frame.png if frame else None

    # --- What the app reads -----------------------------------------------------------------

    def snapshot(self, now: datetime | None = None) -> dict[str, Any]:
        """The radar as last polled. No point: it is the same picture for every Einsatz."""
        now = now or datetime.now(UTC)
        state = self.state
        # Sorted here, not trusted from insertion order: a running poll adds frames newest-first.
        frames = sorted(state.frames.values(), key=lambda f: f.time)
        newest = frames[-1].time if frames else None
        return {
            "enabled": True,
            "generated_at": now.isoformat(),
            "radar": {
                "frames": [{"key": f.key, "time": f.time.isoformat()} for f in frames],
                "coordinates": [list(c) for c in frames[-1].coordinates] if frames else None,
                "data_time": _iso(newest),
                "stale": newest is None or now - newest > RADAR_STALE_AFTER,
                "stale_after_seconds": int(RADAR_STALE_AFTER.total_seconds()),
                "status": state.radar_status.as_dict(),
                "legend": radar.legend(),
                "attribution": "MeteoSchweiz",
                "source_url": "https://www.meteoschweiz.admin.ch",
            },
        }


weather_service = WeatherService()


def weather_layer_enabled() -> bool:
    return settings.weather_layer_enabled

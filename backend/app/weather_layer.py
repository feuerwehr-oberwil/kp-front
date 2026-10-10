"""The Karte's weather layer: its state and its pollers – radar every 5 min, warnings every 10 min.

Ported from kp-rueck (R5, feuerwehr-oberwil/kp-rueck#167, 08.10.2026). It sits beside
app/weather (the wind/temperature READING at the Einsatz, which the scheduler also records into
the Verlauf via app/observations); this module records nothing – it is a display cache.

Rules this file keeps, in order of importance:

1. **Nothing waits on it.** It runs on the scheduler, never in a request path; a request only
   reads the last state. A dead feed costs the app nothing but the layer.
2. **Each source fails on its own.** Radar, MeteoSwiss warnings and Alertswiss are three
   independent try-blocks with three independent status records. One being down never empties
   another.
3. **Old data is never shown as current.** Every source reports when it last succeeded and when
   its data is from; the app greys a source out once it is older than `stale_after_seconds`
   (two missed rounds). Last-known data is KEPT through a failure, labelled with its time,
   rather than replaced by nothing – «Stand 17:05» is more use at 3am than an empty map.
4. **Be a polite client.** A radar frame is fetched once and never again (FSDI's terms forbid
   re-downloading the same content at high frequency); the 2 MB MeteoAlarm feed is only fetched
   when its small Atom sibling changed.

State lives in this process's memory: the backend runs one uvicorn worker (start.sh), and after
a restart the first round refills it within seconds. ⚠️ So its jobs run in EVERY serving process,
not only on the scheduler leader (app/scheduler · start_process_jobs): a standby replica that
answers requests must have frames to answer with, and none of this writes the database.

KP Front difference: the warnings are not filtered for a station at poll time. The national
candidates are kept, and `snapshot(lat, lng)` selects for the Einsatz the device is looking at.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import numpy as np

from . import weather_radar as radar
from . import weather_warnings as warnings
from .config import settings
from .weather_radar import wgs84_to_lv95

logger = logging.getLogger(__name__)

RADAR_INTERVAL_MINUTES = 5
WARNINGS_INTERVAL_MINUTES = 10
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
#: Two missed warning rounds, plus slack for the round itself.
WARNINGS_STALE_AFTER = timedelta(minutes=25)
#: Re-fetch the full MeteoAlarm JSON at least this often even if the Atom feed looks unchanged.
METEOALARM_FULL_REFRESH = timedelta(hours=1)

METEOALARM_JSON = "https://feeds.meteoalarm.org/api/v1/warnings/feeds-switzerland"
METEOALARM_ATOM = "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-switzerland"
ALERTSWISS_JSON = "https://www.alert.swiss/content/alertswiss-internet/{lang}/home/_jcr_content/polyalert.alertswiss_alerts.actual.json"
ALERTSWISS_LANGUAGES = ("de", "fr")

#: Switzerland's LV95 extent, generously. Decides whether a nation-wide Alertswiss alert applies.
CH_LV95_BOUNDS = (2480000.0, 1070000.0, 2840000.0, 1300000.0)

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
    #: per source: the last normalised national candidates, unfiltered (selected per request)
    candidates: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    #: bumped whenever `candidates` changes – the key of the per-point selection cache
    generation: int = 0
    warning_status: dict[str, SourceStatus] = field(
        default_factory=lambda: {"meteoswiss": SourceStatus(), "alertswiss": SourceStatus()}
    )
    meteoalarm_atom_hash: str | None = None
    meteoalarm_full_at: datetime | None = None


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


def in_switzerland(lat: float, lon: float) -> bool:
    east, north = wgs84_to_lv95(np.array([lat]), np.array([lon]))
    west, south, east_max, north_max = CH_LV95_BOUNDS
    return west <= float(east[0]) <= east_max and south <= float(north[0]) <= north_max


def _decode_and_render(data: bytes) -> radar.RenderedFrame:
    return radar.render_frame(radar.parse_rzc(data))


def _meteoalarm_from_bytes(data: bytes) -> list[dict[str, Any]]:
    return warnings.meteoalarm_candidates(json.loads(data))


def _log_failure(first: bool, what: str, exc: BaseException) -> None:
    if first:
        logger.warning("Weather %s poll failed: %s (logged once until it recovers)", what, _short_error(exc))
    else:
        logger.debug("Weather %s poll still failing: %s", what, _short_error(exc))


class WeatherService:
    def __init__(self) -> None:
        self.state = WeatherState()
        self._radar_lock = asyncio.Lock()
        self._warnings_lock = asyncio.Lock()
        #: (source, rounded lat, rounded lng) → the selection, for the current `generation`.
        #: Every device on one Einsatz asks for the same point once a minute; the polygons only
        #: change every 10 min at most.
        self._selections: dict[tuple[str, float, float], list[dict[str, Any]]] = {}

    def reset(self) -> None:
        self.state = WeatherState()
        self._selections.clear()

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
            except Exception as exc:  # noqa: BLE001 — a dead feed must never reach the scheduler (rule 2)
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
            # Decoding and rendering are CPU work (~1 s a frame): off the event loop, so the app's
            # requests and sockets never wait on a radar frame.
            frame = await asyncio.to_thread(_decode_and_render, response.content)
            self.state.frames[radar.frame_key(frame.time)] = frame
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

    # --- Warnings ---------------------------------------------------------------------------

    async def poll_warnings(self, client: httpx.AsyncClient | None = None, now: datetime | None = None) -> None:
        """Refresh both warning sources, each on its own. Never raises."""
        async with self._warnings_lock:
            now = now or datetime.now(UTC)
            own_client = client is None
            client = client or self._client()
            try:
                await asyncio.gather(
                    self._poll_source("meteoswiss", self._fetch_meteoalarm, client, now),
                    self._poll_source("alertswiss", self._fetch_alertswiss, client, now),
                )
            finally:
                if own_client:
                    await client.aclose()

    async def _poll_source(self, name: str, fetch: Any, client: httpx.AsyncClient, now: datetime) -> None:
        status = self.state.warning_status[name]
        try:
            candidates = await fetch(client, now)
            if candidates is not None:
                self.state.candidates[name] = candidates
                self.state.generation += 1
                self._selections.clear()
            if status.ok(now):
                logger.info("Weather warnings (%s) recovered", name)
        except Exception as exc:  # noqa: BLE001 — each source fails on its own (rule 2)
            _log_failure(status.failed(now, _short_error(exc)), f"warnings ({name})", exc)

    async def _fetch_meteoalarm(self, client: httpx.AsyncClient, now: datetime) -> list[dict[str, Any]] | None:
        """The 2 MB JSON only when the 300 KB Atom feed changed (neither sends an ETag)."""
        atom_hash: str | None = None
        try:
            atom = await client.get(METEOALARM_ATOM)
            atom.raise_for_status()
            atom_hash = hashlib.sha256(atom.content).hexdigest()
        except Exception as exc:  # noqa: BLE001 — the Atom gate is an optimisation; any failure means «fetch the JSON»
            logger.info("MeteoAlarm Atom check failed (%s), fetching the full feed", _short_error(exc))
        fresh_enough = (
            self.state.meteoalarm_full_at is not None and now - self.state.meteoalarm_full_at < METEOALARM_FULL_REFRESH
        )
        if atom_hash is not None and atom_hash == self.state.meteoalarm_atom_hash and fresh_enough:
            return None  # unchanged: keep the candidates we have
        response = await client.get(METEOALARM_JSON)
        response.raise_for_status()
        # 2 MB of JSON and 57 polygons: parsed in a thread, not on the event loop.
        candidates = await asyncio.to_thread(_meteoalarm_from_bytes, response.content)
        self.state.meteoalarm_atom_hash = atom_hash
        self.state.meteoalarm_full_at = now
        return candidates

    async def _fetch_alertswiss(self, client: httpx.AsyncClient, now: datetime) -> list[dict[str, Any]]:
        payloads: dict[str, dict[str, Any]] = {}
        for lang in ALERTSWISS_LANGUAGES:
            response = await client.get(ALERTSWISS_JSON.format(lang=lang))
            response.raise_for_status()
            body = await asyncio.to_thread(json.loads, response.content)
            if not isinstance(body, dict) or not isinstance(body.get("alerts"), list):
                raise ValueError("unexpected Alertswiss payload")
            payloads[lang] = body
        return await asyncio.to_thread(warnings.alertswiss_candidates, payloads)

    # --- What the app reads -----------------------------------------------------------------

    def _select(self, name: str, lat: float, lng: float, now: datetime) -> list[dict[str, Any]]:
        """The source's warnings covering the point. Cached per ~10 m cell until the candidates
        change; `snapshot` drops what expired since, so a cached selection never outlives one."""
        key = (name, round(lat, 4), round(lng, 4))
        hit = self._selections.get(key)
        if hit is None:
            hit = warnings.select(self.state.candidates.get(name, []), lat, lng, now, in_switzerland(lat, lng))
            if len(self._selections) > 256:  # a handful of Einsätze at a time; never unbounded
                self._selections.clear()
            self._selections[key] = hit
        return hit

    def snapshot(self, lat: float | None, lng: float | None, now: datetime | None = None) -> dict[str, Any]:
        """Radar + the warnings at (lat, lng) – the Einsatz the asking device is looking at.
        No point (an Einsatz without a coordinate) → no warnings, the radar still comes."""
        now = now or datetime.now(UTC)
        state = self.state
        # Sorted here, not trusted from insertion order: a running poll adds frames newest-first.
        frames = sorted(state.frames.values(), key=lambda f: f.time)
        newest = frames[-1].time if frames else None
        radar_data = {
            "frames": [{"key": f.key, "time": f.time.isoformat()} for f in frames],
            "coordinates": [list(c) for c in frames[-1].coordinates] if frames else None,
            "data_time": _iso(newest),
            "stale": newest is None or now - newest > RADAR_STALE_AFTER,
            "stale_after_seconds": int(RADAR_STALE_AFTER.total_seconds()),
            "status": state.radar_status.as_dict(),
            "legend": radar.legend(),
            "attribution": "MeteoSchweiz",
            "source_url": "https://www.meteoschweiz.admin.ch",
        }
        sources = {}
        items: list[dict[str, Any]] = []
        for name, status in state.warning_status.items():
            success = status.last_success_at
            sources[name] = {
                **status.as_dict(),
                "stale": success is None or now - success > WARNINGS_STALE_AFTER,
            }
            selected = self._select(name, lat, lng, now) if lat is not None and lng is not None else []
            for item in selected:
                expires = item.get("expires")
                if expires and datetime.fromisoformat(expires) <= now:
                    continue  # expired since the last round: gone, not «stale»
                items.append({**item, "fetched_at": _iso(success)})
        items.sort(key=lambda w: (-int(w["level"]), w.get("onset") or w.get("sent") or ""))
        return {
            "enabled": True,
            "point": lat is not None and lng is not None,
            "generated_at": now.isoformat(),
            "radar": radar_data,
            "warnings": {
                "items": items,
                "sources": sources,
                "stale_after_seconds": int(WARNINGS_STALE_AFTER.total_seconds()),
            },
        }


weather_service = WeatherService()


def weather_layer_enabled() -> bool:
    return settings.weather_layer_enabled

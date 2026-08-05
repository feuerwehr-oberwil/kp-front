"""Availability-safe per-IP throttles for the login-less surfaces (NOT lockouts).

The Erfassungs-Poster token is long-lived and travels in the URL, so `/api/capture/*`
needs a brake against scripted abuse. But the overriding requirement is the operator:
someone ticking off attendance FAST fires bursts of ~2–3 requests/second (every stepper
tap is a save) and must NEVER be throttled. Token bucket per client IP, sized far above
any human pace (see the sizing comment in config.py) — only sustained scripted traffic
trips it, and it recovers by itself. In-memory per process, like the PIN limiter.

The same bucket serves `/api/incidents/{id}/positions`, which an Einsatz-Link session may
write to. Its own sizing lives in `settings.position_rate_*`: that surface has a *known*
cadence (one POST per ~20 s per phone) rather than a human tapping as fast as they can, so
it can sit far tighter without ever coming near a real responder.
"""

import time
from collections.abc import Callable

from ..config import settings


class CaptureLimiter:
    """Per-IP token bucket. `sizing` is read on every call, not captured at construction,
    so a settings override in a test (or at boot) takes effect without rebuilding the
    limiter — which is how the existing capture tests drive it."""

    def __init__(self, sizing: Callable[[], tuple[float, float]] | None = None) -> None:
        # ip -> (tokens_remaining, last_seen_monotonic)
        self._state: dict[str, tuple[float, float]] = {}
        self._sizing = sizing or (lambda: (float(settings.capture_rate_burst), settings.capture_rate_per_minute / 60.0))

    def check(self, ip: str) -> int:
        """Consume one token; return 0 if allowed, else whole seconds until the next one."""
        burst, rate = self._sizing()
        now = time.monotonic()
        tokens, last = self._state.get(ip, (burst, now))
        tokens = min(burst, tokens + (now - last) * rate)
        if tokens < 1.0:
            self._state[ip] = (tokens, now)
            return max(1, int((1.0 - tokens) / rate + 0.999))
        self._state[ip] = (tokens - 1.0, now)
        if len(self._state) > 10_000:
            self._prune(now, burst, rate)
        return 0

    def _prune(self, now: float, burst: float, rate: float) -> None:
        """Drop buckets that have refilled to full — inert entries from one-off IPs."""
        full = [ip for ip, (tokens, last) in self._state.items() if tokens + (now - last) * rate >= burst]
        for ip in full:
            del self._state[ip]

    def reset(self) -> None:
        self._state.clear()


capture_limiter = CaptureLimiter()

#: Separate bucket (and separate sizing) for the live-position surface — a burst of capture
#: saves must not eat the allowance a responder's phone needs to keep reporting where it is.
position_limiter = CaptureLimiter(
    lambda: (float(settings.position_rate_burst), settings.position_rate_per_minute / 60.0)
)

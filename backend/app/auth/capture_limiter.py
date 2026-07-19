"""Availability-safe per-IP throttle for the public capture surface (NOT a lockout).

The Erfassungs-Poster token is long-lived and travels in the URL, so `/api/capture/*`
needs a brake against scripted abuse. But the overriding requirement is the operator:
someone ticking off attendance FAST fires bursts of ~2–3 requests/second (every stepper
tap is a save) and must NEVER be throttled. Token bucket per client IP, sized far above
any human pace (see the sizing comment in config.py) — only sustained scripted traffic
trips it, and it recovers by itself. In-memory per process, like the PIN limiter.
"""

import time

from ..config import settings


class CaptureLimiter:
    def __init__(self) -> None:
        # ip -> (tokens_remaining, last_seen_monotonic)
        self._state: dict[str, tuple[float, float]] = {}

    def check(self, ip: str) -> int:
        """Consume one token; return 0 if allowed, else whole seconds until the next one."""
        burst = float(settings.capture_rate_burst)
        rate = settings.capture_rate_per_minute / 60.0
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

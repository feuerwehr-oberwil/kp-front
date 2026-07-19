"""Availability-safe per-user PIN cooldown (NOT a hard lockout).

PLAN §5: a few free attempts, then a growing cooldown (5s→10s→30s→…, capped). Never
permanent — we must never lock out the Einsatzleiter mid-incident. In-memory per user.
"""

import time

from ..config import settings


class PinLimiter:
    def __init__(self) -> None:
        # user_id -> (consecutive_failures, blocked_until_epoch)
        self._state: dict[str, tuple[int, float]] = {}

    def retry_after(self, user_id: str) -> int:
        """Seconds the caller must wait, or 0 if allowed to try now."""
        fails, until = self._state.get(user_id, (0, 0.0))
        remaining = until - time.monotonic()
        return max(0, int(remaining + 0.999)) if remaining > 0 else 0

    def record_failure(self, user_id: str) -> int:
        """Register a wrong PIN; return the new cooldown in seconds (0 while in free tier)."""
        fails, _ = self._state.get(user_id, (0, 0.0))
        fails += 1
        over = fails - settings.pin_free_attempts
        if over <= 0:
            self._state[user_id] = (fails, 0.0)
            return 0
        steps = settings.pin_cooldown_steps_seconds
        cooldown = steps[min(over - 1, len(steps) - 1)]
        self._state[user_id] = (fails, time.monotonic() + cooldown)
        return cooldown

    def record_success(self, user_id: str) -> None:
        self._state.pop(user_id, None)


pin_limiter = PinLimiter()

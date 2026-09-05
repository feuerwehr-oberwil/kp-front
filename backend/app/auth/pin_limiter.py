"""Availability-safe PIN cooldown (NOT a hard lockout).

PLAN §5: a few free attempts, then a growing cooldown (5s→10s→30s→…, capped). Never
permanent — we must never lock out the Einsatzleiter mid-incident.

Two properties the first version lacked (security audit SEC-08):

* **Admission is reserved, not checked.** `reserve` counts the attempt in the same synchronous
  step that decides whether to admit it. The route used to *check* the cooldown, then await a
  database round trip and a bcrypt verification, and only then record the failure — so 24
  simultaneous wrong PINs all passed a check that nobody had yet failed and all reached bcrypt.
  Nothing may be awaited between deciding and counting.
* **Buckets are bounded and they expire.** The key includes the request's source address and
  the *claimed* user id, both attacker-suppliable, so the map has to prune: a bucket untouched
  for `BUCKET_TTL_SECONDS` is forgotten (which is also how a legitimate operator's own slips
  decay), and the map never exceeds `MAX_BUCKETS`.

Deliberately still process-local. Multiple workers each keep their own view, so a distributed
attacker gets one ladder per worker; the account-recovery properties below matter more here
than exactness, and a shared store (Redis) is not something this deployment has. Documented
rather than pretended away.

Keying is per (account, source), not per account. A cooldown shared by every caller of one
account is a remote lockout switch: hostile traffic aimed at the Einsatzleiter's tile would
keep the Einsatzleiter out. Their own tablet has its own bucket and is never blocked by
somebody else's failures; a correct PIN clears that bucket immediately.
"""

import time

from ..config import settings

#: A bucket untouched for this long is forgotten — the pruning rule and the decay rule at once.
#: Comfortably longer than the deepest cooldown step, short enough that a mistyped-PIN ladder
#: does not follow an operator into the next hour.
BUCKET_TTL_SECONDS = 15 * 60

#: Hard ceiling on tracked buckets. Keys are attacker-suppliable, so the map must not grow
#: with the traffic; over the ceiling the least useful buckets (expired cooldowns first, then
#: least recently seen) are evicted.
MAX_BUCKETS = 10_000

#: Sweeping every write would be quadratic on a flood; sweeping only at the ceiling would let a
#: quiet deployment hold a day's worth of dead buckets. Both, then, at this cadence.
PRUNE_INTERVAL_SECONDS = 60


class PinLimiter:
    def __init__(self) -> None:
        # key -> (consecutive_failures, blocked_until_monotonic, last_seen_monotonic)
        self._state: dict[str, tuple[int, float, float]] = {}
        self._last_prune = 0.0

    @staticmethod
    def key(user_id: str, source: str) -> str:
        """The bucket a login attempt counts against: this account, from this source."""
        return f"{user_id}|{source}"

    def _bucket(self, key: str, now: float) -> tuple[int, float]:
        """(failures, blocked_until) for a key, treating an expired bucket as absent."""
        fails, until, seen = self._state.get(key, (0, 0.0, now))
        if now - seen > BUCKET_TTL_SECONDS:
            return 0, 0.0
        return fails, until

    def _wait(self, until: float, now: float) -> int:
        remaining = until - now
        return max(1, int(remaining + 0.999)) if remaining > 0 else 0

    def retry_after(self, key: str) -> int:
        """Seconds the caller must wait, or 0 if allowed to try now."""
        now = time.monotonic()
        _fails, until = self._bucket(key, now)
        return self._wait(until, now)

    def reserve(self, key: str) -> int:
        """Take one attempt slot: 0 = go ahead (and the attempt is already counted against
        the ladder), >0 = seconds to wait. Counting up front is what makes a concurrent burst
        cost the attacker its attempts; `record_success` gives the slot back to a caller who
        turned out to know the PIN."""
        now = time.monotonic()
        _fails, until = self._bucket(key, now)
        wait = self._wait(until, now)
        if wait:
            return wait
        self._register_failure(key, now)
        return 0

    def record_failure(self, key: str) -> int:
        """Register a wrong PIN; return the new cooldown in seconds (0 while in free tier)."""
        return self._register_failure(key, time.monotonic())

    def record_success(self, key: str) -> None:
        self._state.pop(key, None)

    def reset(self) -> None:
        self._state.clear()
        self._last_prune = 0.0

    def bucket_count(self) -> int:
        return len(self._state)

    # --- internals -------------------------------------------------------------------

    def _register_failure(self, key: str, now: float) -> int:
        fails, _until = self._bucket(key, now)
        fails += 1
        over = fails - settings.pin_free_attempts
        if over <= 0:
            self._state[key] = (fails, 0.0, now)
            cooldown = 0
        else:
            steps = settings.pin_cooldown_steps_seconds
            cooldown = steps[min(over - 1, len(steps) - 1)]
            self._state[key] = (fails, now + cooldown, now)
        if len(self._state) > MAX_BUCKETS or now - self._last_prune > PRUNE_INTERVAL_SECONDS:
            self._prune(now)
            self._last_prune = now
        return cooldown

    def _prune(self, now: float) -> None:
        for stale in [k for k, (_f, _u, seen) in self._state.items() if now - seen > BUCKET_TTL_SECONDS]:
            del self._state[stale]
        if len(self._state) <= MAX_BUCKETS:
            return
        # Still over the ceiling: evict by (cooldown already expired, longest unseen) so a
        # flood of invented keys sheds itself before a live cooldown does.
        ordered = sorted(self._state.items(), key=lambda item: (item[1][1], item[1][2]))
        for key, _bucket in ordered[: len(self._state) - MAX_BUCKETS]:
            del self._state[key]


pin_limiter = PinLimiter()

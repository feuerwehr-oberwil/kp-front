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


# --- per-account aggregate slowdown (M1a) -----------------------------------------

#: Failures per account, across ALL sources, within one window before the slowdown engages.
#: Deliberately far above anything a legitimate crew produces — every operator on station
#: burning their full free tier at once is still well under it — while a source-rotating
#: attacker at the bcrypt ceiling (~13 verifies/s) crosses it in under ten seconds.
AGGREGATE_THRESHOLD = 100

#: Tumbling window the failures are counted in. An hour: long enough that an attacker cannot
#: simply wait it out between bursts, short enough that yesterday's attack does not slow
#: today's alarm.
AGGREGATE_WINDOW_SECONDS = 60 * 60

#: The slowdown ladder: base delay once engaged, one step deeper per further THRESHOLD
#: failures, hard-capped. Small on purpose — the legit operator behind it waits a breath,
#: never a lockout — while an attacker's per-attempt cost roughly triples over bcrypt alone
#: and each attempt now holds a connection open for seconds.
AGGREGATE_BASE_DELAY_SECONDS = 1.5
AGGREGATE_DELAY_STEP_SECONDS = 0.5
AGGREGATE_MAX_DELAY_SECONDS = 3.0

#: Ceiling on tracked accounts. The key is the CLAIMED user id (attacker-suppliable), so the
#: map must stay bounded like the cooldown limiter's above.
MAX_AGGREGATE_ACCOUNTS = 10_000


class LoginAggregate:
    """Failure tally per ACCOUNT across all sources — the answer to source rotation.

    The per-(account, source) cooldown above is availability-first by design: a rotating
    attacker gets a fresh bucket per address, so their real ceiling is only the bcrypt
    CapacityLimiter. This tally closes that hole without giving up the availability property:
    above `AGGREGATE_THRESHOLD` failures/window every verify for the account is DELAYED a
    couple of seconds (`delay`), never refused — there is no path from here to a 4xx. The
    delay multiplies what an attacker must spend (time, and connections held open) per
    attempt; the operator caught behind it waits a breath and gets in.

    Success handling — the trade-off, deliberately: `record_success` clears the account's
    tally outright. Only a caller who KNOWS the PIN can trigger it, so a guessing attacker
    cannot reach it on purpose; the residual cost is that during an active attack each real
    crew login re-opens one threshold's worth of undelayed attempts — seconds of guessing at
    the bcrypt ceiling, negligible against the PIN space — accepted so an operator is never
    left dragging an hour of somebody else's failures after proving who they are.

    Process-local and approximate, like the cooldown limiter (its docstring says why that is
    documented rather than pretended away). Counting happens on the failed verify rather than
    being reserved up front — a concurrent burst can undercount by its own width once, which
    shaves a delay step, never bypasses admission (there is no admission here to bypass).
    """

    def __init__(self) -> None:
        # account id -> (window_start_monotonic, failures_in_window)
        self._state: dict[str, tuple[float, int]] = {}

    def _count(self, account: str, now: float) -> int:
        start, fails = self._state.get(account, (now, 0))
        if now - start > AGGREGATE_WINDOW_SECONDS:
            return 0
        return fails

    def failures(self, account: str) -> int:
        """Failures counted against this account in the current window."""
        return self._count(account, time.monotonic())

    def delay(self, account: str) -> float:
        """Seconds to sleep before verifying for this account — 0.0 below the threshold."""
        fails = self.failures(account)
        if fails < AGGREGATE_THRESHOLD:
            return 0.0
        steps = (fails - AGGREGATE_THRESHOLD) // AGGREGATE_THRESHOLD
        return min(
            AGGREGATE_BASE_DELAY_SECONDS + AGGREGATE_DELAY_STEP_SECONDS * steps,
            AGGREGATE_MAX_DELAY_SECONDS,
        )

    def record_failure(self, account: str) -> int:
        """Count one failed verify; return the account's new window total."""
        now = time.monotonic()
        fails = self._count(account, now) + 1
        start = self._state.get(account, (now, 0))[0] if fails > 1 else now
        self._state[account] = (start, fails)
        if len(self._state) > MAX_AGGREGATE_ACCOUNTS:
            self._prune(now)
        return fails

    def record_success(self, account: str) -> None:
        # See the class docstring for why a success clears the whole tally.
        self._state.pop(account, None)

    def reset(self) -> None:
        self._state.clear()

    def account_count(self) -> int:
        return len(self._state)

    def _prune(self, now: float) -> None:
        for stale in [a for a, (start, _f) in self._state.items() if now - start > AGGREGATE_WINDOW_SECONDS]:
            del self._state[stale]
        if len(self._state) <= MAX_AGGREGATE_ACCOUNTS:
            return
        # Still over the ceiling: shed the LOWEST tallies first. Evicting a hot account would
        # re-grant it a fresh undelayed window — exactly the capacity eviction must not hand
        # back — while a one-failure account loses nothing that matters. Shed to a margin
        # below the ceiling so a flood of invented ids pays for one sort per ~thousand
        # inserts, not per insert.
        target = MAX_AGGREGATE_ACCOUNTS * 9 // 10
        ordered = sorted(self._state.items(), key=lambda item: item[1][1])
        for account, _entry in ordered[: len(self._state) - target]:
            del self._state[account]


login_aggregate = LoginAggregate()

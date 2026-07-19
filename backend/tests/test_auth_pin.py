"""Unit tests for PIN hashing/verification and the availability-safe cooldown limiter.

Pure functions + in-memory limiter — no DB, no live server. Run with `uv run pytest`.
"""

import pytest

from app.auth.pin_limiter import PinLimiter
from app.auth.security import hash_pin, verify_pin
from app.config import settings

# --- hash_pin / verify_pin --------------------------------------------------------


def test_hash_pin_roundtrip():
    pin = "1" * settings.pin_length
    h = hash_pin(pin)
    assert h != pin  # not stored in clear
    assert h.startswith("$2")  # bcrypt hash marker
    assert verify_pin(pin, h) is True


def test_verify_pin_rejects_wrong_pin():
    pin = "123456"[: settings.pin_length].ljust(settings.pin_length, "0")
    other = "654321"[: settings.pin_length].ljust(settings.pin_length, "0")
    h = hash_pin(pin)
    assert verify_pin(other, h) is False


def test_hash_pin_is_salted_unique():
    """Two hashes of the same PIN differ (random bcrypt salt) but both verify."""
    pin = "0" * settings.pin_length
    h1, h2 = hash_pin(pin), hash_pin(pin)
    assert h1 != h2
    assert verify_pin(pin, h1)
    assert verify_pin(pin, h2)


@pytest.mark.parametrize("bad", ["", "12345", "1234567", "12a456", "abcdef"])
def test_hash_pin_rejects_malformed(bad):
    # Skip any input that happens to be a valid length of digits for this config.
    if len(bad) == settings.pin_length and bad.isdigit():
        pytest.skip("valid for this pin_length")
    with pytest.raises(ValueError):
        hash_pin(bad)


def test_verify_pin_tolerates_garbage_hash():
    """A corrupt/non-bcrypt stored hash must return False, never raise."""
    assert verify_pin("0" * settings.pin_length, "not-a-bcrypt-hash") is False


# --- PinLimiter cooldown ----------------------------------------------------------


def test_limiter_free_tier_then_growing_cooldown():
    lim = PinLimiter()
    uid = "user-1"

    # Free attempts incur no cooldown.
    for _ in range(settings.pin_free_attempts):
        assert lim.record_failure(uid) == 0
    assert lim.retry_after(uid) == 0

    # First over-limit failure starts the cooldown ladder.
    steps = settings.pin_cooldown_steps_seconds
    first = lim.record_failure(uid)
    assert first == steps[0]
    assert lim.retry_after(uid) > 0  # now blocked

    # Cooldown grows along the ladder and is capped at the last step.
    second = lim.record_failure(uid)
    assert second == steps[min(1, len(steps) - 1)]
    for _ in range(len(steps) + 3):
        capped = lim.record_failure(uid)
    assert capped == steps[-1]


def test_limiter_success_clears_state():
    lim = PinLimiter()
    uid = "user-2"
    for _ in range(settings.pin_free_attempts + 2):
        lim.record_failure(uid)
    assert lim.retry_after(uid) > 0
    lim.record_success(uid)
    assert lim.retry_after(uid) == 0
    # Back to free tier after a success.
    assert lim.record_failure(uid) == 0


def test_limiter_is_per_user():
    lim = PinLimiter()
    for _ in range(settings.pin_free_attempts + 1):
        lim.record_failure("a")
    assert lim.retry_after("a") > 0
    assert lim.retry_after("b") == 0  # unrelated user unaffected

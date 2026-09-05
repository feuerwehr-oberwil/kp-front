"""SEC-08: the PIN throttle under concurrency, hostile bursts, and forged forwarded headers.

The limiter is deliberately process-local (see app/auth/pin_limiter.py) — what is tested here
is that it *admits* the right number of attempts, that its buckets cannot grow without bound,
and that hostile traffic aimed at an account cannot take the account's own operator off the
air.
"""

import asyncio

import httpx
import pytest

from app.auth import pin_limiter as pin_limiter_module
from app.auth.client_ip import client_ip
from app.auth.pin_limiter import PinLimiter, pin_limiter
from app.config import settings

PIN = "135790"
WRONG_PIN = "246803"

# Deliberately NOT the TEST-NET documentation ranges: `ipaddress` classifies those as private,
# which is exactly the class this helper refuses to accept as a caller. These stand in for
# ordinary public addresses.
ATTACKER_IP = "1.1.1.1"
OPERATOR_IP = "9.9.9.9"


@pytest.fixture(autouse=True)
def _fresh_limiter():
    """The limiter is a process singleton; these tests deliberately fill it."""
    pin_limiter.reset()
    yield
    pin_limiter.reset()


def _request(headers: dict[str, str] | None = None) -> httpx.AsyncClient:
    from app.main import app

    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers=headers or {},
    )


async def test_a_concurrent_burst_of_wrong_pins_cannot_skip_admission(client, editor):
    """24 simultaneous wrong PINs must not all reach bcrypt: the slot is taken before the
    handler awaits anything, so only the free tier plus the one that trips it get through."""
    burst = 24

    async def attempt():
        async with _request() as attacker:
            return await attacker.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})

    results = await asyncio.gather(*(attempt() for _ in range(burst)))
    codes = [r.status_code for r in results]

    assert codes.count(429) > 0
    # Free attempts, plus the one whose failure starts the cooldown ladder.
    assert codes.count(401) <= settings.pin_free_attempts + 1
    assert codes.count(401) + codes.count(429) == burst


async def test_hostile_traffic_on_an_account_does_not_lock_out_its_operator(client, editor):
    """A burst from one source must not take the Einsatzleiter's own tablet off the air."""
    async with _request({"x-forwarded-for": ATTACKER_IP}) as attacker:
        for _ in range(settings.pin_free_attempts + 4):
            await attacker.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
        blocked = await attacker.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
    assert blocked.status_code == 429

    async with _request({"x-forwarded-for": OPERATOR_IP}) as operator:
        allowed = await operator.post("/api/auth/login", json={"user_id": str(editor.id), "pin": PIN})
    assert allowed.status_code == 200


async def test_a_correct_pin_clears_that_sources_cooldown(client, editor):
    """Recovery is immediate: the operator's own fat-fingering does not outlive the login."""
    async with _request({"x-forwarded-for": OPERATOR_IP}) as operator:
        for _ in range(settings.pin_free_attempts):
            await operator.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
        good = await operator.post("/api/auth/login", json={"user_id": str(editor.id), "pin": PIN})
        assert good.status_code == 200
        # Back in the free tier — the next slip is not answered with a cooldown.
        again = await operator.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
    assert again.status_code == 401


# --- bucket hygiene ---------------------------------------------------------------


def test_buckets_from_unknown_users_expire(monkeypatch):
    lim = PinLimiter()
    clock = {"t": 1000.0}
    monkeypatch.setattr(pin_limiter_module.time, "monotonic", lambda: clock["t"])

    for i in range(50):
        lim.reserve(f"{i}|203.0.113.1")
    assert lim.bucket_count() == 50

    clock["t"] += pin_limiter_module.BUCKET_TTL_SECONDS + 1
    lim.reserve("fresh|203.0.113.1")

    assert lim.bucket_count() == 1


def test_bucket_map_stays_bounded_under_a_flood_of_invented_keys(monkeypatch):
    lim = PinLimiter()
    clock = {"t": 1000.0}
    monkeypatch.setattr(pin_limiter_module.time, "monotonic", lambda: clock["t"])

    for i in range(pin_limiter_module.MAX_BUCKETS * 2):
        clock["t"] += 0.001
        lim.reserve(f"user-{i}|203.0.113.{i % 250}")

    assert lim.bucket_count() <= pin_limiter_module.MAX_BUCKETS


def test_an_expired_cooldown_returns_the_key_to_the_free_tier(monkeypatch):
    lim = PinLimiter()
    clock = {"t": 1000.0}
    monkeypatch.setattr(pin_limiter_module.time, "monotonic", lambda: clock["t"])

    for _ in range(settings.pin_free_attempts + 1):
        lim.reserve("u|ip")
    assert lim.reserve("u|ip") > 0

    clock["t"] += pin_limiter_module.BUCKET_TTL_SECONDS + 1

    assert lim.reserve("u|ip") == 0


# --- source identity --------------------------------------------------------------


def _req(peer: str | None, **headers: str):
    scope = {
        "type": "http",
        "headers": [(k.replace("_", "-").encode(), v.encode()) for k, v in headers.items()],
        "client": (peer, 1234) if peer else None,
    }
    from starlette.requests import Request

    return Request(scope)


def test_a_direct_client_cannot_forge_its_own_source():
    """Public peer = nobody we trust to describe the hop before it."""
    assert client_ip(_req(OPERATOR_IP, x_forwarded_for=ATTACKER_IP)) == OPERATOR_IP


def test_a_trusted_proxy_hands_over_the_real_client():
    assert client_ip(_req("127.0.0.1", x_forwarded_for=OPERATOR_IP)) == OPERATOR_IP


def test_prepended_entries_do_not_win_over_the_proxys_own_append():
    """The proxy appends the peer it saw; anything to the left of it is caller-supplied."""
    chain = f"8.8.8.8, 8.8.4.4, {OPERATOR_IP}"
    assert client_ip(_req("10.0.0.2", x_forwarded_for=chain)) == OPERATOR_IP


def test_an_all_private_chain_falls_back_to_the_peer():
    assert client_ip(_req("10.0.0.2", x_forwarded_for="10.0.0.9, 192.168.1.4")) == "10.0.0.2"


def test_garbage_forwarded_values_are_ignored():
    assert client_ip(_req("127.0.0.1", x_forwarded_for="not-an-ip")) == "127.0.0.1"


def test_a_peerless_request_still_yields_a_key():
    assert client_ip(_req(None)) == "unknown"

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


async def test_hostile_traffic_on_an_account_does_not_lock_out_its_operator(client, editor, monkeypatch):
    """A burst from one source must not take the Einsatzleiter's own tablet off the air.

    The ASGI peer is loopback (the stand-in for the reverse proxy), so this asks for one trusted
    hop — the Railway/Caddy shape — to make the forwarded client the source key (SEC-08)."""
    monkeypatch.setattr(settings, "trusted_forwarded_hops", 1)
    async with _request({"x-forwarded-for": ATTACKER_IP}) as attacker:
        for _ in range(settings.pin_free_attempts + 4):
            await attacker.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
        blocked = await attacker.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
    assert blocked.status_code == 429

    async with _request({"x-forwarded-for": OPERATOR_IP}) as operator:
        allowed = await operator.post("/api/auth/login", json={"user_id": str(editor.id), "pin": PIN})
    assert allowed.status_code == 200


async def test_a_correct_pin_clears_that_sources_cooldown(client, editor, monkeypatch):
    """Recovery is immediate: the operator's own fat-fingering does not outlive the login."""
    monkeypatch.setattr(settings, "trusted_forwarded_hops", 1)
    async with _request({"x-forwarded-for": OPERATOR_IP}) as operator:
        for _ in range(settings.pin_free_attempts):
            await operator.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
        good = await operator.post("/api/auth/login", json={"user_id": str(editor.id), "pin": PIN})
        assert good.status_code == 200
        # Back in the free tier — the next slip is not answered with a cooldown.
        again = await operator.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
    assert again.status_code == 401


async def test_hostile_admin_login_traffic_does_not_lock_out_the_operator(client, monkeypatch):
    """SEC-08(a): the admin cooldown was ONE global bucket, checked before the secret was even
    compared, so hostile traffic from anywhere kept winning the next slot and a correct secret
    was met with 429 — a remote admin lockout. Keyed per source now: the attacker throttles only
    their own address, and the operator's correct secret still gets in."""
    monkeypatch.setattr(settings, "trusted_forwarded_hops", 1)

    async with _request({"x-forwarded-for": ATTACKER_IP}) as attacker:
        for _ in range(settings.pin_free_attempts + 4):
            await attacker.post("/api/admin/login", json={"secret": "wrong-secret"})
        blocked = await attacker.post("/api/admin/login", json={"secret": "wrong-secret"})
    assert blocked.status_code == 429

    async with _request({"x-forwarded-for": OPERATOR_IP}) as operator:
        ok = await operator.post("/api/admin/login", json={"secret": settings.admin_secret})
    assert ok.status_code == 200, ok.text


async def test_a_shared_bucket_under_attack_still_admits_the_correct_pin(client, editor, monkeypatch):
    """SEC-08 (round-2 residual): behind a NAT/reverse proxy — or with the default
    `trusted_forwarded_hops=0`, where everyone shares the peer bucket — an attacker and the
    operator land in the SAME source bucket. Round 2 rejected a throttled bucket BEFORE verifying,
    so the attacker's wrong attempts kept the shared bucket blocked and the operator's CORRECT
    PIN was refused indefinitely. A correct PIN must win even from a throttled bucket."""
    # Default deployment: no trusted proxy, so every caller keys on the same loopback peer.
    monkeypatch.setattr(settings, "trusted_forwarded_hops", 0)

    # The attacker floods the shared bucket into a deep cooldown.
    for _ in range(settings.pin_free_attempts + 6):
        await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
    blocked = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
    assert blocked.status_code == 429, blocked.text

    # The operator, sharing that very bucket, still gets in with the correct PIN.
    good = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": PIN})
    assert good.status_code == 200, f"a correct PIN was locked out by a shared, throttled bucket: {good.text}"


async def test_a_shared_bucket_under_attack_still_admits_the_correct_admin_secret(client, monkeypatch):
    """The admin door has the same shape (one shared credential, one source bucket). A throttled
    bucket must not refuse the correct Adminschlüssel."""
    monkeypatch.setattr(settings, "trusted_forwarded_hops", 0)

    for _ in range(settings.pin_free_attempts + 6):
        await client.post("/api/admin/login", json={"secret": "wrong-secret"})
    blocked = await client.post("/api/admin/login", json={"secret": "wrong-secret"})
    assert blocked.status_code == 429, blocked.text

    ok = await client.post("/api/admin/login", json={"secret": settings.admin_secret})
    assert ok.status_code == 200, f"a correct admin secret was locked out by a shared bucket: {ok.text}"


async def test_wrong_attempts_still_get_429_under_load_even_when_verify_always_runs(client, editor, monkeypatch):
    """Verifying under throttle must not soften the throttle for WRONG attempts: once the shared
    bucket is in cooldown, a wrong PIN is still answered 429, not 401."""
    monkeypatch.setattr(settings, "trusted_forwarded_hops", 0)
    for _ in range(settings.pin_free_attempts + 2):
        await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
    assert r.status_code == 429, r.text


async def test_the_bounded_verifier_still_caps_concurrent_bcrypt(client, editor, monkeypatch):
    """Verifying even when throttled is only safe because bcrypt runs through a bounded
    `CapacityLimiter`. A concurrent burst of throttled-but-verifying attempts must never exceed
    that ceiling of simultaneous verifications — the property that keeps «verify under throttle»
    from exhausting the thread pool."""
    from app.auth import security

    live = 0
    peak = 0
    real_verify = security.verify_pin

    def _counting_verify(pin: str, pin_hash: str) -> bool:
        nonlocal live, peak
        live += 1
        peak = max(peak, live)
        try:
            # A touch of real work so overlapping calls actually coincide inside the limiter.
            return real_verify(pin, pin_hash)
        finally:
            live -= 1

    monkeypatch.setattr(security, "verify_pin", _counting_verify)

    async def attempt(pin: str):
        return await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": pin})

    # Push the shared bucket into cooldown, then fire a burst that all reach the (bounded) verify.
    await asyncio.gather(*(attempt(WRONG_PIN) for _ in range(24)))
    assert peak <= security._PIN_VERIFY_LIMITER.total_tokens


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


# Trust is explicit now (SEC-08b): `settings.trusted_forwarded_hops` decides whether the
# forgeable X-Forwarded-For counts at all. Each test sets it for its own case; the default is 0.


def test_xff_is_ignored_when_no_proxy_is_configured(monkeypatch):
    """The safe default: a plain, forgeable header is not consulted. A direct client — public OR
    on the LAN — keys on the peer it actually connected from and cannot mint fresh buckets. The
    old code implicitly trusted any private/loopback peer's XFF, which this closes."""
    monkeypatch.setattr(settings, "trusted_forwarded_hops", 0)
    assert client_ip(_req(OPERATOR_IP, x_forwarded_for=ATTACKER_IP)) == OPERATOR_IP
    # a private LAN peer's forwarded header used to be trusted implicitly — no longer
    assert client_ip(_req("10.0.0.2", x_forwarded_for=ATTACKER_IP)) == "10.0.0.2"
    assert client_ip(_req("127.0.0.1", x_forwarded_for=OPERATOR_IP)) == "127.0.0.1"


def test_one_trusted_hop_hands_over_the_real_client(monkeypatch):
    """TRUSTED_FORWARDED_HOPS=1 — the Railway/Caddy shape. The proxy appended the peer it saw, so
    the rightmost XFF entry is the client."""
    monkeypatch.setattr(settings, "trusted_forwarded_hops", 1)
    assert client_ip(_req("127.0.0.1", x_forwarded_for=OPERATOR_IP)) == OPERATOR_IP


def test_only_the_configured_rightmost_hops_are_honoured(monkeypatch):
    """With one trusted hop, anything a caller prepended sits to the LEFT of the proxy's own
    append and is never reached."""
    monkeypatch.setattr(settings, "trusted_forwarded_hops", 1)
    chain = f"8.8.8.8, 8.8.4.4, {OPERATOR_IP}"
    assert client_ip(_req("10.0.0.2", x_forwarded_for=chain)) == OPERATOR_IP


def test_two_trusted_hops_reach_past_the_inner_proxy(monkeypatch):
    """Two proxies → the client sits two entries from the right (client, then the inner proxy's
    own append)."""
    monkeypatch.setattr(settings, "trusted_forwarded_hops", 2)
    chain = f"{OPERATOR_IP}, 10.0.0.9"
    assert client_ip(_req("10.0.0.2", x_forwarded_for=chain)) == OPERATOR_IP


def test_a_chain_shorter_than_promised_falls_back_to_the_peer(monkeypatch):
    """Fewer entries than the trusted-hop count is not the shape the deployment declared, so the
    un-forgeable peer is the key rather than a caller-controlled guess."""
    monkeypatch.setattr(settings, "trusted_forwarded_hops", 2)
    assert client_ip(_req("10.0.0.2", x_forwarded_for=OPERATOR_IP)) == "10.0.0.2"


def test_an_unparseable_trusted_entry_falls_back_to_the_peer(monkeypatch):
    monkeypatch.setattr(settings, "trusted_forwarded_hops", 1)
    assert client_ip(_req("127.0.0.1", x_forwarded_for="not-an-ip")) == "127.0.0.1"


def test_a_peerless_request_still_yields_a_key():
    assert client_ip(_req(None)) == "unknown"

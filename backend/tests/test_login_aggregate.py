"""M1a/M1b at the login route: the per-account aggregate slowdown and failed-login logging.

The per-(account, source) cooldown is availability-first — a source-rotating attacker mints
fresh buckets at will — so above an abuse-level failure count the ACCOUNT itself gets a small
pre-verify delay (slows, never refuses), and every failed attempt is logged so an attack is
visible in Axiom. The delay is monkeypatched here; nothing actually sleeps.
"""

import logging

from app.auth import router as auth_router_module
from app.auth.pin_limiter import AGGREGATE_BASE_DELAY_SECONDS, AGGREGATE_THRESHOLD, login_aggregate

PIN = "135790"
WRONG_PIN = "246803"


def _capture_delays(monkeypatch) -> list[float]:
    """Replace the route's sleep seam with a recorder — the tests assert on what WOULD wait."""
    delays: list[float] = []

    async def _record(seconds: float) -> None:
        delays.append(seconds)

    monkeypatch.setattr(auth_router_module, "_throttle_delay", _record)
    return delays


async def test_below_threshold_a_login_is_not_delayed(client, editor, monkeypatch):
    delays = _capture_delays(monkeypatch)
    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": PIN})
    assert r.status_code == 200, r.text
    assert delays == []


async def test_above_threshold_every_verify_is_delayed(client, editor, monkeypatch):
    delays = _capture_delays(monkeypatch)
    # Seed the aggregate directly — driving 100+ failures through the route would trip the
    # per-source cooldown, which is exactly the limiter this throttle does NOT depend on.
    for _ in range(AGGREGATE_THRESHOLD):
        login_aggregate.record_failure(str(editor.id))

    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
    assert r.status_code == 401
    assert delays and delays[0] >= AGGREGATE_BASE_DELAY_SECONDS


async def test_a_real_login_still_succeeds_while_throttled(client, editor, monkeypatch):
    """The doctrine's crux: the aggregate path slows, it NEVER refuses — the operator behind
    an ongoing distributed attack waits a breath and gets in."""
    delays = _capture_delays(monkeypatch)
    for _ in range(AGGREGATE_THRESHOLD):
        login_aggregate.record_failure(str(editor.id))

    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": PIN})
    assert r.status_code == 200, r.text
    assert delays and delays[0] >= AGGREGATE_BASE_DELAY_SECONDS
    # The success cleared the tally (LoginAggregate's documented trade-off): the operator's
    # next login is not dragged through the rest of the attacker's hour.
    assert login_aggregate.delay(str(editor.id)) == 0.0


# --- M1b: failed-login logging ----------------------------------------------------


async def test_a_failed_login_logs_user_source_and_aggregate_count(client, editor, caplog):
    with caplog.at_level(logging.WARNING, logger="app.auth.router"):
        r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
    assert r.status_code == 401

    lines = [rec.getMessage() for rec in caplog.records if "PIN login failed" in rec.getMessage()]
    assert len(lines) == 1
    assert str(editor.id) in lines[0]
    assert "source=" in lines[0]
    assert "aggregate_failures=1" in lines[0]
    assert WRONG_PIN not in lines[0]  # no PIN material, ever


async def test_crossing_the_threshold_logs_the_throttle_engaging(client, editor, caplog, monkeypatch):
    _capture_delays(monkeypatch)
    for _ in range(AGGREGATE_THRESHOLD - 1):
        login_aggregate.record_failure(str(editor.id))

    with caplog.at_level(logging.WARNING, logger="app.auth.router"):
        r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": WRONG_PIN})
    assert r.status_code == 401
    engaged = [rec.getMessage() for rec in caplog.records if "throttle engaged" in rec.getMessage()]
    assert len(engaged) == 1
    assert str(editor.id) in engaged[0]

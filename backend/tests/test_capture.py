"""Station capture surface (/api/capture/*) — the Erfassungs-Poster backend.

Contract under test:
- fail-closed: no capture secret in the DB → 403 for every capture call;
- wrong/missing token → 401;
- reachability: unarchived incidents WITHOUT a completed Rapport are listed/writable at any
  age (open backlog), rapportierte ones only inside alarms.captureWindowHours — everything
  else answers 404 (no probing);
- the workspace save shares the editor path (optimistic concurrency, audit) and journal
  appends stay idempotent;
- the admin endpoints (ADMIN_SECRET session) rotate/disable the secret;
- per-IP rate limit: scripted bursts get 429 (German detail), a fast operator never does;
- every capture response carries X-Server-Time (clock-skew contract with the frontend).
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.models import DeploymentConfig, Incident, Personnel

TOKEN = "poster-token-123"


@pytest.fixture
async def capture_secret(db_session):
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db_session.add(row)
    row.capture_secret = TOKEN
    await db_session.commit()
    return TOKEN


def _incident(**kw) -> Incident:
    base = dict(title="Wasser im Keller", source="manual", status="offen")
    return Incident(**{**base, **kw})


async def test_capture_fails_closed_without_secret(client):
    r = await client.get("/api/capture/incidents")
    assert r.status_code == 403


async def test_capture_rejects_wrong_token(client, capture_secret):
    r = await client.get("/api/capture/incidents?t=nope")
    assert r.status_code == 401
    r = await client.get("/api/capture/incidents", headers={"X-Capture-Token": "nope"})
    assert r.status_code == 401


async def test_capture_lists_backlog_and_windowed_incidents(client, capture_secret, db_session):
    now = datetime.now(UTC)
    fresh = _incident(started_at=now - timedelta(hours=1))
    # old but no Rapport yet → still listed (the open backlog stays reachable at any age)
    backlog = _incident(title="Alt ohne Rapport", started_at=now - timedelta(hours=40))
    reported_old = _incident(
        title="Alt rapportiert",
        started_at=now - timedelta(hours=40),
        report_done_at=now - timedelta(hours=30),
    )
    archived = _incident(title="Archiviert", started_at=now - timedelta(hours=1), is_archived=True)
    db_session.add_all([fresh, backlog, reported_old, archived])
    await db_session.commit()

    r = await client.get(f"/api/capture/incidents?t={TOKEN}")
    assert r.status_code == 200
    titles = [i["title"] for i in r.json()]
    assert titles == ["Wasser im Keller", "Alt ohne Rapport"]

    # rapportiert + out of window is not reachable for reads or writes either
    r = await client.get(f"/api/capture/incidents/{reported_old.id}/workspace?t={TOKEN}")
    assert r.status_code == 404
    # …but the unreported backlog incident is
    r = await client.get(f"/api/capture/incidents/{backlog.id}/workspace?t={TOKEN}")
    assert r.status_code == 200


async def test_capture_workspace_roundtrip_and_conflict(client, capture_secret, db_session):
    inc = _incident()
    db_session.add(inc)
    await db_session.commit()

    r = await client.get(f"/api/capture/incidents/{inc.id}/workspace?t={TOKEN}")
    assert r.status_code == 200
    assert r.json() == {"workspace": None, "workspace_rev": 0}

    ws = {"attendance": {"p1": {"status": "present", "displayNameSnapshot": "Meier"}}}
    r = await client.put(
        f"/api/capture/incidents/{inc.id}/workspace?t={TOKEN}", json={"workspace": ws, "base_rev": 0}
    )
    assert r.status_code == 200
    assert r.json()["workspace_rev"] == 1

    # stale base_rev → 409 exactly like the editor endpoint
    r = await client.put(
        f"/api/capture/incidents/{inc.id}/workspace?t={TOKEN}", json={"workspace": ws, "base_rev": 0}
    )
    assert r.status_code == 409


async def test_capture_roster_and_journal(client, capture_secret, db_session):
    db_session.add(Personnel(display_name="Meier Anna", is_active=True))
    db_session.add(Personnel(display_name="Inaktiv Ute", is_active=False))
    inc = _incident()
    db_session.add(inc)
    await db_session.commit()

    r = await client.get(f"/api/capture/roster?t={TOKEN}")
    assert r.status_code == 200
    assert [p["display_name"] for p in r.json()] == ["Meier Anna"]

    row = {"id": "j1", "t": "12:00", "at": "2026-07-08T12:00:00Z", "icon": "note", "text": "Keller ausgepumpt"}
    r = await client.post(f"/api/capture/incidents/{inc.id}/journal?t={TOKEN}", json={"entries": [row]})
    assert r.status_code == 201
    assert r.json()["latest_seq"] == 1
    # idempotent replay: same client id is skipped silently
    r = await client.post(f"/api/capture/incidents/{inc.id}/journal?t={TOKEN}", json={"entries": [row]})
    assert r.status_code == 201
    assert r.json()["latest_seq"] == 1

    # read-back (the capture Rapport-PDF's Verlauf source)
    r = await client.get(f"/api/capture/incidents/{inc.id}/journal?t={TOKEN}")
    assert r.status_code == 200
    assert r.json()["latest_seq"] == 1
    assert r.json()["entries"][0]["row"]["text"] == "Keller ausgepumpt"

    # audit-chain verify through the poster token (real Prüfnachweis on the QR PDF)
    r = await client.get(f"/api/capture/incidents/{inc.id}/verify?t={TOKEN}")
    assert r.status_code == 200
    assert r.json()["intact"] is True
    r = await client.get(f"/api/capture/incidents/{inc.id}/verify?t=nope")
    assert r.status_code == 401


async def test_admin_rotate_and_disable(client, admin_login, db_session):
    await admin_login(client)
    r = await client.post("/api/capture/secret/rotate")
    assert r.status_code == 200
    token = r.json()["token"]
    assert token and r.json()["configured"] is True

    # the new token works, the surface is live
    lr = await client.get(f"/api/capture/incidents?t={token}")
    assert lr.status_code == 200

    r = await client.delete("/api/capture/secret")
    assert r.status_code == 200
    lr = await client.get(f"/api/capture/incidents?t={token}")
    assert lr.status_code == 403  # fail-closed again


async def test_admin_endpoints_require_admin(client, capture_secret):
    r = await client.get("/api/capture/secret")
    assert r.status_code in (401, 403)
    r = await client.post("/api/capture/secret/rotate")
    assert r.status_code in (401, 403)


# --- cross-visibility (editor-opened latch ↔ capture usage counters) --------------------


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def test_editor_latch_set_once_and_not_by_capture(client, capture_secret, db_session, editor, viewer):
    inc = _incident()
    db_session.add(inc)
    await db_session.commit()

    # capture reads/writes never latch — the latch means "the KP tablet has it"
    r = await client.get(f"/api/capture/incidents/{inc.id}/workspace?t={TOKEN}")
    assert r.status_code == 200
    r = await client.put(
        f"/api/capture/incidents/{inc.id}/workspace?t={TOKEN}", json={"workspace": {}, "base_rev": 0}
    )
    assert r.status_code == 200
    r = await client.get(f"/api/capture/incidents/{inc.id}/status?t={TOKEN}")
    assert r.status_code == 200
    assert r.json() == {"kp_active": False}

    # a viewer (EL-Ansicht) reading the workspace doesn't latch either
    await _login(client, viewer)
    r = await client.get(f"/api/incidents/{inc.id}/workspace")
    assert r.status_code == 200
    await db_session.refresh(inc)
    assert inc.editor_opened_at is None

    # the first EDITOR read latches …
    await _login(client, editor)
    r = await client.get(f"/api/incidents/{inc.id}/workspace")
    assert r.status_code == 200
    await db_session.refresh(inc)
    first = inc.editor_opened_at
    assert first is not None
    r = await client.get(f"/api/capture/incidents/{inc.id}/status?t={TOKEN}")
    assert r.json() == {"kp_active": True}

    # … and stays latched (set ONCE — a later read/write never advances it)
    r = await client.get(f"/api/incidents/{inc.id}/workspace")
    assert r.status_code == 200
    r = await client.put(
        f"/api/incidents/{inc.id}/workspace", json={"workspace": {}, "base_rev": 1}
    )
    assert r.status_code == 200
    await db_session.refresh(inc)
    assert inc.editor_opened_at == first


async def test_capture_status_requires_token(client, capture_secret, db_session):
    inc = _incident()
    db_session.add(inc)
    await db_session.commit()
    r = await client.get(f"/api/capture/incidents/{inc.id}/status?t=nope")
    assert r.status_code == 401


async def test_capture_writes_bump_count_and_timestamp(client, capture_secret, db_session):
    inc = _incident()
    db_session.add(inc)
    await db_session.commit()
    assert inc.capture_writes == 0 and inc.capture_last_at is None

    # accepted workspace PUTs count …
    r = await client.put(
        f"/api/capture/incidents/{inc.id}/workspace?t={TOKEN}", json={"workspace": {}, "base_rev": 0}
    )
    assert r.status_code == 200
    r = await client.put(
        f"/api/capture/incidents/{inc.id}/workspace?t={TOKEN}", json={"workspace": {}, "base_rev": 1}
    )
    assert r.status_code == 200
    await db_session.refresh(inc)
    assert inc.capture_writes == 2
    assert inc.capture_last_at is not None
    last = inc.capture_last_at

    # … a rejected save (stale base_rev → 409) does not
    r = await client.put(
        f"/api/capture/incidents/{inc.id}/workspace?t={TOKEN}", json={"workspace": {}, "base_rev": 0}
    )
    assert r.status_code == 409
    await db_session.refresh(inc)
    assert inc.capture_writes == 2 and inc.capture_last_at == last

    # journal appends count once; the idempotent replay (nothing appended) doesn't
    row = {"id": "j1", "t": "12:00", "at": "2026-07-18T12:00:00Z", "icon": "note", "text": "QR-Notiz"}
    r = await client.post(f"/api/capture/incidents/{inc.id}/journal?t={TOKEN}", json={"entries": [row]})
    assert r.status_code == 201
    r = await client.post(f"/api/capture/incidents/{inc.id}/journal?t={TOKEN}", json={"entries": [row]})
    assert r.status_code == 201
    await db_session.refresh(inc)
    assert inc.capture_writes == 3

    # the counters ride the capture incident listing (IncidentMeta) for the tablet views
    r = await client.get(f"/api/capture/incidents?t={TOKEN}")
    meta = next(i for i in r.json() if i["id"] == str(inc.id))
    assert meta["capture_writes"] == 3
    assert meta["capture_last_at"] is not None
    assert meta["editor_opened_at"] is None


# --- rate limiting (per client IP, token bucket) ----------------------------------------


async def test_capture_rate_limit_trips_after_burst(client, capture_secret, monkeypatch):
    """Scripted hammering gets a 429 with a German JSON detail once the burst is drained.
    Shrunk bucket so the test doesn't fire 120 requests; sizing itself is unit-tested below."""
    from app.auth.capture_limiter import capture_limiter
    from app.config import settings

    monkeypatch.setattr(settings, "capture_rate_burst", 5)
    monkeypatch.setattr(settings, "capture_rate_per_minute", 60)
    capture_limiter.reset()
    try:
        for _ in range(5):
            r = await client.get(f"/api/capture/incidents?t={TOKEN}")
            assert r.status_code == 200
        r = await client.get(f"/api/capture/incidents?t={TOKEN}")
        assert r.status_code == 429
        assert r.json() == {"detail": "Zu viele Anfragen — bitte kurz warten."}
        assert int(r.headers["Retry-After"]) >= 1
    finally:
        capture_limiter.reset()


async def test_capture_fast_operator_not_throttled(client, capture_secret, db_session):
    """A legit rapid-fire sequence (a whole attendance tick-off worth of saves, fired
    back-to-back) stays far under the default burst — nothing throttles."""
    from app.auth.capture_limiter import capture_limiter

    capture_limiter.reset()
    db_session.add(Personnel(display_name="Meier Anna", is_active=True))
    await db_session.commit()
    for _ in range(40):
        r = await client.get(f"/api/capture/roster?t={TOKEN}")
        assert r.status_code == 200


def test_capture_limiter_default_sizing(monkeypatch):
    """The explicit sizing requirement: a fast operator sustaining 3 taps/s for a full
    minute (humanly extreme) never trips the DEFAULT bucket; an instant script flood does."""
    from app.auth import capture_limiter as mod

    lim = mod.CaptureLimiter()
    now = [0.0]
    monkeypatch.setattr(mod.time, "monotonic", lambda: now[0])
    for i in range(180):  # 3 req/s for 60 s
        now[0] = i / 3
        assert lim.check("203.0.113.7") == 0
    blocked = sum(1 for _ in range(300) if lim.check("203.0.113.7"))
    assert blocked > 0
    # …and another IP is unaffected (the bucket is per client)
    assert lim.check("198.51.100.1") == 0


# --- X-Server-Time (clock-skew contract with the capture frontend) ----------------------


async def test_capture_responses_carry_server_time(client, capture_secret):
    r = await client.get(f"/api/capture/incidents?t={TOKEN}")
    assert r.status_code == 200
    parsed = datetime.fromisoformat(r.headers["X-Server-Time"])
    assert parsed.tzinfo is not None
    assert abs((datetime.now(UTC) - parsed).total_seconds()) < 60
    # present on error responses too, so the skew check works even before token auth
    r = await client.get("/api/capture/incidents?t=nope")
    assert r.status_code == 401
    assert "X-Server-Time" in r.headers
    # …but not sprayed on non-capture API responses
    r = await client.get("/health")
    assert "X-Server-Time" not in r.headers

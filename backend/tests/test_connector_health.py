"""Connector health: when a connector last tried, when it last actually worked, and why not.

The failure this exists to catch is silence. A Divera key rotated two years ago, a Traccar
server moved, an Azure secret expired — none of them look like anything: the alarms simply stop
arriving and the map simply stops moving, and «konfiguriert: ja» keeps saying yes. So what is
pinned here is the honesty of the pair:

* a FAILURE never moves ``last_success_at`` — a green tick standing through a week of auth
  failures is exactly the silent death the surface exists to prevent;
* an error line never carries a credential (the Divera URL carries the access key);
* the 30 s Traccar sweep does not rewrite its row twice a minute — but a transition is never
  throttled, because «it just broke» is the one write that cannot wait five minutes.
"""

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from app import connector_state, scheduler
from app.config import settings
from app.models import ConnectorState, Incident
from app.traccar import VehiclePosition


class _SessionCtx:
    """Hand a job the test's session without letting its ``async with`` close it."""

    def __init__(self, session):
        self._session = session

    async def __aenter__(self):
        return self._session

    async def __aexit__(self, *exc):
        return False


@pytest.fixture(autouse=True)
def _memo():
    """The throttle memo is a module global — a test that wrote must not silence the next one."""
    connector_state.reset_memo()
    yield
    connector_state.reset_memo()


@pytest.fixture
def run_job(db_session, monkeypatch):
    monkeypatch.setattr(scheduler, "async_session_maker", lambda: _SessionCtx(db_session))

    async def _run(job) -> None:
        await job()

    return _run


async def _row(db, name: str) -> ConnectorState | None:
    return (await db.execute(select(ConnectorState).where(ConnectorState.name == name))).scalar_one_or_none()


# --- the Divera alarm poll ---------------------------------------------------------------


async def test_a_poll_records_both_the_attempt_and_the_success(db_session, run_job, monkeypatch):
    import app.divera as divera_mod

    async def _fetch(db):
        return 2

    monkeypatch.setattr(divera_mod, "fetch_and_upsert", _fetch)
    monkeypatch.setattr(settings, "divera_access_key", "k")

    await run_job(scheduler._poll_divera)

    row = await _row(db_session, connector_state.DIVERA_ALARMS)
    assert row is not None
    assert row.last_attempt_at is not None and row.last_success_at is not None
    assert row.last_error is None
    assert row.detail == {"trigger": "poll", "new": 2}


async def test_a_failed_poll_leaves_the_last_success_exactly_where_it_was(db_session, run_job, monkeypatch):
    """The whole point of two timestamps. A reader shown only «zuletzt geprüft» would call this
    station healthy while its key has been refused for a week."""
    import app.divera as divera_mod

    monkeypatch.setattr(settings, "divera_access_key", "k")

    async def _ok(db):
        return 0

    monkeypatch.setattr(divera_mod, "fetch_and_upsert", _ok)
    await run_job(scheduler._poll_divera)
    succeeded_at = (await _row(db_session, connector_state.DIVERA_ALARMS)).last_success_at

    async def _refused(db):
        raise divera_mod.DiveraApiError(403, "Divera API HTTP 403")

    monkeypatch.setattr(divera_mod, "fetch_and_upsert", _refused)
    await run_job(scheduler._poll_divera)

    row = await _row(db_session, connector_state.DIVERA_ALARMS)
    assert row.last_success_at == succeeded_at  # untouched
    assert row.last_attempt_at > succeeded_at  # …but we know we tried since
    assert "403" in row.last_error


async def test_the_error_line_never_carries_the_access_key():
    """⚠️ An httpx status error stringifies to «… for url '…?accesskey=<the key>'», and this
    column is served to the admin System card. Only the URL-free types are ever quoted."""
    leaky = httpx.HTTPStatusError(
        "Client error '403 Forbidden' for url 'https://divera247.com/api/alarm?accesskey=SUPERSECRET'",
        request=httpx.Request("GET", "https://divera247.com/"),
        response=httpx.Response(403),
    )
    line = connector_state.safe_error(leaky)
    assert line == "HTTPStatusError"
    assert "SUPERSECRET" not in line


async def test_a_webhook_delivery_counts_as_the_alarm_connector_working(db_session, client, monkeypatch):
    """The webhook is the PRIMARY intake and the poll is the fallback, so a station that runs on
    the webhook alone must not read as a dead connector."""
    monkeypatch.setattr(settings, "divera_webhook_secret", "hook-secret-123")
    payload = {"id": 4711, "title": "Zimmerbrand", "address": "Teststrasse 1", "lat": 47.5, "lng": 7.5}

    r = await client.post("/api/divera/webhook", json=payload, headers={"X-Webhook-Secret": "hook-secret-123"})
    assert r.status_code == 200

    row = await _row(db_session, connector_state.DIVERA_ALARMS)
    assert row is not None and row.last_success_at is not None
    assert row.detail == {"trigger": "webhook", "alarm": 4711}


async def test_a_refused_webhook_delivery_records_nothing(db_session, client, monkeypatch):
    """It never reached the connector — it reached the door. Recording an attempt here would let
    anyone on the internet write this station's status row."""
    monkeypatch.setattr(settings, "divera_webhook_secret", "hook-secret-123")
    r = await client.post("/api/divera/webhook", json={"id": 1, "title": "x"}, headers={"X-Webhook-Secret": "no"})
    assert r.status_code == 401
    assert await _row(db_session, connector_state.DIVERA_ALARMS) is None


# --- the Traccar sweep, and its throttle --------------------------------------------------


@pytest.fixture
def traccar(monkeypatch):
    """A configured Traccar whose feed the test drives (mirrors test_vehicle_samples)."""
    feed: list[VehiclePosition] = []

    class _Client:
        is_configured = True

        async def get_vehicle_positions(self):
            if isinstance(feed, list) and feed and feed[0] == "boom":
                raise httpx.ConnectError("traccar unreachable")
            return list(feed)

    import app.traccar as traccar_mod

    monkeypatch.setattr(traccar_mod, "traccar_client", _Client())
    return feed


@pytest.fixture
async def incident(db_session):
    inc = Incident(title="Brand Hauptstrasse 4", source="manual", status="offen")
    db_session.add(inc)
    await db_session.commit()
    await db_session.refresh(inc)
    return inc


def _pos(device_id: int, lat: float, lng: float) -> VehiclePosition:
    return VehiclePosition(
        device_id=device_id,
        device_name=f"TLF {device_id}",
        unique_id=f"u{device_id}",
        status="online",
        latitude=lat,
        longitude=lng,
        speed=0.0,
        course=90.0,
        last_update=datetime.now(UTC),
    )


async def test_the_vehicle_sweep_does_not_rewrite_its_row_every_thirty_seconds(db_session, incident, traccar, run_job):
    """Row churn, not information: «is Traccar still working» does not change twice a minute.
    The samples themselves are unaffected — they have their own rule (test_vehicle_samples)."""
    traccar.append(_pos(1, 47.5, 7.5))
    await run_job(scheduler._vehicle_samples_sweep)
    first = (await _row(db_session, connector_state.TRACCAR)).last_attempt_at
    assert first is not None

    traccar[:] = [_pos(1, 47.6, 7.6)]
    await run_job(scheduler._vehicle_samples_sweep)

    assert (await _row(db_session, connector_state.TRACCAR)).last_attempt_at == first


async def test_a_traccar_failure_is_written_at_once_however_recently_it_succeeded(
    db_session, incident, traccar, run_job
):
    """The transition is the one write that cannot wait for the throttle window."""
    traccar.append(_pos(1, 47.5, 7.5))
    await run_job(scheduler._vehicle_samples_sweep)
    succeeded_at = (await _row(db_session, connector_state.TRACCAR)).last_success_at

    traccar[:] = ["boom"]
    await run_job(scheduler._vehicle_samples_sweep)

    row = await _row(db_session, connector_state.TRACCAR)
    assert row.last_error == "ConnectError"
    assert row.last_success_at == succeeded_at


async def test_a_quiet_feed_is_still_a_working_connector(db_session, incident, traccar, run_job):
    """Traccar answered; no tracker had anything to say. «Verbunden, niemand meldet sich» is a
    state of its own, and reading it as a dead connector would send somebody to Zugangsdaten."""
    await run_job(scheduler._vehicle_samples_sweep)

    row = await _row(db_session, connector_state.TRACCAR)
    assert row is not None and row.last_success_at is not None
    assert row.detail == {"vehicles": 0}


# --- the recording rules themselves --------------------------------------------------------


async def test_an_unchanged_report_is_skipped_inside_the_window_and_written_after_it(db_session):
    assert await connector_state.record(db_session, connector_state.TRACCAR, ok=True, throttle_seconds=300)
    assert not await connector_state.record(db_session, connector_state.TRACCAR, ok=True, throttle_seconds=300)

    # Age the memo rather than the clock — the window is the rule under test, not the calendar.
    when, ok, error = connector_state._last_written[connector_state.TRACCAR]
    connector_state._last_written[connector_state.TRACCAR] = (when - timedelta(seconds=301), ok, error)

    assert await connector_state.record(db_session, connector_state.TRACCAR, ok=True, throttle_seconds=300)


async def test_a_changed_reason_is_never_throttled(db_session):
    """Two different failures inside one window are two different things to go and look at."""
    await connector_state.record(db_session, connector_state.TRACCAR, ok=False, error="a", throttle_seconds=300)
    assert await connector_state.record(db_session, connector_state.TRACCAR, ok=False, error="b", throttle_seconds=300)
    assert (await _row(db_session, connector_state.TRACCAR)).last_error == "b"


async def test_a_success_clears_the_error_that_stood_before_it(db_session):
    await connector_state.record(db_session, connector_state.DIVERA_ALARMS, ok=False, error="Divera API HTTP 403")
    await connector_state.record(db_session, connector_state.DIVERA_ALARMS, ok=True)

    assert (await _row(db_session, connector_state.DIVERA_ALARMS)).last_error is None


async def test_every_connector_is_projected_even_before_it_has_ever_run(db_session):
    """«Never ran» and «this build does not report it» must not be the same shape on the wire."""
    states = await connector_state.states(db_session)

    assert set(states) == {"divera_alarms", "traccar", "divera_personnel"}
    assert states["traccar"] == {"lastAttempt": None, "lastSuccess": None, "lastError": None, "counts": None}


# --- what /api/system serves ---------------------------------------------------------------


async def test_the_system_card_reads_what_the_poll_recorded(db_session, client, editor, admin_login, monkeypatch):
    monkeypatch.setattr(settings, "divera_access_key", "k")
    await connector_state.record(
        db_session, connector_state.DIVERA_ALARMS, ok=False, error="Divera API HTTP 403", detail={"new": 0}
    )
    await db_session.commit()

    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    await admin_login(client)
    body = (await client.get("/api/system")).json()

    divera = next(c for c in body["connectors"] if c["id"] == "divera_alarms")
    assert divera["configured"] is True
    # A connector whose last attempt failed reads 'offline' — and the two timestamps are served
    # raw, so the surface decides what «stale» means rather than the backend guessing a window.
    assert divera["state"] == "offline"
    assert divera["lastError"] == "Divera API HTTP 403"
    assert divera["lastSuccess"] is None
    assert divera["lastAttempt"] is not None
    assert divera["counts"] == {"new": 0}

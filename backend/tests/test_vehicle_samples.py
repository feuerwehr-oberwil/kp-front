"""The Traccar → vehicle_samples capture job (scheduler._vehicle_samples_sweep).

`GET /incidents/{id}/samples`, its schema and the client-side replay all shipped long ago and
read an empty table: nothing ever wrote a row (the endpoint's own docstring said so —
"PLAN-audit-trail §4, Phase 6"). So the Verlauf could replay drawings and journal rows but not
where the vehicles went, which is the one part of a replay nobody can reconstruct from memory.

What this file pins is the sampling RULE, because that is the part with a judgement in it: a
track dense enough to redraw the route, without a row per truck per tick for a fleet that
spent six hours parked at the Magazin.
"""

from datetime import UTC, datetime, timedelta

import pytest

from app import scheduler
from app.models import Incident, VehicleSample
from app.traccar import VehiclePosition


class _SessionCtx:
    """Hand the sweep the test's session without letting `async with` close it."""

    def __init__(self, session):
        self._session = session

    async def __aenter__(self):
        return self._session

    async def __aexit__(self, *exc):
        return False


def _pos(device_id: int, lat: float, lng: float, *, ts: datetime | None = None) -> VehiclePosition:
    return VehiclePosition(
        device_id=device_id,
        device_name=f"TLF {device_id}",
        unique_id=f"u{device_id}",
        status="online",
        latitude=lat,
        longitude=lng,
        speed=0.0,
        course=90.0,
        last_update=ts or datetime.now(UTC),
    )


@pytest.fixture
def traccar(monkeypatch):
    """A configured Traccar whose feed the test drives."""
    feed: list[VehiclePosition] = []

    class _Client:
        is_configured = True

        async def get_vehicle_positions(self):
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


async def _sweep(db_session, monkeypatch) -> None:
    monkeypatch.setattr(scheduler, "async_session_maker", lambda: _SessionCtx(db_session))
    await scheduler._vehicle_samples_sweep()


async def _rows(db_session, incident) -> list[tuple]:
    from sqlalchemy import select

    return list(
        (
            await db_session.execute(
                select(VehicleSample.device_id, VehicleSample.lat, VehicleSample.lng)
                .where(VehicleSample.incident_id == incident.id)
                .order_by(VehicleSample.ts.asc())
            )
        ).all()
    )


async def test_a_moving_vehicle_is_recorded(db_session, incident, traccar, monkeypatch):
    traccar.append(_pos(1, 47.5163, 7.5617))
    await _sweep(db_session, monkeypatch)
    assert len(await _rows(db_session, incident)) == 1

    # ~150 m east — a real move
    traccar[0] = _pos(1, 47.5163, 7.5637)
    await _sweep(db_session, monkeypatch)
    assert len(await _rows(db_session, incident)) == 2


async def test_a_parked_vehicle_does_not_fill_the_table(db_session, incident, traccar, monkeypatch):
    """The whole reason for a movement threshold: a fleet at the Magazin would otherwise write
    a row per truck every 30 s, and a replay would scrub through hours of nothing."""
    traccar.append(_pos(1, 47.5163, 7.5617))
    await _sweep(db_session, monkeypatch)
    for _ in range(5):
        await _sweep(db_session, monkeypatch)
    assert len(await _rows(db_session, incident)) == 1


async def test_a_stationary_vehicle_still_gets_a_heartbeat(db_session, incident, traccar, monkeypatch):
    """«Parked here the whole time» has to be distinguishable from «we stopped hearing from it»."""
    traccar.append(_pos(1, 47.5163, 7.5617))
    await _sweep(db_session, monkeypatch)

    # the last sample ages past the heartbeat
    from sqlalchemy import update

    await db_session.execute(
        update(VehicleSample).values(
            ts=datetime.now(UTC) - timedelta(seconds=scheduler.VEHICLE_SAMPLE_HEARTBEAT_SECONDS + 60)
        )
    )
    await db_session.commit()

    await _sweep(db_session, monkeypatch)
    assert len(await _rows(db_session, incident)) == 2


async def test_nothing_is_recorded_for_a_finished_einsatz(db_session, incident, traccar, monkeypatch):
    incident.is_archived = True
    await db_session.commit()
    traccar.append(_pos(1, 47.5163, 7.5617))
    await _sweep(db_session, monkeypatch)
    assert await _rows(db_session, incident) == []


async def test_every_open_einsatz_gets_its_own_track(db_session, traccar, monkeypatch):
    """Two Einsätze running at once each need the full picture — a shared fleet is sampled into
    both, because a replay of one must not depend on what the other was doing."""
    a = Incident(title="A", source="manual", status="offen")
    b = Incident(title="B", source="manual", status="in_arbeit")
    db_session.add_all([a, b])
    await db_session.commit()
    await db_session.refresh(a)
    await db_session.refresh(b)

    traccar.append(_pos(1, 47.5163, 7.5617))
    await _sweep(db_session, monkeypatch)
    assert len(await _rows(db_session, a)) == 1
    assert len(await _rows(db_session, b)) == 1

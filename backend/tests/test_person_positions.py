"""Live crew positions (/api/incidents/{id}/positions) — the ephemerality contract.

What this file has to prove is mostly about *disappearing*. A named human's coordinates are
the most sensitive thing this app has ever stored, and the promise made on the phone when
someone opts in is narrow: the command post sees where you are while the Einsatz runs, and
then it is gone. So:

- one row per person, overwritten — never a track;
- a second phone cannot quietly take over a name that is actively sharing;
- stopping deletes, it does not merely stale out;
- closing the Einsatz deletes, by either route that ends one (archive · status);
- the sweep is the backstop for the Einsatz nobody closes;
- the public demo does not participate at all.

The write-only-for-a-link-session half lives in test_incident_link.py, next to the rest of
the allowlist contract.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from app.models import DeploymentConfig, Incident, Personnel, PersonPosition

DEVICE = "dev-aaaaaaaaaaaa"
OTHER_DEVICE = "dev-bbbbbbbbbbbb"


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200, r.text


async def _set_demo(db_session, on: bool) -> None:
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    identity = {"demoMode": on}
    if row is None:
        db_session.add(DeploymentConfig(id=1, config_json={"identity": identity}))
    else:
        row.config_json = {**(row.config_json or {}), "identity": identity}
    await db_session.commit()


@pytest.fixture
async def incident(db_session):
    inc = Incident(title="Brand Hauptstrasse 4", source="manual", status="offen")
    db_session.add(inc)
    await db_session.commit()
    await db_session.refresh(inc)
    return inc


@pytest.fixture
async def person(db_session):
    p = Personnel(display_name="Meier Hans", is_active=True)
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)
    return p


def _body(person, **over) -> dict:
    base = {
        "person_id": str(person.id),
        "display_name": person.display_name,
        "device_id": DEVICE,
        "lat": 47.5163,
        "lng": 7.5617,
        "accuracy_m": 12.5,
        "ts": datetime.now(UTC).isoformat(),
    }
    return {**base, **over}


async def _rows(db_session, incident) -> list[tuple]:
    """(device_id, lat) per row, read as plain columns.

    Columns rather than ORM objects on purpose: the API writes through its own session on the
    same connection, so anything this session already loaded is stale — and an `expire_all()`
    would only move the problem to a lazy refresh outside the async context.
    """
    return list(
        (
            await db_session.execute(
                select(PersonPosition.device_id, PersonPosition.lat).where(PersonPosition.incident_id == incident.id)
            )
        ).all()
    )


async def _age_rows(db_session, incident, delta: timedelta) -> None:
    """Backdate every position of this incident — a phone that stopped reporting."""
    await db_session.execute(
        update(PersonPosition)
        .where(PersonPosition.incident_id == incident.id)
        .values(updated_at=datetime.now(UTC) - delta)
    )
    await db_session.commit()


# --- the round trip ---------------------------------------------------------------------


async def test_post_then_get_round_trip(client, editor, incident, person):
    await _login(client, editor)
    r = await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))
    assert r.status_code == 204, r.text

    r = await client.get(f"/api/incidents/{incident.id}/positions")
    assert r.status_code == 200, r.text
    [got] = r.json()
    assert got.pop("ts")  # echoed back from the device; format is httpx/pydantic's business
    assert got == {
        "person_id": str(person.id),
        "display_name": "Meier Hans",
        "lat": 47.5163,
        "lng": 7.5617,
        "accuracy_m": 12.5,
    }


async def test_repeated_reports_overwrite_rather_than_accumulate(client, editor, incident, person, db_session):
    """The whole point of the schema: no track of a named human is ever built."""
    await _login(client, editor)
    for lat in (47.51, 47.52, 47.53):
        r = await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person, lat=lat))
        assert r.status_code == 204, r.text

    rows = await _rows(db_session, incident)
    assert len(rows) == 1
    assert float(rows[0][1]) == pytest.approx(47.53)


async def test_stale_position_is_still_served(client, editor, incident, person, db_session):
    """A phone that locked 40 minutes ago still holds the best answer anyone has. Hiding it
    would read as «nobody is sharing» — the client shows the age instead."""
    await _login(client, editor)
    await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))
    await _age_rows(db_session, incident, timedelta(minutes=40))

    r = await client.get(f"/api/incidents/{incident.id}/positions")
    assert len(r.json()) == 1


# --- the claim --------------------------------------------------------------------------


async def test_second_device_cannot_take_a_live_name(client, editor, incident, person):
    """Two dots' worth of truth for one person is worse than none — the second phone is told."""
    await _login(client, editor)
    await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))

    r = await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person, device_id=OTHER_DEVICE))
    assert r.status_code == 409, r.text
    assert "anderen Gerät" in r.json()["detail"]


async def test_second_device_takes_over_once_the_claim_goes_quiet(client, editor, incident, person, db_session):
    """A responder who swapped phones must get their own name back without an operator."""
    await _login(client, editor)
    await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))
    await _age_rows(db_session, incident, timedelta(minutes=5))

    r = await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person, device_id=OTHER_DEVICE))
    assert r.status_code == 204, r.text
    rows = await _rows(db_session, incident)
    assert len(rows) == 1 and rows[0][0] == OTHER_DEVICE


# --- stopping ---------------------------------------------------------------------------


async def test_stop_deletes_the_row(client, editor, incident, person, db_session):
    await _login(client, editor)
    await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))

    r = await client.delete(f"/api/incidents/{incident.id}/positions/{person.id}?device={DEVICE}")
    assert r.status_code == 204, r.text
    assert await _rows(db_session, incident) == []


async def test_stop_from_a_foreign_device_does_nothing(client, editor, incident, person, db_session):
    """One phone must not be able to switch off another's sharing. Still 204 — a 404 would
    tell a prober which names are currently sharing."""
    await _login(client, editor)
    await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))

    r = await client.delete(f"/api/incidents/{incident.id}/positions/{person.id}?device={OTHER_DEVICE}")
    assert r.status_code == 204, r.text
    assert len(await _rows(db_session, incident)) == 1


# --- the Einsatz ends -------------------------------------------------------------------


@pytest.mark.parametrize(
    "patch",
    [
        pytest.param({"is_archived": True}, id="archived"),
        pytest.param({"status": "geschlossen"}, id="status"),
    ],
)
async def test_closing_the_einsatz_deletes_every_position(client, editor, incident, person, db_session, patch):
    """Both patchable ways of ending an Einsatz honour the promise. (`closed_at` is the third
    thing `Incident.is_open` reads, but it is stamped by archiving rather than patched — the
    refusal test below covers it directly.)"""
    await _login(client, editor)
    await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))

    r = await client.patch(f"/api/incidents/{incident.id}", json=patch)
    assert r.status_code == 200, r.text
    assert await _rows(db_session, incident) == []


async def test_an_einsatz_marked_in_arbeit_is_still_running(client, editor, incident, person, db_session):
    """«In Arbeit» is the state of an Einsatz somebody is WORKING — the one moment it is most
    obviously not over. Treating only "offen" as running hid Standort teilen (and revoked the
    Einsatz-Link) exactly then, reported from production 2026-08-05."""
    incident.status = "in_arbeit"
    await db_session.commit()
    await _login(client, editor)
    r = await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))
    assert r.status_code == 204, r.text


async def test_reporting_into_a_reactivated_einsatz_works(client, editor, incident, person, db_session):
    """`closed_at` alone does not close an Einsatz: it is the first Einsatzende, kept across a
    reopen so later journal rows read as Nachträge. An Einsatz an operator reactivated is
    running, and its crew must be able to report again (production, 2026-08-05)."""
    incident.closed_at = datetime(2026, 8, 3, 15, 51, tzinfo=UTC)
    await db_session.commit()
    await _login(client, editor)
    r = await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))
    assert r.status_code == 204, r.text


@pytest.mark.parametrize(
    "ends_it",
    [
        pytest.param({"is_archived": True}, id="archived"),
        pytest.param({"status": "geschlossen"}, id="status"),
    ],
)
async def test_reporting_into_a_closed_einsatz_is_refused(client, editor, incident, person, db_session, ends_it):
    """Both things `Incident.is_open` reads, straight on the row."""
    for k, v in ends_it.items():
        setattr(incident, k, v)
    await db_session.commit()
    await _login(client, editor)
    r = await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))
    assert r.status_code == 404, r.text


async def test_reopening_does_not_resurrect_positions(client, editor, incident, person, db_session):
    """The phones start reporting again on their own; inventing positions nobody currently
    vouches for would be worse than an empty layer."""
    await _login(client, editor)
    await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))
    await client.patch(f"/api/incidents/{incident.id}", json={"is_archived": True})
    r = await client.patch(f"/api/incidents/{incident.id}", json={"is_archived": False})
    assert r.status_code == 200, r.text
    assert await _rows(db_session, incident) == []


async def test_sweep_drops_positions_that_went_quiet(client, editor, incident, person, db_session, monkeypatch):
    """Backstop for the Einsatz nobody ever closes."""
    from app import scheduler
    from app.config import settings

    await _login(client, editor)
    await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))
    await _age_rows(db_session, incident, timedelta(hours=settings.position_ttl_hours + 1))

    monkeypatch.setattr(scheduler, "async_session_maker", lambda: _SessionCtx(db_session))
    await scheduler._positions_sweep()
    assert await _rows(db_session, incident) == []


class _SessionCtx:
    """Hand the sweep the test's own session (which is bound to the test transaction)
    without letting its `async with` close it."""

    def __init__(self, session):
        self._session = session

    async def __aenter__(self):
        return self._session

    async def __aexit__(self, *exc):
        return False


# --- the demo -----------------------------------------------------------------------------


async def test_demo_refuses_to_take_a_position(client, editor, incident, person, db_session):
    """The demo is a URL anyone on the internet can open, populated with fake Musterdorf
    people. Real strangers posting real coordinates against those names has no upside."""
    await _login(client, editor)
    await _set_demo(db_session, True)
    r = await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))
    assert r.status_code == 403, r.text


async def test_demo_serves_no_positions(client, editor, incident, person, db_session):
    await _login(client, editor)
    await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))
    await _set_demo(db_session, True)
    r = await client.get(f"/api/incidents/{incident.id}/positions")
    assert r.status_code == 200 and r.json() == []


# --- input hygiene ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "over",
    [
        pytest.param({"lat": 91.0}, id="lat-out-of-range"),
        pytest.param({"lng": -181.0}, id="lng-out-of-range"),
        pytest.param({"device_id": "short"}, id="device-id-too-short"),
        pytest.param({"display_name": ""}, id="empty-name"),
    ],
)
async def test_malformed_reports_are_rejected(client, editor, incident, person, over):
    await _login(client, editor)
    r = await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person, **over))
    assert r.status_code == 422, r.text


async def test_unknown_person_is_rejected(client, editor, incident, db_session):
    """`person_id` is a claim, but it still has to name somebody on the roster."""
    await _login(client, editor)
    r = await client.post(
        f"/api/incidents/{incident.id}/positions",
        json={
            "person_id": str(uuid.uuid4()),
            "display_name": "Niemand",
            "device_id": DEVICE,
            "lat": 47.5,
            "lng": 7.5,
            "ts": datetime.now(UTC).isoformat(),
        },
    )
    assert r.status_code in (404, 422), r.text


@pytest.mark.asyncio
async def test_an_editor_clears_a_position_without_the_phone(client, editor, incident, person):
    """Somebody drives home with sharing still on, or a phone dies holding its last fix — the dot
    then claims a crew is somewhere they are not, and only that phone could remove it."""
    await _login(client, editor)
    await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))
    assert len((await client.get(f"/api/incidents/{incident.id}/positions")).json()) == 1

    # no `device`: the whole point is that the phone is not reachable
    r = await client.delete(f"/api/incidents/{incident.id}/positions/{person.id}")
    assert r.status_code == 204, r.text
    assert (await client.get(f"/api/incidents/{incident.id}/positions")).json() == []


@pytest.mark.asyncio
async def test_a_viewer_may_not_clear_somebody_elses_position(client, viewer, editor, incident, person):
    """Reading the Lage is not authority over what other people reported about themselves."""
    await _login(client, editor)
    await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))

    await _login(client, viewer)
    assert (await client.delete(f"/api/incidents/{incident.id}/positions/{person.id}")).status_code == 403


@pytest.mark.asyncio
async def test_a_phone_still_only_switches_off_its_own(client, editor, incident, person):
    """The device-scoped form is unchanged: one phone can never stop another's sharing."""
    await _login(client, editor)
    await client.post(f"/api/incidents/{incident.id}/positions", json=_body(person))

    # a different device deletes nothing, and still answers 204 (never a prober oracle)
    r = await client.delete(f"/api/incidents/{incident.id}/positions/{person.id}?device={OTHER_DEVICE}")
    assert r.status_code == 204
    assert len((await client.get(f"/api/incidents/{incident.id}/positions")).json()) == 1

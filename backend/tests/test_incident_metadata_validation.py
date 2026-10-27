"""Incident metadata input guards (POST /api/incidents, PATCH /api/incidents/{id}).

Covers: the lifecycle and priority words are the app's own (a typo used to close the Einsatz);
an omitted patch field is untouched, an explicit null clears only a nullable column and is a 422
on a required one; titles are trimmed and non-blank; coordinates are finite, in range, numbers,
and a patched pair is checked against the stored half. Every refusal leaves the row as it was.
"""

import uuid
from typing import get_args

import pytest

from app.models import INCIDENT_ACTIVE_STATUSES, Incident
from app.schemas import INCIDENT_PATCH_REQUIRED, IncidentPatch, IncidentStatus


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _incident(client, **extra) -> dict:
    r = await client.post("/api/incidents", json={"title": "Brand Scheune", "lat": 47.5, "lng": 7.6, **extra})
    assert r.status_code == 201, r.text
    return r.json()


async def _patch_refused(client, inc: dict, body: dict | str) -> None:
    """PATCH that must answer 422 and leave every stored field — and updated_at — as it was."""
    kw = {"content": body, "headers": {"Content-Type": "application/json"}} if isinstance(body, str) else {"json": body}
    r = await client.patch(f"/api/incidents/{inc['id']}", **kw)
    assert r.status_code == 422, r.text
    after = (await client.get(f"/api/incidents/{inc['id']}")).json()
    assert after == inc


def test_required_patch_fields_are_exactly_the_not_null_columns():
    cols = Incident.__table__.c
    not_null = {name for name in IncidentPatch.model_fields if not cols[name].nullable}
    assert not_null == INCIDENT_PATCH_REQUIRED


def test_status_words_include_every_running_status():
    assert set(INCIDENT_ACTIVE_STATUSES) < set(get_args(IncidentStatus))


# --- title: missing vs null vs blank ---------------------------------------------------------


async def test_create_without_or_with_blank_title_is_refused(client, editor):
    await _login(client, editor)
    for body in ({}, {"title": None}, {"title": "   "}, {"title": "x" * 1001}):
        r = await client.post("/api/incidents", json=body)
        assert r.status_code == 422, body


async def test_create_trims_the_title_and_blank_optionals(client, editor):
    await _login(client, editor)
    inc = await _incident(client, title="  Brand  ", address="  ", text=" Meldung ")
    assert (inc["title"], inc["address"], inc["text"]) == ("Brand", None, "Meldung")


@pytest.mark.parametrize("body", [{"title": None}, {"title": ""}, {"title": " \t "}])
async def test_patch_null_or_blank_title_is_refused(client, editor, body):
    await _login(client, editor)
    await _patch_refused(client, await _incident(client), body)


async def test_patch_without_title_leaves_it(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    r = await client.patch(f"/api/incidents/{inc['id']}", json={"text": "Rauch sichtbar"})
    assert r.status_code == 200, r.text
    assert (r.json()["title"], r.json()["text"]) == ("Brand Scheune", "Rauch sichtbar")


@pytest.mark.parametrize("field", ["started_at", "status", "is_archived", "is_exercise"])
async def test_patch_null_on_another_required_field_is_refused(client, editor, field):
    await _login(client, editor)
    await _patch_refused(client, await _incident(client), {field: None})


async def test_patch_null_clears_a_nullable_field(client, editor):
    await _login(client, editor)
    inc = await _incident(client, priority="HIGH", text="Meldung", type="Brand")
    r = await client.patch(f"/api/incidents/{inc['id']}", json={"priority": None, "text": None, "type": None})
    assert r.status_code == 200, r.text
    assert (r.json()["priority"], r.json()["text"], r.json()["type"]) == (None, None, None)


# --- lifecycle and priority -----------------------------------------------------------------


@pytest.mark.parametrize("value", ["of fen", "OFFEN", "closed", ""])
async def test_patch_unknown_status_is_refused_and_the_incident_stays_open(client, editor, value):
    await _login(client, editor)
    inc = await _incident(client)
    await _patch_refused(client, inc, {"status": value})
    assert (await client.get(f"/api/incidents/{inc['id']}/workspace")).headers["X-Incident-Open"] == "1"


async def test_patch_known_status_still_closes(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    r = await client.patch(f"/api/incidents/{inc['id']}", json={"status": "abgeschlossen"})
    assert r.status_code == 200, r.text
    assert (await client.get(f"/api/incidents/{inc['id']}/workspace")).headers["X-Incident-Open"] == "0"


@pytest.mark.parametrize("value", ["NORMAL", "high", 1])
async def test_priority_outside_the_enum_is_refused(client, editor, value):
    await _login(client, editor)
    assert (await client.post("/api/incidents", json={"title": "x", "priority": value})).status_code == 422
    await _patch_refused(client, await _incident(client), {"priority": value})


async def test_a_legacy_priority_still_reads(client, editor, db_session):
    """Inputs are validated, outputs are not: a stored «NORMAL» (the demo's archive) reads."""
    await _login(client, editor)
    inc = await _incident(client)
    row = await db_session.get(Incident, uuid.UUID(inc["id"]))
    row.priority = "NORMAL"
    await db_session.commit()
    r = await client.get(f"/api/incidents/{inc['id']}")
    assert r.status_code == 200 and r.json()["priority"] == "NORMAL"


# --- coordinates ----------------------------------------------------------------------------

BAD_COORDS = [
    '{"lat": 91, "lng": 7.6}',
    '{"lat": 47.5, "lng": 181}',
    '{"lat": -90.0001, "lng": 7.6}',
    '{"lat": NaN, "lng": 7.6}',
    '{"lat": 47.5, "lng": Infinity}',
    '{"lat": -Infinity, "lng": 7.6}',
    '{"lat": true, "lng": 7.6}',
    '{"lat": "47.5", "lng": 7.6}',
]


@pytest.mark.parametrize("coords", BAD_COORDS)
async def test_create_with_bad_coordinates_is_refused(client, editor, coords):
    await _login(client, editor)
    r = await client.post(
        "/api/incidents", content='{"title": "x", ' + coords[1:], headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 422, r.text
    assert (await client.get("/api/incidents")).json() == []


@pytest.mark.parametrize("coords", BAD_COORDS)
async def test_patch_with_bad_coordinates_is_refused(client, editor, coords):
    await _login(client, editor)
    await _patch_refused(client, await _incident(client), coords)


@pytest.mark.parametrize(("lat", "lng"), [(90, 180), (-90, -180), (0, 0), (-90.0, 179.9999999)])
async def test_poles_and_dateline_are_accepted(client, editor, lat, lng):
    await _login(client, editor)
    inc = await _incident(client, lat=lat, lng=lng)
    assert (inc["lat"], inc["lng"]) == (lat, lng)
    r = await client.patch(f"/api/incidents/{inc['id']}", json={"lat": -lat, "lng": -lng})
    assert r.status_code == 200, r.text


async def test_patch_one_coordinate_is_checked_against_the_stored_other(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    r = await client.patch(f"/api/incidents/{inc['id']}", json={"lat": 47.6})
    assert r.status_code == 200, r.text
    assert (r.json()["lat"], r.json()["lng"]) == (47.6, 7.6)
    inc = r.json()
    # clearing one half would leave half a position
    await _patch_refused(client, inc, {"lat": None})
    # and setting one half on an incident without a position is no position either
    bare = (await client.post("/api/incidents", json={"title": "ohne Ort"})).json()
    await _patch_refused(client, bare, {"lat": 47.5})


async def test_patch_clears_both_coordinates(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    r = await client.patch(f"/api/incidents/{inc['id']}", json={"lat": None, "lng": None})
    assert r.status_code == 200, r.text
    assert (r.json()["lat"], r.json()["lng"]) == (None, None)

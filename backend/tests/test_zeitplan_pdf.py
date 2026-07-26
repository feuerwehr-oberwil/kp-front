"""Führungsformular «Zeitplan»: the Schichtenplanung as a printable A4-landscape sheet.

The endpoint composes a real PDF from the surface's payload; the layout itself is verified by
eye against the KKO BS / KFS BL form. Covered here: the composer's window maths (which decides
what the axis spans), the auth/404/422 paths, and that a viewer may print — someone arriving to
relieve the shift needs the sheet they are walking into.
"""

import json
from datetime import UTC, datetime, timedelta

import pytest

from app.zeitplan_pdf import MAX_ROWS, ZeitplanPayload, _window, compose_zeitplan_pdf

T0 = datetime(2026, 7, 26, 12, 0, tzinfo=UTC)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _payload(inc_title: str = "Brand Hauptstrasse 4") -> dict:
    return {
        "incidentTitle": inc_title,
        "incidentAddress": "Hauptstrasse 4",
        "startedAt": _iso(T0),
        "printedAt": _iso(T0 + timedelta(hours=4)),
        "rows": [
            {
                "name": "Meier Anna",
                "rank": "Wm",
                "blocks": [
                    {"from": _iso(T0 + timedelta(hours=2)), "to": _iso(T0 + timedelta(hours=10)), "planned": True},
                    {"from": _iso(T0 + timedelta(hours=2)), "to": _iso(T0 + timedelta(hours=4)), "planned": False},
                ],
            },
            {"name": "Ohne Plan", "blocks": []},
        ],
    }


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _create_incident(client) -> str:
    r = await client.post("/api/incidents", json={"title": "Brand Hauptstrasse 4"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


# --------------------------------------------------------------------------- composer


def test_window_opens_a_full_shift_even_for_an_empty_plan():
    """A fresh plan must not render as a sliver of axis."""
    start, end = _window(ZeitplanPayload(incidentTitle="X", startedAt=T0))
    assert start == T0
    assert (end - start) >= timedelta(hours=12)


def test_window_stretches_to_reach_a_block_planned_into_the_small_hours():
    p = ZeitplanPayload(
        incidentTitle="X",
        startedAt=T0,
        rows=[{"name": "A", "blocks": [{"from": _iso(T0 + timedelta(hours=20)), "to": _iso(T0 + timedelta(hours=26))}]}],
    )
    _, end = _window(p)
    assert end >= T0 + timedelta(hours=26)


def test_window_ends_on_a_whole_hour_so_the_last_column_is_not_a_stub():
    p = ZeitplanPayload(
        incidentTitle="X",
        startedAt=T0,
        rows=[{"name": "A", "blocks": [{"from": _iso(T0), "to": _iso(T0 + timedelta(hours=13, minutes=17))}]}],
    )
    _, end = _window(p)
    assert end.minute == 0 and end.second == 0


def test_window_anchors_on_the_hour_even_from_a_ragged_start():
    start, _ = _window(ZeitplanPayload(incidentTitle="X", startedAt=T0 + timedelta(minutes=43)))
    assert start.minute == 0


def test_compose_renders_a_pdf_and_pads_the_form_out_to_full_pages():
    """A Führungsformular is written on: a two-name plan still prints a full sheet of lanes."""
    small = compose_zeitplan_pdf(ZeitplanPayload.model_validate(_payload()))
    assert small[:5] == b"%PDF-"

    many = _payload()
    many["rows"] = [{"name": f"Person {i}", "blocks": []} for i in range(MAX_ROWS + 3)]
    big = compose_zeitplan_pdf(ZeitplanPayload.model_validate(many))
    assert big[:5] == b"%PDF-"
    assert len(big) > len(small)  # spilled onto a second sheet


def test_compose_survives_an_open_block_and_an_empty_plan():
    """An open presence block (nobody has left yet) and a plan with no rows at all."""
    p = _payload()
    p["rows"][0]["blocks"] = [{"from": _iso(T0), "planned": False}]  # no `to`
    assert compose_zeitplan_pdf(ZeitplanPayload.model_validate(p))[:5] == b"%PDF-"
    assert compose_zeitplan_pdf(ZeitplanPayload(incidentTitle="Leer"))[:5] == b"%PDF-"


# --------------------------------------------------------------------------- endpoint


@pytest.mark.asyncio
async def test_zeitplan_pdf_endpoint(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(f"/api/incidents/{inc}/zeitplan/pdf", data={"payload": json.dumps(_payload())})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:5] == b"%PDF-"
    assert "Zeitplan_" in r.headers.get("content-disposition", "")


@pytest.mark.asyncio
async def test_zeitplan_pdf_is_open_to_a_viewer_coming_to_relieve_the_shift(client, viewer):
    await _login(client, viewer)
    inc_r = await client.get("/api/incidents")
    assert inc_r.status_code == 200
    # a viewer can't create one, so print against a fabricated id → 404, not 403
    r = await client.post(
        "/api/incidents/00000000-0000-0000-0000-000000000000/zeitplan/pdf",
        data={"payload": json.dumps(_payload())},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_zeitplan_pdf_requires_login(client):
    r = await client.post(
        "/api/incidents/00000000-0000-0000-0000-000000000000/zeitplan/pdf",
        data={"payload": json.dumps(_payload())},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_zeitplan_pdf_rejects_a_broken_payload(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(f"/api/incidents/{inc}/zeitplan/pdf", data={"payload": "{not json"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_zeitplan_print_fails_closed_without_a_station_printer(client, editor):
    """No relay configured → no paper, and the client hides the button on the same signal."""
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(f"/api/incidents/{inc}/zeitplan/print", data={"payload": json.dumps(_payload())})
    assert r.status_code == 403

"""Führungsformular «Zeitplan»: the Schichtenplanung as a printable A4-landscape sheet.

The endpoint composes a real PDF from the surface's payload; the layout itself is verified by
eye against the KKO BS / KFS BL form. Covered here: the composer's window maths (which decides
what the axis spans), the auth/404/422 paths, and that a viewer may print — someone arriving to
relieve the shift needs the sheet they are walking into.
"""

import io
import json
from datetime import UTC, datetime, timedelta

import pytest
from PIL import Image as PILImage
from sqlalchemy import select

from app.zeitplan_pdf import MAX_ROWS, MAX_SPAN_H, ZeitplanPayload, _window, compose_zeitplan_pdf

T0 = datetime(2026, 7, 26, 12, 0, tzinfo=UTC)


def _png(w: int = 12, h: int = 8) -> bytes:
    buf = io.BytesIO()
    PILImage.new("RGB", (w, h), (200, 210, 220)).save(buf, "PNG")
    return buf.getvalue()


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
                    {"from": _iso(T0 + timedelta(hours=2)), "to": _iso(T0 + timedelta(hours=10)), "confirmed": True},
                    {"from": _iso(T0 + timedelta(hours=12)), "to": _iso(T0 + timedelta(hours=16)), "confirmed": False},
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
    # printedAt given explicitly: the axis is anchored near the PRINT time now, so leaving it to
    # the wall clock would make this test say something different every day
    start, end = _window(ZeitplanPayload(incidentTitle="X", startedAt=T0, printedAt=T0))
    assert start == T0
    assert (end - start) >= timedelta(hours=12)


def test_window_starts_at_the_alarm_while_the_incident_is_still_young():
    # an incident an hour old is nearer than the look-back, so the sheet still opens at its start
    start, _ = _window(ZeitplanPayload(incidentTitle="X", startedAt=T0, printedAt=T0 + timedelta(hours=1)))
    assert start == T0


def test_window_follows_the_print_time_on_a_deployment_days_old():
    """Day eight of an Elementarereignis: the sheet is about the hours being planned, not about a
    week nobody is planning any more."""
    printed = T0 + timedelta(days=8)
    start, _ = _window(ZeitplanPayload(incidentTitle="X", startedAt=T0, printedAt=printed))
    assert start == (printed - timedelta(hours=2)).replace(minute=0, second=0, microsecond=0)


def test_window_is_capped_so_one_sheet_never_carries_a_week():
    # uncapped, an eight-day span put 384 half-hour rules 0.7mm apart under 192 overlapping labels
    p = ZeitplanPayload(
        incidentTitle="X",
        startedAt=T0,
        printedAt=T0,
        rows=[{"name": "A", "blocks": [{"from": _iso(T0), "to": _iso(T0 + timedelta(days=8))}]}],
    )
    start, end = _window(p)
    assert (end - start) == timedelta(hours=MAX_SPAN_H)


def test_window_stretches_to_reach_a_block_planned_into_the_small_hours():
    p = ZeitplanPayload(
        incidentTitle="X",
        startedAt=T0,
        printedAt=T0,
        rows=[
            {"name": "A", "blocks": [{"from": _iso(T0 + timedelta(hours=20)), "to": _iso(T0 + timedelta(hours=26))}]}
        ],
    )
    _, end = _window(p)
    assert end >= T0 + timedelta(hours=26)


def test_window_ends_on_a_whole_hour_so_the_last_column_is_not_a_stub():
    p = ZeitplanPayload(
        incidentTitle="X",
        startedAt=T0,
        printedAt=T0,
        rows=[{"name": "A", "blocks": [{"from": _iso(T0), "to": _iso(T0 + timedelta(hours=13, minutes=17))}]}],
    )
    _, end = _window(p)
    assert end.minute == 0 and end.second == 0


def test_window_anchors_on_the_hour_even_from_a_ragged_start():
    start, _ = _window(
        ZeitplanPayload(incidentTitle="X", startedAt=T0 + timedelta(minutes=43), printedAt=T0 + timedelta(minutes=43))
    )
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


def test_window_reaches_past_the_plan_to_cover_the_attendance():
    """Somebody stayed three hours longer than anyone planned for. An axis that stopped at the
    last PLANNED block would crop exactly the overrun the sheet is read to find."""
    p = _payload()
    p["rows"] = [
        {
            "name": "A",
            "blocks": [{"from": _iso(T0), "to": _iso(T0 + timedelta(hours=2))}],
            "actual": [{"from": _iso(T0), "to": _iso(T0 + timedelta(hours=20))}],
        }
    ]
    _, end = _window(ZeitplanPayload.model_validate(p))
    assert end >= T0 + timedelta(hours=20)


def test_attendance_is_drawn_on_the_sheet():
    """The recorded attendance reaches the paper. It was deliberately left off once; the sheet is
    read while deciding who to send home, and the plan alone cannot say whether it held."""
    plan_only = _payload()
    plan_only["rows"] = [{"name": "A", "blocks": [{"from": _iso(T0), "to": _iso(T0 + timedelta(hours=2))}]}]
    with_actual = json.loads(json.dumps(plan_only))
    with_actual["rows"][0]["actual"] = [{"from": _iso(T0), "to": _iso(T0 + timedelta(hours=2))}]

    a = compose_zeitplan_pdf(ZeitplanPayload.model_validate(plan_only))
    b = compose_zeitplan_pdf(ZeitplanPayload.model_validate(with_actual))
    assert a[:5] == b"%PDF-" and b[:5] == b"%PDF-"
    # same window, same rows, one extra rule drawn — the page cannot be byte-identical
    assert a != b


def test_an_older_client_that_sends_no_attendance_still_prints():
    """`actual` is defaulted, so a payload from a tab that has not reloaded yet is still valid."""
    p = _payload()
    for row in p["rows"]:
        row.pop("actual", None)
    assert compose_zeitplan_pdf(ZeitplanPayload.model_validate(p))[:5] == b"%PDF-"


def test_compose_survives_an_open_block_and_an_empty_plan():
    """A block with no end yet, and a plan with no rows at all."""
    p = _payload()
    p["rows"][0]["blocks"] = [{"from": _iso(T0)}]  # no `to`
    p["rows"][0]["actual"] = [{"from": _iso(T0)}]  # still here — runs to the print time
    assert compose_zeitplan_pdf(ZeitplanPayload.model_validate(p))[:5] == b"%PDF-"
    assert compose_zeitplan_pdf(ZeitplanPayload(incidentTitle="Leer"))[:5] == b"%PDF-"


def test_compose_prints_a_logo_when_given_one_and_survives_without_it():
    # same letterhead the rapport prints — see report_pdf's own `test_the_station_logo_actually_
    # reaches_the_sheet` for the len(with) > len(without) idiom this mirrors.
    p = ZeitplanPayload.model_validate(_payload())
    without = compose_zeitplan_pdf(p)
    with_logo = compose_zeitplan_pdf(p, logo=_png())
    assert without[:5] == b"%PDF-"
    assert with_logo[:5] == b"%PDF-"
    assert len(with_logo) > len(without)
    # unreadable bytes are never worth failing the sheet over — same as no logo at all
    assert compose_zeitplan_pdf(p, logo=b"not-an-image")[:5] == b"%PDF-"


# --------------------------------------------------------------------------- endpoint


@pytest.mark.asyncio
async def test_zeitplan_pdf_endpoint(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    r = await client.post(f"/api/incidents/{inc}/zeitplan/pdf", data={"payload": json.dumps(_payload())})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:5] == b"%PDF-"
    # named after the SHEET — see zeitplan_filename; the two must not collide in Downloads
    assert "Verfuegbarkeiten_" in r.headers.get("content-disposition", "")


@pytest.mark.asyncio
async def test_the_configured_logo_reaches_the_zeitplan_endpoint(client, editor, db_session):
    """The Schichtplan/Verfügbarkeiten PDFs are a second consumer of the SAME station logo the
    rapport resolves (`api/report.py::_resolve_logo_bytes`), plumbed through the endpoint rather
    than re-resolved inside either composer. End-to-end on purpose, mirroring
    test_report_pdf.py's own `test_the_station_logo_actually_reaches_the_sheet`."""
    from app import storage
    from app.models import DeploymentConfig

    key = "branding/test-logo-zeitplan.png"
    storage.put_bytes(key, _png(120, 60))
    row = (await db_session.execute(select(DeploymentConfig))).scalars().first()
    if row is None:
        row = DeploymentConfig(id=1, config_json={})
        db_session.add(row)
    row.config_json = {**(row.config_json or {}), "identity": {"assets": {"reportLogo": f"/api/branding/file/{key}"}}}
    # `client` serves each request off its OWN session (see conftest's `_override_get_db`) — a
    # flush only makes the row visible inside `db_session`'s own uncommitted transaction, so the
    # endpoint's request would see the config unchanged.
    await db_session.commit()

    await _login(client, editor)
    inc = await _create_incident(client)
    with_logo = await client.post(f"/api/incidents/{inc}/zeitplan/pdf", data={"payload": json.dumps(_payload())})
    assert with_logo.status_code == 200
    assert with_logo.content[:5] == b"%PDF-"

    row.config_json = {**(row.config_json or {}), "identity": {"assets": {}}}
    await db_session.commit()
    without_logo = await client.post(f"/api/incidents/{inc}/zeitplan/pdf", data={"payload": json.dumps(_payload())})
    assert without_logo.status_code == 200
    assert len(with_logo.content) > len(without_logo.content)


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


def test_sheet_prints_the_station_clock_not_utc():
    """The client sends UTC (`toISOString()`); the sheet must print Europe/Zurich.

    Rendering the aware datetime straight put the whole Führungsformular two hours out in summer
    — on the paper you hang at the front, where nobody can tell it is wrong.
    """
    from app.zeitplan_pdf import ZeitplanPayload

    p = ZeitplanPayload.model_validate(
        {
            "incidentTitle": "X",
            "startedAt": "2026-07-27T04:00:00.000Z",  # 06:00 CEST
            "rows": [{"name": "A", "blocks": [{"from": "2026-07-27T04:00:00.000Z", "to": "2026-07-27T12:00:00.000Z"}]}],
        }
    )
    assert p.startedAt.strftime("%H:%M") == "06:00"
    assert p.rows[0].blocks[0].start.strftime("%H:%M") == "06:00"
    assert p.rows[0].blocks[0].end.strftime("%H:%M") == "14:00"
    # and in winter, one hour
    w = ZeitplanPayload.model_validate({"incidentTitle": "X", "startedAt": "2026-01-15T04:00:00.000Z"})
    assert w.startedAt.strftime("%H:%M") == "05:00"

"""Führungsformular «Schichtplan»: the watches across the top, the names down the side.

The second of the two sheets, and the only one that needs bands. The layout itself is verified by
eye; covered here is everything a wrong answer would be invisible on paper: which cell a shift
lands in (STORED membership, never matching clocks), what a drifted shift prints, how the Deckung
line counts, and that the endpoint dispatches to this composer rather than the other one.
"""

import json
from datetime import UTC, datetime, timedelta

import pytest

from app.schichtplan_pdf import (
    _MARK_AVAILABLE,
    _MARK_CONFIRMED,
    MAX_ROWS,
    _band_title,
    _cell,
    _deckung,
    compose_schichtplan_pdf,
)
from app.zeitplan_pdf import ZeitplanPayload

T0 = datetime(2026, 7, 26, 7, 0, tzinfo=UTC)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _h(n: int) -> str:
    return _iso(T0 + timedelta(hours=n))


#: Früh, five hours long — the band every assertion below is about
FRÜH = {"id": "bd1", "label": "Früh", "from": _h(0), "to": _h(5)}
SPÄT = {"id": "bd2", "label": "", "from": _h(5), "to": _h(10)}


def _payload(rows: list[dict], bands: list[dict] | None = None) -> ZeitplanPayload:
    return ZeitplanPayload.model_validate(
        {
            "sheet": "schichtplan",
            "incidentTitle": "Brand Hauptstrasse 4",
            "startedAt": _h(0),
            "printedAt": _h(2),
            "bands": [FRÜH, SPÄT] if bands is None else bands,
            "rows": rows,
        }
    )


def _row(name: str, blocks: list[dict], rank: str | None = None) -> dict:
    return {"name": name, "blocks": blocks, "actual": [], **({"rank": rank} if rank else {})}


def test_a_cell_is_filled_by_stored_membership_and_never_by_matching_clocks():
    # the whole design in one assertion: this person's times are EXACTLY the band's, but the shift
    # was drawn freihändig on the axis and carries no bandId — so the column stays empty
    p = _payload([_row("Meier Anna", [{"from": _h(0), "to": _h(5), "confirmed": True}])])
    assert _cell(p.rows[0], p.bands[0]) == ""


def test_the_two_on_band_states_get_the_two_marks():
    p = _payload(
        [
            _row("Fix", [{"from": _h(0), "to": _h(5), "confirmed": True, "bandId": "bd1"}]),
            _row("Frei", [{"from": _h(0), "to": _h(5), "confirmed": False, "bandId": "bd1"}]),
        ]
    )
    assert _cell(p.rows[0], p.bands[0]) == _MARK_CONFIRMED
    assert _cell(p.rows[1], p.bands[0]) == _MARK_AVAILABLE


def test_a_drifted_shift_prints_its_real_time_instead_of_a_mark():
    # the same thing the on-screen cell shows, so paper and tablet read alike
    p = _payload([_row("Aebischer", [{"from": _h(2), "to": _h(7), "confirmed": True, "bandId": "bd1"}])])
    assert _cell(p.rows[0], p.bands[0]) == "11–16"  # station clock, not UTC — see test_zeitplan_pdf


def test_deckung_counts_the_two_states_apart_and_drifted_shifts_pro_rata():
    # Aebischer covers three of Früh's five hours → 1 + 0.6 assigned, and one offer beside it
    p = _payload(
        [
            _row("Fix", [{"from": _h(0), "to": _h(5), "confirmed": True, "bandId": "bd1"}]),
            _row("Aebischer", [{"from": _h(2), "to": _h(7), "confirmed": True, "bandId": "bd1"}]),
            _row("Frei", [{"from": _h(0), "to": _h(5), "confirmed": False, "bandId": "bd1"}]),
        ]
    )
    assert _deckung(p.rows, p.bands[0]) == "1 / 1,6"


def test_deckung_ignores_shifts_of_another_band_and_of_none():
    p = _payload(
        [
            _row("A", [{"from": _h(0), "to": _h(5), "confirmed": True, "bandId": "bd2"}]),
            _row("B", [{"from": _h(0), "to": _h(5), "confirmed": True}]),
        ]
    )
    assert _deckung(p.rows, p.bands[0]) == "0 / 0"


def test_an_unnamed_band_is_titled_by_its_own_hours():
    # the label is optional on the surface — creating a band is never blocked by an empty field
    p = _payload([])
    assert _band_title(p.bands[0]) == "Früh"
    assert _band_title(p.bands[1]) == "14–19"


def test_compose_renders_a_pdf_and_pads_the_sheet_out_to_full_pages():
    rows = [_row(f"Person {i}", [{"from": _h(0), "to": _h(5), "confirmed": True, "bandId": "bd1"}]) for i in range(40)]
    pdf = compose_schichtplan_pdf(_payload(rows))
    assert pdf.startswith(b"%PDF")
    # 40 names over a 28-row sheet is two pages; both are padded out, because an empty row is
    # where the pen goes when the battery dies
    assert MAX_ROWS < 40
    assert b"/Count 2" in pdf or pdf.count(b"/Type /Page\n") >= 2


def test_compose_says_so_rather_than_drawing_an_empty_table_without_bands():
    # unreachable from the surface (the menu withholds this sheet without bands) but a payload can
    # always be posted directly
    pdf = compose_schichtplan_pdf(_payload([_row("Meier Anna", [])], bands=[]))
    assert pdf.startswith(b"%PDF")


def test_compose_survives_a_block_with_no_end():
    p = _payload([_row("Meier Anna", [{"from": _h(0), "confirmed": True, "bandId": "bd1"}])])
    assert compose_schichtplan_pdf(p).startswith(b"%PDF")


# ---- the endpoint dispatches on the sheet -------------------------------------------------


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _create_incident(client) -> str:
    r = await client.post("/api/incidents", json={"title": "Brand Hauptstrasse 4"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.mark.asyncio
async def test_the_endpoint_composes_the_schichtplan_and_names_the_file_after_it(client, editor):
    await _login(client, editor)
    inc = await _create_incident(client)
    body = {
        "sheet": "schichtplan",
        "incidentTitle": "Brand Hauptstrasse 4",
        "printedAt": _h(2),
        "bands": [FRÜH],
        "rows": [_row("Meier Anna", [{"from": _h(0), "to": _h(5), "confirmed": True, "bandId": "bd1"}])],
    }
    r = await client.post(f"/api/incidents/{inc}/zeitplan/pdf", data={"payload": json.dumps(body)})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    # the two sheets must not arrive in the same file name — one overwrites the other in Downloads
    assert "Schichtplan_" in r.headers["content-disposition"]
    assert r.content.startswith(b"%PDF")


@pytest.mark.asyncio
async def test_a_payload_without_a_sheet_still_gets_the_availability_form(client, editor):
    # every client from before the split meant that one, and it is the sheet that exists anyway
    await _login(client, editor)
    inc = await _create_incident(client)
    body = {"incidentTitle": "Brand Hauptstrasse 4", "printedAt": _h(2), "rows": []}
    r = await client.post(f"/api/incidents/{inc}/zeitplan/pdf", data={"payload": json.dumps(body)})
    assert r.status_code == 200, r.text
    assert "Verfuegbarkeiten_" in r.headers["content-disposition"]

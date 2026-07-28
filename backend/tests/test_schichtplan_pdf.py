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


def test_a_column_reads_the_state_of_the_shift_that_covers_it():
    # geplant across this window, filed under no band — still geplant. Reported 28.07.: it printed
    # as «verfügbar», which is the sheet disagreeing with the plan.
    p = _payload([_row("Meier Anna", [{"from": _h(0), "to": _h(5), "confirmed": True}])])
    assert _cell(p.rows[0], p.bands[0]) == _MARK_CONFIRMED
    q = _payload([_row("Meier Anna", [{"from": _h(0), "to": _h(5), "confirmed": False}])])
    assert _cell(q.rows[0], q.bands[0]) == _MARK_AVAILABLE


def test_a_cell_is_empty_only_when_nothing_reaches_the_window():
    p = _payload([_row("Meier Anna", [{"from": _h(6), "to": _h(9), "confirmed": True}])])
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


def test_a_partly_covering_shift_prints_its_hours_clamped_to_the_column():
    # Früh runs 09–14 (station clock); the person offered 11–16, so this column is about 11–14 —
    # printing «11–16» answers a question this column did not ask
    p = _payload([_row("Aebischer", [{"from": _h(2), "to": _h(7), "confirmed": True, "bandId": "bd1"}])])
    assert _cell(p.rows[0], p.bands[0]) == "11:00–14:00"


def test_a_member_dragged_clear_of_its_band_leaves_its_column_empty():
    # reported 28.07.: «20:30–21» printed inside a 12–17 watch and counted as one assigned person
    # covering none of it. Membership means «in this window»; once the window moved on, so did the
    # cell — and the count with it.
    p = _payload([_row("Weg", [{"from": _h(6), "to": _h(9), "confirmed": True, "bandId": "bd1"}])])
    assert _cell(p.rows[0], p.bands[0]) == ""
    assert _deckung(p.rows, p.bands[0]) == "0"


def test_deckung_counts_whole_people_and_only_the_assigned():
    # ONE number, and a WHOLE one: «1,6» is not a headcount, and this line has to be checkable by
    # counting the marks in the column above it.
    p = _payload(
        [
            _row("Fix", [{"from": _h(0), "to": _h(5), "confirmed": True, "bandId": "bd1"}]),
            _row("Aebischer", [{"from": _h(2), "to": _h(7), "confirmed": True, "bandId": "bd1"}]),
            _row("Frei", [{"from": _h(0), "to": _h(5), "confirmed": False, "bandId": "bd1"}]),
        ]
    )
    # …and the «·»: Aebischer covers only three of the five hours, so «2» alone would say two
    # people are on this watch when the first hours have one
    assert _deckung(p.rows, p.bands[0]) == "2·"


def test_deckung_counts_an_assignment_that_covers_this_window_wherever_it_is_filed():
    p = _payload(
        [
            _row("A", [{"from": _h(0), "to": _h(5), "confirmed": True, "bandId": "bd2"}]),
            _row("B", [{"from": _h(0), "to": _h(5), "confirmed": True}]),
            _row("C", [{"from": _h(0), "to": _h(5), "confirmed": False}]),  # only available
        ]
    )
    assert _deckung(p.rows, p.bands[0]) == "2"


def test_deckung_counts_one_person_once_however_many_offers_they_hold():
    # one cell is one count — otherwise the line says two where the sheet shows one
    p = _payload(
        [
            _row(
                "A",
                [
                    {"from": _h(0), "to": _h(5), "confirmed": True, "bandId": "bd1"},
                    {"from": _h(-1), "to": _h(6), "confirmed": False},
                ],
            )
        ]
    )
    assert _deckung(p.rows, p.bands[0]) == "1"


def test_the_sheet_lists_only_the_people_who_were_actually_assigned():
    from app.schichtplan_pdf import _is_assigned

    assigned = _row("Fix", [{"from": _h(0), "to": _h(5), "confirmed": True, "bandId": "bd1"}])
    offered = _row("Frei", [{"from": _h(0), "to": _h(5), "confirmed": False, "bandId": "bd1"}])
    # geplant across the window, filed under no band — on the watch all the same
    covering = _row("Deckt", [{"from": _h(-1), "to": _h(6), "confirmed": True}])
    p = _payload([assigned, offered, covering])
    assert [_is_assigned(r, p.bands) for r in p.rows] == [True, False, True]
    # …and the sheet still composes, now as a shorter one
    assert compose_schichtplan_pdf(p).startswith(b"%PDF")


def test_a_sheet_with_nobody_assigned_yet_still_carries_the_crew_to_write_on():
    # an empty page helps no one: before the first assignment this is a blank form
    from app.schichtplan_pdf import _is_assigned

    p = _payload([_row("Frei", [{"from": _h(0), "to": _h(5), "confirmed": False, "bandId": "bd1"}])])
    assert not any(_is_assigned(r, p.bands) for r in p.rows)
    assert compose_schichtplan_pdf(p).startswith(b"%PDF")


def test_an_unnamed_band_is_titled_by_its_own_hours():
    # the label is optional on the surface — creating a band is never blocked by an empty field
    p = _payload([])
    assert _band_title(p.bands[0]) == "Früh"
    assert _band_title(p.bands[1]) == "14:00–19:00"


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

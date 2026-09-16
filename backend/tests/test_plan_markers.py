"""The § grammar a plan author writes on the sheet, and what a document of them adds up to."""

from dataclasses import replace
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path

import pytest
from reportlab.pdfgen.canvas import Canvas
from sqlalchemy import select

from app.models import ObjectSite
from app.plan_floors import PlanFloor
from app.plan_markers import (
    admin_overrides,
    apply_overrides,
    extract_markers,
    marker_snapshot,
    parse_tag,
    read_plan,
    report,
)
from app.plan_markers import text as marker_text

#: the docs agent's reference export (docs/plan-markers/) – a real Affinity-shaped PDF, not one
#: this test drew itself. Absent in a stripped checkout; the generated fixtures cover the rest.
SAMPLE = Path(__file__).resolve().parents[2] / "docs" / "plan-markers" / "sample-modul6.pdf"

PAGE = (842, 595)  # A4 landscape, points


def _pdf(pages: list[list[tuple[float, float, str]]], size: tuple[float, float] = PAGE) -> bytes:
    """Pages of (x, y, text) in POINTS from the bottom-left – the frame markers are written in."""
    buf = BytesIO()
    canvas = Canvas(buf, pagesize=size)
    for page in pages:
        canvas.setFont("Helvetica", 6)
        for x, y, text in page:
            canvas.drawString(x, y, text)
        canvas.showPage()
    canvas.save()
    return buf.getvalue()


# ---------------------------------------------------------------------------------------
# the grammar
# ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("tag", "expected"),
    [
        ("§EG", {"kind": "floor", "index": 0, "dach": False, "label": "A", "name": None}),
        ("§eg", {"kind": "floor", "index": 0, "dach": False, "label": "A", "name": None}),
        ("§0", {"kind": "floor", "index": 0, "dach": False, "label": "A", "name": None}),
        ("§1OG", {"kind": "floor", "index": 1, "dach": False, "label": "A", "name": None}),
        ("§ 2 og ", {"kind": "floor", "index": 2, "dach": False, "label": "A", "name": None}),
        ("§2UG", {"kind": "floor", "index": -2, "dach": False, "label": "A", "name": None}),
        ("§+1", {"kind": "floor", "index": 1, "dach": False, "label": "A", "name": None}),
        ("§-1", {"kind": "floor", "index": -1, "dach": False, "label": "A", "name": None}),
        # DG is «one above the top storey», so its index waits for the rest of the sheet
        ("§DG", {"kind": "floor", "index": None, "dach": True, "label": "A", "name": "DG"}),
        ("§0 Erdgeschoss", {"kind": "floor", "index": 0, "dach": False, "label": "A", "name": "Erdgeschoss"}),
        ("§-1 Tiefgarage", {"kind": "floor", "index": -1, "dach": False, "label": "A", "name": "Tiefgarage"}),
        ("§[EG", {"kind": "corner_tl", "index": 0, "dach": False}),
        ("§1OG]", {"kind": "corner_br", "index": 1, "dach": False}),
    ],
)
def test_the_grammar_is_case_and_whitespace_tolerant(tag, expected):
    assert parse_tag(tag) == expected


def test_geo_reads_lv95_or_wgs84_by_magnitude():
    lv95 = parse_tag("§GEO 2612345.6 1264321.2")
    wgs = parse_tag("§geo  47.529508 7.602574")
    assert lv95 is not None and wgs is not None
    assert lv95["kind"] == wgs["kind"] == "geo"
    # the same point, said both ways – the swisstopo approximation is metre-accurate
    assert lv95["lat"] == pytest.approx(wgs["lat"], abs=1e-5)
    assert lv95["lng"] == pytest.approx(wgs["lng"], abs=1e-5)


@pytest.mark.parametrize("tag", ["§", "§Keller", "§GEO 2612345.6", "§GEO nord ost", "§[", "§2XG", "§GEO 999 999"])
def test_a_tag_the_grammar_rejects_is_never_guessed_at(tag):
    assert parse_tag(tag) is None


@pytest.mark.parametrize(
    ("tag", "expected"),
    [
        ("§1OG.B", {"kind": "floor", "index": 1, "dach": False, "label": "B", "name": None}),
        ("§eg.b", {"kind": "floor", "index": 0, "dach": False, "label": "B", "name": None}),
        ("§EG.T2", {"kind": "floor", "index": 0, "dach": False, "label": "T2", "name": None}),
        ("§DG.B", {"kind": "floor", "index": None, "dach": True, "label": "B", "name": "DG"}),
        # the label ends the STOREY TOKEN; the display name still starts after the space
        ("§1OG.B Nordtreppe", {"kind": "floor", "index": 1, "dach": False, "label": "B", "name": "Nordtreppe"}),
        # …so a name that happens to contain a dot is a name, not a label
        ("§0 1. Stock", {"kind": "floor", "index": 0, "dach": False, "label": "A", "name": "1. Stock"}),
    ],
)
def test_a_point_label_follows_the_storey_token_and_never_eats_the_name(tag, expected):
    assert parse_tag(tag) == expected


@pytest.mark.parametrize("tag", ["§1OG.", "§.B", "§1OG.Verbindungspunkt", "§[1OG.B", "§1OG.B]"])
def test_a_label_the_grammar_rejects_is_never_guessed_at(tag):
    """A label is 1–8 letters/digits on a STOREY tag – a region corner has one point, not two."""
    assert parse_tag(tag) is None


# ---------------------------------------------------------------------------------------
# off a real page
# ---------------------------------------------------------------------------------------


def test_the_point_is_the_text_box_centre_in_normalized_y_down_coordinates():
    # one tag, centred on the page: 0.5/0.5 whichever way the PDF counts its own axes
    markers = extract_markers(_pdf([[(421 - 6, 297 - 2, "§EG")]]))
    assert len(markers) == 1
    assert markers[0].x == pytest.approx(0.5, abs=0.02)
    assert markers[0].y == pytest.approx(0.5, abs=0.02)
    # …and the top of the page is y = 0, not y = 1
    top = extract_markers(_pdf([[(60, 560, "§EG")]]))[0]
    assert top.y < 0.15


def test_a_marker_keeps_its_name_and_stops_where_the_sheet_s_own_text_begins():
    markers = extract_markers(_pdf([[(60, 300, "§0 Erdgeschoss"), (500, 300, "Massstab 1:500")]]))
    assert [m.text for m in markers] == ["§0 Erdgeschoss"]
    assert markers[0].name == "Erdgeschoss"


def test_an_unreadable_tag_is_reported_rather_than_dropped():
    plan = read_plan(_pdf([[(60, 300, "§EG"), (60, 260, "§Keller")]]))
    assert plan is not None and [f.index for f in plan.floors] == [0]
    assert plan.warnings == [{"code": "unknown_tag", "tag": "§Keller", "page": 1}]


# ---------------------------------------------------------------------------------------
# …and what a document of them adds up to
# ---------------------------------------------------------------------------------------


def test_one_floor_per_page_joins_every_storey_to_the_ground_floor():
    plan = read_plan(_pdf([[(200, 300, "§1UG")], [(210, 310, "§EG")], [(220, 320, "§1OG")], [(230, 330, "§DG")]]))
    assert plan is not None
    assert [(f.index, f.page) for f in plan.floors] == [(-1, 0), (0, 1), (1, 2), (2, 3)]
    assert plan.fit_page == 1  # the level-0 drawing's page, not page 0
    ground = next(f for f in plan.floors if f.index == 0)
    assert ground.join is None and ground.clip is None  # the reference joins nothing
    # the tag centres themselves are the point pair: «my staircase is the ground floor's»
    markers = {m.index: [m.x, m.y] for m in extract_markers(_pdf([[(200, 300, "§EG")], [(210, 310, "§1OG")]]))}
    for floor in plan.floors:
        if floor.index == 0:
            continue
        assert floor.join is not None and floor.join["to"] == 0
        assert floor.join["at"] != floor.join["there"]  # a different spot on a different drawing
        assert floor.join["there"] == next(f.join["there"] for f in plan.floors if f.index != 0)
    assert markers[0] != markers[1]
    assert plan.warnings == []


def test_an_unlabelled_tag_states_point_a_so_a_labelled_sheet_may_mix_the_two():
    """Backward compatibility, said as grammar: every sheet drawn before labels existed says
    «every floor meets every other at A», which is the one staircase it always meant."""
    plan = read_plan(_pdf([[(200, 300, "§EG")], [(210, 310, "§1OG.A")]]))
    assert plan is not None and plan.warnings == []
    assert next(f for f in plan.floors if f.index == 1).join["to"] == 0


def test_a_floor_may_state_several_points_and_the_chain_walks_them():
    """Bastian, 15.09.: «the alignment between storeys should allow for multiple if there isn't
    one point that joins all of them». EG–1OG at A, 1OG–2OG at B – one frame, two staircases."""
    pages = [[(200, 300, "§EG.A")], [(200, 300, "§1OG.A"), (500, 200, "§1OG.B")], [(500, 200, "§2OG.B")]]
    plan = read_plan(_pdf(pages))
    assert plan is not None and plan.warnings == []
    first = next(f for f in plan.floors if f.index == 1)
    second = next(f for f in plan.floors if f.index == 2)
    assert first.join["to"] == 0 and second.join["to"] == 1  # a chain, not a star
    # …and the 2. OG hangs on the 1. OG's B point, not on the A point it also carries
    points = {(m.index, m.label): m.point for m in extract_markers(_pdf(pages)) if m.kind == "floor"}
    assert second.join["at"] == points[(2, "B")] and second.join["there"] == points[(1, "B")]
    assert first.join["there"] == points[(0, "A")]


def test_a_floor_joins_the_reference_itself_over_the_storey_below_it():
    """One hop accumulates no error, so a shared point with level 0 beats the floor between –
    which is also why a sheet that labels nothing keeps the star it has always produced."""
    pages = [[(200, 300, "§EG.A")], [(200, 300, "§1OG.A")], [(200, 300, "§2OG.A"), (500, 200, "§2OG.B")]]
    plan = read_plan(_pdf(pages))
    assert plan is not None and plan.warnings == []
    assert [f.join["to"] for f in plan.floors if f.index != 0] == [0, 0]


def test_without_the_reference_s_point_a_floor_takes_the_storey_one_step_nearer_it():
    pages = [
        [(200, 300, "§1UG.C")],
        [(200, 300, "§EG.A"), (500, 200, "§EG.C")],
        [(200, 300, "§1OG.A"), (500, 200, "§1OG.B")],
        [(500, 200, "§2OG.B"), (600, 100, "§2OG.Z")],
        [(600, 100, "§3OG.Z")],
    ]
    plan = read_plan(_pdf(pages))
    assert plan is not None and plan.warnings == []
    assert {f.index: f.join["to"] for f in plan.floors if f.index != 0} == {-1: 0, 1: 0, 2: 1, 3: 2}


def test_a_floor_that_shares_no_point_with_the_chain_is_named_and_left_unjoined():
    plan = read_plan(_pdf([[(200, 300, "§EG.A")], [(200, 300, "§1OG.A")], [(200, 300, "§2OG.Z")]]))
    assert plan is not None
    assert next(f for f in plan.floors if f.index == 2).join is None
    assert {"code": "no_shared_join", "storey": 2} in plan.warnings
    # a pair that closes on itself never reaches the ground either, and says so the same way
    island = read_plan(_pdf([[(200, 300, "§EG.A")], [(200, 300, "§1OG.Z")], [(200, 300, "§2OG.Z")]]))
    assert island is not None and all(f.join is None for f in island.floors)
    assert [w["storey"] for w in island.warnings if w["code"] == "no_shared_join"] == [1, 2]


def test_the_same_point_marked_twice_on_one_storey_keeps_the_first_and_names_the_label():
    pages = [[(200, 300, "§EG.A")], [(200, 300, "§1OG.A"), (400, 200, "§1OG.B"), (600, 100, "§1OG.B")]]
    plan = read_plan(_pdf(pages))
    assert plan is not None
    assert {"code": "duplicate_storey", "storey": 1, "label": "B", "tag": "§1OG.B", "page": 2} in plan.warnings


def test_dach_sits_one_above_the_top_storey_it_shares_the_sheet_with():
    two = read_plan(_pdf([[(200, 300, "§EG")], [(200, 300, "§1OG")], [(200, 300, "§DG")]]))
    alone = read_plan(_pdf([[(200, 300, "§EG")], [(200, 300, "§DG")]]))
    assert two is not None and alone is not None
    assert [f.index for f in two.floors] == [0, 1, 2]
    assert [f.index for f in alone.floors] == [0, 1]
    # its index cannot say «Dachgeschoss», so the marker names it
    assert next(f for f in two.floors if f.index == 2).name == "DG"


def test_region_corners_of_one_a0_sheet_become_the_clips():
    plan = read_plan(
        _pdf(
            [
                [
                    (60, 540, "§[EG"),
                    (200, 300, "§EG"),
                    (400, 40, "§EG]"),
                    (450, 540, "§[1OG"),
                    (600, 300, "§1OG"),
                    (800, 40, "§1OG]"),
                ]
            ]
        )
    )
    assert plan is not None and plan.warnings == []
    ground = next(f for f in plan.floors if f.index == 0)
    assert ground.clip is not None
    x0, y0, x1, y1 = ground.clip
    assert 0 < x0 < x1 < 0.55 and 0 < y0 < y1 < 1  # the left half of the sheet, top to bottom
    assert next(f for f in plan.floors if f.index == 1).clip[0] > x1  # …the right half


def test_a_lone_region_corner_costs_that_region_and_nothing_else():
    plan = read_plan(_pdf([[(60, 540, "§[EG"), (200, 300, "§EG")], [(600, 300, "§1OG")]]))
    assert plan is not None
    assert [f.index for f in plan.floors] == [0, 1] and all(f.clip is None for f in plan.floors)
    # the warning names the tag the author has to ADD, in the spelling they used for its twin
    assert {
        "code": "corner_missing",
        "storey": 0,
        "tag": "§EG]",
        "have": "§[EG",
        "side": "br",
        "page": 1,
    } in plan.warnings


def test_a_corner_left_outside_the_page_names_the_tag_instead_of_condemning_the_pack():
    """Allschwilerstrasse 100, 16.09.2026: a «§[EG» left in the template sat off the sheet and a
    «§4OG]» was never drawn, so the export produced NO floors and the admin saw «Vorschlag
    bereit» with an empty Geschoss list. Both are now named, tag by tag."""
    plan = read_plan(
        _pdf([[(-30, 300, "§[EG"), (200, 300, "§EG"), (400, 40, "§EG]"), (500, 300, "§1OG"), (520, 540, "§[1OG")]])
    )
    assert plan is not None and plan.floors == [] and plan.storeys == 2
    codes = [w["code"] for w in plan.warnings]
    assert codes == ["region_off_page", "corner_missing", "corner_missing", "pack_invalid"]
    off = plan.warnings[0]
    assert off["tag"] == "§[EG" and off["axis"] == "x" and off["value"] < 0
    # the corner that is LEFT alone is the one the author still has to pair up
    assert plan.warnings[1]["tag"] == "§[EG" and plan.warnings[1]["have"] == "§EG]"
    assert plan.warnings[2]["tag"] == "§1OG]" and plan.warnings[2]["have"] == "§[1OG"


def test_every_warning_code_says_itself_in_german():
    """`text()` is what the CLI prints and the worker logs – the admin UI renders the same codes
    through its own copy, so a code without a sentence here is a code nobody can read."""
    from app.plan_markers import _SAID, WarningCode

    assert set(_SAID) == set(WarningCode.__args__)
    said = marker_text(
        {"code": "corner_missing", "storey": 4, "tag": "§4OG]", "have": "§[4OG", "side": "br", "page": 1}
    )
    assert said.startswith("§4OG]: Ecke unten rechts fehlt – §[4OG hat kein Gegenstück")
    assert marker_text({"code": "no_shared_join", "storey": -1}) == (
        "Ebene -1: kein gemeinsamer Verbindungspunkt mit den übrigen Geschossen."
    )
    # a code the renderer has never heard of prints itself rather than breaking the dry run
    assert marker_text({"code": "nonsense"}) == "nonsense"  # type: ignore[typeddict-item]


def test_a_one_sheet_pack_whose_region_is_incomplete_proposes_no_pack_at_all():
    """Two storeys on ONE page are two regions; without them they would be the same drawing
    twice, which `validate_floors` refuses – the same rule the admin's own PUT is held to."""
    plan = read_plan(_pdf([[(60, 540, "§[EG"), (200, 300, "§EG"), (600, 300, "§1OG")]]))
    assert plan is not None and plan.floors == []
    invalid = next(w for w in plan.warnings if w["code"] == "pack_invalid")
    assert invalid["detail"] == "Eine ganze Seite kann nur ein Geschoss sein"
    assert plan.storeys == 2  # what the markers DECLARED, even though none of it was proposed


def test_two_geo_markers_on_the_fit_page_are_the_fit():
    plan = read_plan(
        _pdf(
            [
                [(200, 300, "§EG"), (60, 540, "§GEO 2612345.6 1264321.2"), (700, 60, "§GEO 47.51470 7.55470")],
                [(200, 300, "§1OG"), (60, 540, "§GEO 2612345.6 1264321.2")],
            ]
        )
    )
    assert plan is not None and plan.fit_page == 0
    assert len(plan.pairs) == 2
    assert {p["kind"] for p in plan.pairs} == {"gesetzt"}
    assert plan.pairs[1]["lngLat"] == {"lng": 7.55470, "lat": 47.51470}
    assert all(0 <= p["plan"]["x"] <= 1 and 0 <= p["plan"]["y"] <= 1 for p in plan.pairs)
    # the pack has ONE fit, measured on the level-0 drawing – the 1. OG's §GEO says nothing
    assert {"code": "geo_off_fit_page", "count": 1, "page": 1} in plan.warnings


def test_a_single_geo_marker_proposes_no_fit_at_all():
    plan = read_plan(_pdf([[(200, 300, "§EG"), (60, 540, "§GEO 2612345.6 1264321.2")]]))
    assert plan is not None and plan.pairs == []
    assert {"code": "geo_single", "page": 1} in plan.warnings


def test_a_storey_marked_twice_keeps_the_first_and_says_so():
    plan = read_plan(_pdf([[(200, 300, "§EG")], [(200, 300, "§EG")], [(200, 300, "§1OG")]]))
    assert plan is not None
    assert [(f.index, f.page) for f in plan.floors] == [(0, 0), (1, 2)]
    assert {"code": "duplicate_storey", "storey": 0, "label": "A", "tag": "§EG", "page": 2} in plan.warnings


def test_without_a_level_zero_the_fit_page_is_the_lowest_storey_above_ground():
    plan = read_plan(_pdf([[(200, 300, "§2OG")], [(200, 300, "§1OG")]]))
    assert plan is not None and plan.fit_page == 1
    assert {"code": "no_level_zero"} in plan.warnings
    # …and page 0 is a page like any other when it is the one that qualifies
    first = read_plan(_pdf([[(200, 300, "§1OG")], [(200, 300, "§2OG")]]))
    assert first is not None and first.fit_page == 0


def test_an_unmarked_pdf_proposes_nothing():
    assert read_plan(_pdf([[(200, 300, "Grundriss Erdgeschoss"), (200, 260, "Massstab 1:500")]])) is None


# ---------------------------------------------------------------------------------------
# the admin's own edits, across a re-export
# ---------------------------------------------------------------------------------------


def test_an_admin_edit_is_what_differs_from_that_revision_s_own_proposal():
    proposed = PlanFloor(0, 0, None, [0.1, 0.1, 0.5, 0.5], None)
    stored = [
        # the admin typed a name and dragged the region; the join is still the marker's
        PlanFloor(0, 0, "Hauptebene", [0.12, 0.1, 0.5, 0.5], None, marker_snapshot(proposed, 3)),
        PlanFloor(1, 1, None, None, None, marker_snapshot(PlanFloor(1, 1, None, None, None), 3)),
    ]
    assert admin_overrides(stored) == {(0, 0): {"name": "Hauptebene", "clip": [0.12, 0.1, 0.5, 0.5]}}
    # a pack no markers ever made is the admin's, field for field
    assert admin_overrides([PlanFloor(0, 0, "EG", None, None)]) == {(0, 0): {"name": "EG"}}


def test_the_marker_wins_where_it_moved_and_the_admin_wins_where_they_edited():
    proposed = [
        PlanFloor(0, 0, "Neu", [0.2, 0.2, 0.9, 0.9], None),  # the export moved the region…
        PlanFloor(1, 1, None, None, {"to": 0, "at": [0.4, 0.4], "there": [0.3, 0.3]}),  # …and the join
    ]
    merged = apply_overrides(proposed, {(0, 0): {"name": "Hauptebene"}})
    assert merged[0].name == "Hauptebene"  # the admin typed this – it survives the re-export
    assert merged[0].clip == [0.2, 0.2, 0.9, 0.9]  # untouched by the admin, so the marker wins
    assert merged[1].join == {"to": 0, "at": [0.4, 0.4], "there": [0.3, 0.3]}
    # an override for a storey the new export dropped goes with it: structure is the export's
    assert apply_overrides(proposed, {(7, 0): {"name": "Dach"}}) == proposed
    # …and a carried join pointing at a storey that is gone is not a join any more
    orphan = apply_overrides([proposed[1]], {(1, 0): {"join": {"to": 4, "at": [0.1, 0.1], "there": [0.2, 0.2]}}})
    assert orphan[0].join is None


# ---------------------------------------------------------------------------------------
# the plan author's dry run, on the reference export
# ---------------------------------------------------------------------------------------


def test_the_dry_run_prints_the_storey_a_dach_marker_ended_up_at(tmp_path):
    """The tag list is printed RESOLVED: a «§DG» carries no index until the whole sheet has been
    read, and the CLI has to print the storey it landed on rather than format a None."""
    pdf = tmp_path / "Modul 6.pdf"
    pdf.write_bytes(_pdf([[(200, 300, "§EG")], [(60, 540, "§[DG"), (200, 300, "§DG"), (400, 40, "§DG]")]]))
    printed = report(pdf)
    assert "floor     storey +1 «DG»" in printed
    assert "corner_tl region top-left of storey +1" in printed
    assert "2 storey(s), fit page 1" in printed and "no warnings" in printed


@pytest.mark.skipif(not SAMPLE.is_file(), reason="docs/plan-markers/sample-modul6.pdf not in this checkout")
def test_the_reference_export_reads_exactly_as_documented():
    """docs/plan-markers/README.md states these numbers – the parser and the docs agree here."""
    markers = {m.text: (round(m.x, 4), round(m.y, 4)) for m in extract_markers(SAMPLE.read_bytes())}
    assert markers == {
        "§[EG": (0.0285, 0.1115),
        "§GEO 2612345.6 1264321.2": (0.0714, 0.8152),
        "§EG": (0.2381, 0.4953),
        "§GEO 2612415.6 1264411.2": (0.4047, 0.2091),
        "§EG]": (0.4476, 0.9128),
        "§[1OG": (0.5285, 0.1115),
        "§1OG": (0.7381, 0.4953),
        "§1OG]": (0.9476, 0.9128),
    }
    plan = read_plan(SAMPLE.read_bytes())
    assert plan is not None and plan.warnings == []
    assert [f.index for f in plan.floors] == [0, 1] and plan.fit_page == 0
    assert all(f.clip is not None for f in plan.floors)
    assert len(plan.pairs) == 2
    # 70 m east and 90 m north apart, as the sample's own comment says
    a, b = (p["lngLat"] for p in plan.pairs)
    assert (b["lat"] - a["lat"]) * 111_320 == pytest.approx(90, abs=1)

    printed = report(SAMPLE)
    assert "8 marker(s)" in printed and "2 storey(s), fit page 1, 2 map pair(s)" in printed
    assert "no warnings" in printed


# ---------------------------------------------------------------------------------------
# the worker: every import door funnels through store_plan, and this runs once per revision
# ---------------------------------------------------------------------------------------

GEO_A = "§GEO 2612345.6 1264321.2"
GEO_B = "§GEO 2612415.6 1264411.2"
#: one page per Geschoss, EG on page 1, with the fit stated outright on the EG drawing
MARKED = [
    [(200, 300, "§1UG")],
    [(210, 310, "§EG"), (60, 540, GEO_A), (700, 60, GEO_B)],
    [(220, 320, "§1OG")],
]


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    """Own blob store, and NO station building snapshot.

    ⚠️ `ensure_snapshot` caches its snapshot in a process-wide global and, for any object with
    coordinates, would fetch it from the public Overpass mirrors — a real request from a unit
    test, and a cached snapshot the next test file inherits. Neither belongs here: these tests
    are about markers, and a marked fit never asks a mirror anything.
    """
    from app import reference_buildings, storage

    async def offline(query, timeout_s=20.0):
        raise RuntimeError("no mirror in tests")

    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))
    monkeypatch.setattr(reference_buildings, "_cache", None)
    monkeypatch.setattr(reference_buildings.overpass, "fetch_buildings", offline)


async def _import(db, obj, pages=MARKED, module="modul6"):
    """The one write path every import door shares (S3 pull, SharePoint, upload, CLI)."""
    from app.plans import store_plan

    return await store_plan(db, obj, module, _pdf(pages))


async def _drain(factory) -> None:
    """Tick until the queue is empty – a pack whose fit page moves takes two."""
    from app import plan_alignment_worker as worker

    for _ in range(6):
        if not await worker.run_once(factory):
            return
    raise AssertionError("the alignment queue never drained")


async def _object(db):
    from app.models import ObjectSite

    obj = ObjectSite(name="Wyss Gartencenter", lng=7.6026, lat=47.5295)
    db.add(obj)
    await db.flush()
    return obj


async def test_a_marked_modul6_is_freigegeben_on_import_and_reaches_incidents(session_factory):
    """The author stated the fit on the sheet – nobody has to agree with them (16.09.2026)."""
    from app import plan_alignment_worker as worker
    from app.api.reference import dataset_alignments
    from app.models import ObjectSite, PlanAlignment, PlanAlignmentEvent
    from app.plan_floors import load_floors

    async with session_factory() as db:
        ds = await _import(db, await _object(db))
        await db.commit()
        dataset_id = ds.id

    # the EG is page 1, so the first tick moves the fit there and re-queues; the second renders it
    assert await worker.run_once(session_factory)
    async with session_factory() as db:
        row = (await db.execute(select(PlanAlignment))).scalar_one()
        assert row.page == 1 and row.status == "pending"
        floors = await load_floors(db, dataset_id, 1)
        assert [(f.index, f.page) for f in floors] == [(-1, 0), (0, 1), (1, 2)]
        assert all(f.marker and f.marker["version"] == 1 for f in floors)

    assert await worker.run_once(session_factory)
    assert not await worker.run_once(session_factory)
    async with session_factory() as db:
        row = (await db.execute(select(PlanAlignment))).scalar_one()
        assert (row.status, row.reason, row.reference_source) == ("approved", "markers", "markers")
        assert row.approved_at is not None
        assert len(row.pairs) == 2 and {p["kind"] for p in row.pairs} == {"gesetzt"}
        assert row.aspect and row.aspect > 0  # approval refuses a proposal without one
        # the audit row says who: the marker import, not a user who clicked «Freigeben»
        event = (await db.execute(select(PlanAlignmentEvent))).scalar_one()
        assert event.action == "approve" and event.snapshot["actor"] == "markers"
        assert event.snapshot["after"]["status"] == "approved"
        # …and an incident binding this revision gets the fit
        published = await dataset_alignments(dataset_id, None, v=None, db=db)
        assert [a["id"] for a in published["alignments"]] == [row.id]
        assert published["alignments"][0]["approval_id"] == event.id
        assert (await db.execute(select(ObjectSite))).scalar_one() is not None


async def test_every_marker_run_writes_what_it_read_onto_the_row(session_factory):
    """The row carries the diagnosis (16.09.2026): a broken export leaves the admin an object
    with no Geschosse, and `marker_notes` is the only thing that can say why."""
    from app.models import PlanAlignment
    from app.plan_floors import load_floors

    broken = [[(-30, 300, "§[EG"), (200, 300, "§EG"), (400, 40, "§EG]"), (500, 300, "§1OG"), (520, 540, "§[1OG")]]
    async with session_factory() as db:
        ds = await _import(db, await _object(db), broken)
        await db.commit()
        dataset_id = ds.id
    await _drain(session_factory)
    async with session_factory() as db:
        row = (await db.execute(select(PlanAlignment))).scalar_one()
        assert await load_floors(db, dataset_id, 1) == []  # nothing written, and now it says so
        notes = row.marker_notes
        assert [w["code"] for w in notes["warnings"]] == [
            "region_off_page",
            "corner_missing",
            "corner_missing",
            "pack_invalid",
        ]
        assert (notes["storeys_found"], notes["storeys_written"], notes["geo_pairs"]) == (2, 0, 0)

    # …and a marked export that IS right says exactly that: a summary and no warnings
    async with session_factory() as db:
        obj = (await db.execute(select(ObjectSite))).scalar_one()
        await _import(db, obj, MARKED)
        await db.commit()
    await _drain(session_factory)
    async with session_factory() as db:
        row = (await db.execute(select(PlanAlignment).where(PlanAlignment.plan_version == 2))).scalar_one()
        assert row.marker_notes == {"warnings": [], "storeys_found": 3, "storeys_written": 3, "geo_pairs": 2}


async def test_an_unmarked_sheet_leaves_no_marker_notes_at_all(session_factory):
    from app.models import PlanAlignment

    async with session_factory() as db:
        await _import(db, await _object(db), [[(200, 300, "Grundriss Erdgeschoss")]])
        await db.commit()
    await _drain(session_factory)
    async with session_factory() as db:
        assert (await db.execute(select(PlanAlignment))).scalar_one().marker_notes is None


async def test_without_geo_markers_the_storeys_arrive_and_the_fit_stays_the_worker_s_business(
    session_factory,
):
    from app.models import PlanAlignment
    from app.plan_floors import load_floors

    plain = [[(200, 300, "§1UG")], [(210, 310, "§EG")], [(220, 320, "§1OG")]]
    async with session_factory() as db:
        ds = await _import(db, await _object(db), plain)
        await db.commit()
        dataset_id = ds.id
    await _drain(session_factory)
    async with session_factory() as db:
        row = (await db.execute(select(PlanAlignment))).scalar_one()
        assert len(await load_floors(db, dataset_id, 1)) == 3
        assert row.page == 1 and row.pairs == []
        # Modul 6 has no matcher template – exactly what an unmarked pack gets today
        assert row.status == "unsupported" and row.reason == "unsupported_module"
        assert row.approved_at is None  # no §GEO, no fit, nothing to freigeben


async def test_an_approved_fit_is_never_re_read_or_re_queued_by_markers(session_factory):
    from app import plan_alignment_worker as worker
    from app.models import PlanAlignment
    from app.plan_floors import load_floors

    async with session_factory() as db:
        ds = await _import(db, await _object(db))
        row = (await db.execute(select(PlanAlignment))).scalar_one()
        row.status, row.page, row.approved_at = "approved", 0, datetime(2026, 9, 14, tzinfo=UTC)
        await db.commit()
        dataset_id = ds.id
    assert not await worker.run_once(session_factory)  # an approved job is not claimable at all
    async with session_factory() as db:
        from app.models import PlanAlignmentEvent

        row = (await db.execute(select(PlanAlignment))).scalar_one()
        assert (row.status, row.page) == ("approved", 0)
        assert await load_floors(db, dataset_id, 1) == []
        # the admin's own approval stands as it is – the markers write no second one over it
        assert not (await db.execute(select(PlanAlignmentEvent))).scalars().all()


async def test_a_pack_the_admin_built_by_hand_is_never_overwritten_by_markers(session_factory):
    from app import plan_alignment_worker as worker
    from app.models import PlanAlignment
    from app.plan_floors import PlanFloor, load_floors, replace_floors

    async with session_factory() as db:
        ds = await _import(db, await _object(db))
        # the admin got there first: a pack no markers made, on this very revision
        await replace_floors(db, ds.id, 1, [PlanFloor(0, 0, "Nur diese Seite", None, None)])
        await db.commit()
        dataset_id = ds.id
    assert await worker.run_once(session_factory)
    async with session_factory() as db:
        floors = await load_floors(db, dataset_id, 1)
        assert [(f.index, f.page, f.name) for f in floors] == [(0, 0, "Nur diese Seite")]
        assert (await db.execute(select(PlanAlignment))).scalar_one().page == 0


async def test_a_withdrawn_marker_approval_goes_back_to_the_queue_and_is_not_re_approved(
    session_factory, client, admin_login
):
    """«Freigabe zurücknehmen» on a marked sheet: the fit stays on the row and the sheet is
    «Bitte prüfen» again – the admin's decision is not undone by the next tick."""
    from app import plan_alignment_worker as worker
    from app.models import PlanAlignment

    async with session_factory() as db:
        await _import(db, await _object(db))
        await db.commit()
    await _drain(session_factory)
    async with session_factory() as db:
        row = (await db.execute(select(PlanAlignment))).scalar_one()
        assert row.status == "approved"
        item_id, edit_version = row.id, row.edit_version

    await admin_login(client)
    undone = await client.post(f"/api/admin/plan-alignments/{item_id}/undo", json={"edit_version": edit_version})
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "needs_review"  # the proposal itself is untouched …
    assert len(undone.json()["pairs"]) == 2 and undone.json()["can_approve"] is True
    assert not await worker.run_once(session_factory)  # … and no tick claims a decided row


async def test_an_admin_edit_survives_a_re_export_and_a_moved_marker_does_not(session_factory):
    """The whole point of the marker snapshot: the next export is followed where it moved and
    keeps what a human had corrected. Both, on the same floor."""
    from app.models import PlanAlignment
    from app.plan_floors import load_floors, replace_floors

    async with session_factory() as db:
        obj = await _object(db)
        ds = await _import(db, obj)
        await db.commit()
        dataset_id = ds.id
    await _drain(session_factory)  # floors, the move to the EG page, then the fit itself

    async with session_factory() as db:
        floors = await load_floors(db, dataset_id, 1)
        first = next(f for f in floors if f.index == 1)
        assert first.join is not None
        old_join = dict(first.join)
        # the admin names the 1. OG by hand and leaves its join exactly as the markers set it
        await replace_floors(db, dataset_id, 1, [f if f.index != 1 else replace(f, name="Büro-Etage") for f in floors])
        await db.commit()

    # …and the plan author re-exports, having moved the 1. OG's join marker across the sheet
    moved = [p if i != 2 else [(600, 120, "§1OG")] for i, p in enumerate(MARKED)]
    async with session_factory() as db:
        obj = (await db.execute(select(ObjectSite))).scalar_one()
        await _import(db, obj, moved)
        await db.commit()
    await _drain(session_factory)

    async with session_factory() as db:
        row = (await db.execute(select(PlanAlignment).where(PlanAlignment.plan_version == 2))).scalar_one()
        # the re-export is the author stating the fit again, so it is freigegeben again
        assert row.status == "approved" and row.reason == "markers"
        floors = await load_floors(db, dataset_id, 2)
        first = next(f for f in floors if f.index == 1)
        assert first.name == "Büro-Etage"  # the admin typed it – it crossed the re-export
        assert first.join != old_join  # …and the marker moved, so the marker wins the join
        assert first.marker["version"] == 2 and first.marker["name"] is None
        # v1 is untouched: an incident that pinned it keeps exactly what it opened
        assert next(f for f in await load_floors(db, dataset_id, 1) if f.index == 1).name == "Büro-Etage"


# ---------------------------------------------------------------------------------------
# one Geschoss, several drawings (16.09.2026)
# ---------------------------------------------------------------------------------------

#: One A0 page: the EG as ONE drawing with two staircases, the 1. OG as TWO – west and east wing,
#: each with its own corner pair and its own join tag. Points in PDF space, y UP.
WINGS = [
    (60, 560, "§[EG"),
    (100, 300, "§EG.A Erdgeschoss"),
    (300, 300, "§EG.B"),
    (380, 40, "§EG]"),
    (450, 560, "§[1OG"),
    (500, 300, "§1OG.A Westflügel"),
    (600, 40, "§1OG]"),
    (660, 560, "§[1OG"),
    (700, 300, "§1OG.B Ostflügel"),
    (780, 40, "§1OG]"),
]


def test_a_storey_drawn_as_two_wings_becomes_two_parts_joined_at_their_own_staircases():
    """Bastian, 16.09.: a long building's 1. OG exists as two drawings. No new tag syntax – each
    corner pair is one region, and the region's own join tag says which EG point it meets."""
    plan = read_plan(_pdf([WINGS]))
    assert plan is not None and plan.warnings == []
    assert [(f.index, f.part) for f in plan.floors] == [(0, 0), (1, 0), (1, 1)]
    assert plan.storeys == 2  # two GESCHOSSE, drawn three times
    west, east = plan.floors[1], plan.floors[2]
    # reading order: the west wing is part 0, and the names are the DRAWINGS' own
    assert (west.name, east.name) == ("Westflügel", "Ostflügel")
    assert west.clip[2] < east.clip[0]
    # each wing hangs on the EG point it shares a label with – A for the west, B for the east
    points = {(m.index, m.label): m.point for m in extract_markers(_pdf([WINGS])) if m.kind == "floor"}
    assert west.join == {"to": 0, "at": points[(1, "A")], "there": points[(0, "A")]}
    assert east.join == {"to": 0, "at": points[(1, "B")], "there": points[(0, "B")]}
    # part 0 is left unsaid, so a pack drawn one drawing per storey keeps the join it always had
    assert "part" not in west.join
    assert plan.floors[0].join is None and plan.floors[0].name == "Erdgeschoss"


def test_a_second_drawing_without_a_join_tag_is_refused_and_names_the_tag_to_add():
    """«No guessing»: nothing on the sheet says where a wing without its own point lies, so the
    drawing is dropped and the author is told which tag would place it."""
    plan = read_plan(_pdf([[m for m in WINGS if m[2] != "§1OG.B Ostflügel"]]))
    assert plan is not None
    assert [(f.index, f.part) for f in plan.floors] == [(0, 0), (1, 0)]
    warning = next(w for w in plan.warnings if w["code"] == "part_without_join")
    assert (warning["storey"], warning["part"], warning["tag"], warning["want"]) == (1, 1, "§1OG", "§1OG.B")
    assert marker_text(warning) == "§1OG: zweite Zeichnung ohne Verbindungspunkt (§1OG.B fehlt)."


def test_a_wing_whose_point_nobody_shares_names_the_partner_tag_that_is_missing():
    pages = [[(x, y, "§1OG.Z Ostflügel" if t == "§1OG.B Ostflügel" else t) for x, y, t in WINGS]]
    plan = read_plan(_pdf(pages))
    assert plan is not None
    assert [(f.index, f.part) for f in plan.floors] == [(0, 0), (1, 0)]
    warning = next(w for w in plan.warnings if w["code"] == "part_without_join")
    assert warning["want"] == "§EG.Z"  # the point the EG would have to carry for this wing


def test_the_reference_storey_itself_may_be_drawn_twice_and_its_sibling_is_placed_by_a_join():
    """Part 0 of the reference IS the frame; its own second drawing is placed like any other –
    here through the 1. OG, which carries both staircases and so bridges the two EG wings."""
    pages = [
        [
            (60, 560, "§[EG"),
            (100, 300, "§EG.A"),
            (380, 40, "§EG]"),
            (450, 560, "§[EG"),
            (500, 300, "§EG.B"),
            (600, 40, "§EG]"),
            (660, 560, "§[1OG"),
            (700, 300, "§1OG.A"),
            (700, 200, "§1OG.B"),
            (780, 40, "§1OG]"),
        ]
    ]
    plan = read_plan(_pdf(pages))
    assert plan is not None and plan.warnings == []
    assert [(f.index, f.part) for f in plan.floors] == [(0, 0), (0, 1), (1, 0)]
    assert plan.floors[0].join is None  # the frame origin owes nobody a join
    assert plan.floors[1].join["to"] == 1  # the EG's east wing hangs on the 1. OG's B point…
    assert plan.floors[2].join["to"] == 0  # …and the 1. OG itself on the EG's west wing, at A
    assert "part" not in plan.floors[2].join


def test_a_storey_drawn_once_still_keeps_a_point_the_author_put_outside_its_rectangle():
    """The one-drawing case must not change: containment only decides between SEVERAL regions."""
    plan = read_plan(_pdf([[(60, 560, "§[EG"), (700, 300, "§EG"), (380, 40, "§EG]"), (500, 120, "§1OG")]]))
    assert plan is not None
    ground = next(f for f in plan.floors if f.index == 0)
    assert ground.clip is not None and ground.part == 0


def test_an_admin_edit_is_carried_across_a_re_export_per_drawing_not_per_storey():
    proposed = [
        PlanFloor(0, 1, "Westflügel", [0.0, 0.0, 0.4, 1.0], None, part=0),
        PlanFloor(0, 1, "Ostflügel", [0.5, 0.0, 0.9, 1.0], None, part=1),
    ]
    stored = [
        replace(proposed[0], marker=marker_snapshot(proposed[0], 3)),
        replace(proposed[1], name="Verwaltung", marker=marker_snapshot(proposed[1], 3)),
    ]
    assert admin_overrides(stored) == {(1, 1): {"name": "Verwaltung"}}
    # …and it lands back on THAT drawing alone when the next export moves both rectangles
    moved = [replace(f, clip=[c + 0.05 for c in f.clip]) for f in proposed]
    merged = apply_overrides(moved, admin_overrides(stored))
    assert [f.name for f in merged] == ["Westflügel", "Verwaltung"]
    assert merged[0].clip == [0.05, 0.05, 0.45, 1.05]


@pytest.mark.skipif(
    not (SAMPLE.parent / "sample-modul6-parts.pdf").is_file(), reason="the parts sample is not in this checkout"
)
def test_the_parts_reference_export_reads_as_the_readme_documents_it():
    plan = read_plan((SAMPLE.parent / "sample-modul6-parts.pdf").read_bytes())
    assert plan is not None and plan.warnings == []
    assert [(f.index, f.part, f.name) for f in plan.floors] == [
        (0, 0, "Erdgeschoss"),
        (1, 0, "Westflügel"),
        (1, 1, "Ostflügel"),
    ]
    assert all(f.join["to"] == 0 for f in plan.floors[1:])
    printed = report(SAMPLE.parent / "sample-modul6-parts.pdf")
    assert "2 storey(s) in 3 drawing(s), fit page 1, 2 map pair(s)" in printed
    assert "+1/2" in printed and "no warnings" in printed

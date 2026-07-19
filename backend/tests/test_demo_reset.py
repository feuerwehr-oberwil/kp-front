"""The pre-filled demo workspace builder is pure, so it's unit-tested without a DB."""

from datetime import UTC, datetime

from app.demo_reset import build_demo_workspace

NOW = datetime(2026, 7, 19, 12, 0, 0, tzinfo=UTC)

SCENE = {
    "entities": [{"id": "brand", "kind": "symbol", "coord": [7.57, 47.52]}],
    "drawings": [{"id": "d1", "kind": "line", "coords": [[7.57, 47.52]]}],
    "board": {"gebaeude": [{"id": "r1", "t": "16:24", "truppId": "trupp1",
                            "trail": [{"t": "16:24", "x": 0.4, "y": 0.5, "floor": 1}]}]},
}


def _ws():
    return build_demo_workspace(SCENE, [("pid-1", "Hans Müller"), ("pid-2", "Anna Meier")], NOW)


def test_adds_live_collections():
    ws = _ws()
    assert len(ws["trupps"]) == 3
    assert len(ws["mittel"]) == 4
    # two in the field (aktiv), one Sicherheitstrupp angemeldet with no clock running
    assert [t["status"] for t in ws["trupps"]] == ["aktiv", "aktiv", "angemeldet"]
    assert ws["trupps"][2]["entryTime"] == "" and ws["trupps"][2]["lastContactTime"] == ""


def test_trupp_clocks_are_reset_relative():
    ws = _ws()
    # the field Trupps' contact is recent (< the 5-min interval) so they read "Kontakt OK"
    t0 = ws["trupps"][0]
    assert t0["entryTime"].endswith("Z") and t0["lastContactTime"].endswith("Z")
    assert datetime.fromisoformat(t0["lastContactTime"].replace("Z", "+00:00")) < NOW


def test_attendance_keyed_by_person_id():
    ws = _ws()
    assert set(ws["attendance"]) == {"pid-1", "pid-2"}
    assert ws["attendance"]["pid-1"] == {
        "status": "present",
        "checkedInAt": ws["attendance"]["pid-1"]["checkedInAt"],
        "displayNameSnapshot": "Hans Müller",
    }


def test_mittel_key_to_catalogue_ids():
    ws = _ws()
    assert {m["materialId"] for m in ws["mittel"]} == {"schaummittel", "schlauch-c", "oelbindemittel", "luefter"}
    assert all(m["menge"] > 0 and m["at"].endswith("Z") for m in ws["mittel"])


def test_board_chip_times_refreshed():
    ws = _ws()
    res = ws["board"]["gebaeude"][0]
    assert res["t"] != "16:24"  # rebased to a fresh HH:MM
    assert res["trail"][0]["t"] == res["t"]


def test_scene_geometry_preserved():
    ws = _ws()
    assert ws["entities"][0]["coord"] == [7.57, 47.52]
    assert ws["drawings"][0]["coords"] == [[7.57, 47.52]]

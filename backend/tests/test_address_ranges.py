"""The addresses an object's name covers (`app/address_ranges.py`, review round 3, 17.10.2026).

The positive cases are the station's real object names the owner and the lead pointed at; the
negatives are real names too. Which register addresses exist is synthetic.
"""

from __future__ import annotations

import pytest

from app import address_ranges as ar


def keys(*texts: str) -> list[str]:
    return [s.key() for s in ar.parse(*texts)]


@pytest.mark.parametrize(
    ("name", "want"),
    [
        ("Stallenmattstrasse 2-14, Kaibmattweg 1-5 (EH)", ["stallenmattstrasse:2-14", "kaibmattweg:1-5"]),
        ("Stallenmattstrasse 1-14, Kaibmattweg 1-5 (EH)", ["stallenmattstrasse:1-14", "kaibmattweg:1-5"]),
        ("Hohestrasse 136-158", ["hohestrasse:136-158"]),
        ("Hohestrasse 145-153", ["hohestrasse:145-153"]),
        ("Bruderholzstrasse 90-130, Lettenhofstrasse 30-66", ["bruderholzstrasse:90-130", "lettenhofstrasse:30-66"]),
        ("Auf der Wacht 14&16", ["auf der wacht:14,16"]),
        ("Sägestrasse 2&4, Garage Keigel & Schäffler AG", ["sagestrasse:2,4"]),
        ("Storchenweg 1-16, Bertschenackerstrasse 11-19", ["storchenweg:1-16", "bertschenackerstrasse:11-19"]),
        ("Waldrain 2-4", ["waldrain:2-4"]),
        ("Im Wasen 1-8", ["im wasen:1-8"]),
        ("Hohestrasse 134&134f - Ziegelei", ["hohestrasse:134,134f"]),
        ("Hohestrasse 128a-b (EH)", ["hohestrasse:128ab"]),
        # one range makes the whole name a row: the single address beside it counts as well
        ("Amselstrasse 24-32, Auf der Wacht 2", ["amselstrasse:24-32", "auf der wacht:2"]),
        ("Sägestrasse 2, 4", ["sagestrasse:2,4"]),
        ("Sägestrasse 2 und 4", ["sagestrasse:2,4"]),
        ("Hauptstr. 3-5", ["hauptstrasse:3-5"]),
    ],
)
def test_the_stations_names(name: str, want: list[str]):
    assert keys(name) == want


@pytest.mark.parametrize(
    "name",
    [
        "Dipl. Ing. Fust",
        "G+B Plex",
        # two doors of one farm, not a row of houses — the point's own rule decides
        "Hof Thürkauf, Im Buech 15, Im Buech 20",
        "Sägestrasse 9",
        "Mühlemattstrasse 24",
        "Bienenstrasse 28 (EH)",
        "Mühlemattstrasse 22 - Mühlemattcenter",
        "Jumbo",
        "Schulhaus Am Marbach",
        "",
        # a span no row of houses has (a year range, a typo) is not read
        "Chronik 1900-2026",
    ],
)
def test_names_that_are_no_row_of_houses(name: str):
    assert ar.parse(name) == []


def test_the_folder_alias_adds_its_address():
    # the plan library's folder «<address> - <name>»: its address belongs to the object too
    got = keys(
        "Storchenweg 1-16, Bertschenackerstrasse 11-19",
        "Bertschenackerstrasse 15a - Storchenweg 1-16, Bertschenackerstrasse 11-19",
    )
    assert got == ["storchenweg:1-16", "bertschenackerstrasse:11-19", "bertschenackerstrasse:15a"]
    # an alias alone with a single address does not make a row
    assert ar.parse("Gemeindeverwaltung", "Hauptstrasse 24 - Gemeindeverwaltung") == []


def test_a_range_covers_what_exists_with_its_letters_never_odd_or_even():
    specs = ar.parse("Stallenmattstrasse 1-14, Kaibmattweg 1-5 (EH)")
    register = ["1", "2", "2a", "2b", "3", "7", "10a", "14", "15", "16", "40a"]
    assert [n for n in register if ar.covers(specs, "Stallenmattstrasse", n)] == [
        "1",
        "2",
        "2a",
        "2b",
        "3",
        "7",
        "10a",
        "14",
    ]
    assert ar.covers(specs, "Kaibmattweg", "5")
    assert not ar.covers(specs, "Kaibmattweg", "6")
    assert not ar.covers(specs, "Stallenstrasse", "3")  # another street
    assert not ar.covers(specs, "Stallenmattstrasse", "")  # no number


def test_letters_and_lists():
    wacht = ar.parse("Auf der Wacht 14&16")
    assert [n for n in ("13", "14", "14a", "15", "16") if ar.covers(wacht, "Auf der Wacht", n)] == ["14", "14a", "16"]
    ziegelei = ar.parse("Hohestrasse 134&134f - Ziegelei")
    assert [n for n in ("134", "134a", "134f", "135") if ar.covers(ziegelei, "Hohestrasse", n)] == [
        "134",
        "134a",
        "134f",
    ]
    eh = ar.parse("Hohestrasse 128a-b (EH)")
    assert [n for n in ("128", "128a", "128b", "128c") if ar.covers(eh, "Hohestrasse", n)] == ["128a", "128b"]


def test_streets_compare_folded_and_without_words_in_front():
    specs = ar.parse("Sägestrasse 2&4, Garage Keigel & Schäffler AG")
    assert ar.covers(specs, "Sägestrasse", "4")
    assert ar.covers(specs, "SÄGESTRASSE", "2")
    assert ar.street_candidates("Garage Keigel Sägestrasse") == [
        "Garage Keigel Sägestrasse",
        "Keigel Sägestrasse",
        "Sägestrasse",
    ]
    # words in front of the street: settled on the longest street the register knows
    garage = ar.parse("Garage Keigel Sägestrasse 2-4")
    assert not ar.covers(garage, "Sägestrasse", "2")
    assert ar.covers(ar.settle(garage, ["Sägestrasse", "Hauptstrasse"]), "Sägestrasse", "2")
    # «Auf der Wacht» stays itself where it exists — never a street called «Wacht»
    wacht = ar.settle(ar.parse("Auf der Wacht 14&16"), ["Wacht", "Auf der Wacht"])
    assert ar.covers(wacht, "Auf der Wacht", "14") and not ar.covers(wacht, "Wacht", "14")
    # «str.» written out; a street the register does not know is dropped
    assert ar.covers(ar.settle(ar.parse("Hauptstr. 3-5"), ["Hauptstrasse"]), "Hauptstrasse", "4")
    assert ar.settle(ar.parse("Binnningerstrasse 13-17"), ["Binningerstrasse"]) == []


def test_the_key_is_stable():
    # what a stored answer was asked for: the same specs in any order, any spelling of the street
    a = ar.parse("Storchenweg 1-16, Bertschenackerstrasse 11-19")
    b = ar.parse("Bertschenackerstrasse 11–19, STORCHENWEG 1-16")
    assert ar.specs_key(a) == ar.specs_key(b) == "bertschenackerstrasse:11-19;storchenweg:1-16"


def test_what_the_register_is_asked_for():
    assert ar.query_names("Hauptstr") == ["Hauptstr", "Hauptstrasse"]
    assert ar.query_names("Auf der Wacht") == ["Auf der Wacht", "der Wacht", "Wacht"]

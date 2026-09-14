"""Typo correction of street tokens (app.street_dictionary) and the retry in app.geocode.search.

Pure tests for the edit-distance rules, plus one test of the search retry with the upstream
mocked — no network.
"""

from app import geocode
from app.street_dictionary import correct_query, correct_street, fold, split_street, within_one_edit

STREETS = {fold(n): n for n in ["Hauptstrasse", "Bahnhofstrasse", "Storchenweg", "Bürenweg"]}


def test_one_missing_letter_is_corrected():
    assert correct_street("haupstrasse", STREETS) == "Hauptstrasse"


def test_one_extra_letter_is_corrected():
    assert correct_street("hauptstrasse", {**STREETS, fold("Hauptstrase"): "Hauptstrase"}) is None  # known street
    assert correct_street("hauptstrasse", STREETS) is None  # exact hit: not a typo, nothing to do
    assert correct_street("hauptstrassee", STREETS) == "Hauptstrasse"


def test_one_dropped_letter_is_corrected():
    assert correct_street("hauptstrase", STREETS) == "Hauptstrasse"


def test_two_swapped_letters_are_corrected():
    assert correct_street("huaptstrasse", STREETS) == "Hauptstrasse"


def test_two_edits_are_not_corrected():
    assert correct_street("haupstrase", STREETS) is None


def test_a_three_letter_token_is_not_corrected():
    assert correct_street("weg", {fold("Wag"): "Wag"}) is None


def test_ambiguous_candidates_mean_no_correction():
    streets = {fold(n): n for n in ["Rosenweg", "Rosenwag"]}
    assert correct_street("rosenwog", streets) is None


def test_umlauts_and_case_are_folded_like_the_frontend():
    assert fold("Bürenweg") == "buerenweg"
    assert fold("Straße") == "strasse"
    assert correct_street("BUERENWEK", STREETS) == "Bürenweg"


def test_adjacent_swap_only():
    assert within_one_edit("abcd", "abdc")
    assert not within_one_edit("abcd", "adcb")


def test_the_street_is_everything_before_the_house_number():
    assert split_street("haupstrasse 12") == ("haupstrasse", " 12")
    assert split_street("im wasen 3a, 4104 Oberwil") == ("im wasen", " 3a, 4104 Oberwil")
    assert split_street("haupstrasse, 4104") == ("haupstrasse", ", 4104")
    assert split_street("haupstrasse") == ("haupstrasse", "")


def test_the_query_keeps_its_remainder():
    assert correct_query("haupstrasse 12, 4104", STREETS) == "Hauptstrasse 12, 4104"
    assert correct_query("hauptstrasse 12", STREETS) is None


def _result(label: str) -> dict:
    return {"attrs": {"label": label, "lat": 47.5, "lon": 7.5}}


async def test_search_retries_once_with_the_corrected_street(monkeypatch):
    asked: list[str] = []

    async def fake_upstream(text: str, bbox: str, limit: int) -> list[dict]:
        asked.append(text)
        return [] if len(asked) == 1 else [_result("Hauptstrasse 12 4104 Oberwil BL")]

    async def bias() -> tuple[str, str]:
        return "4104 Oberwil", "2598000,1252000,2625000,1270000"

    monkeypatch.setattr(geocode, "_upstream", fake_upstream)
    monkeypatch.setattr(geocode, "_resolve_bias", bias)
    monkeypatch.setattr(geocode._streets, "get", lambda bbox: STREETS)

    hits = await geocode.search("haupstrasse 12")

    assert asked == ["haupstrasse 12 4104 Oberwil", "Hauptstrasse 12 4104 Oberwil"]
    assert [h.label for h in hits] == ["Hauptstrasse 12 4104 Oberwil BL"]


async def test_search_without_a_dictionary_asks_once(monkeypatch):
    asked: list[str] = []

    async def fake_upstream(text: str, bbox: str, limit: int) -> list[dict]:
        asked.append(text)
        return []

    async def bias() -> tuple[str, str]:
        return "", ""

    monkeypatch.setattr(geocode, "_upstream", fake_upstream)
    monkeypatch.setattr(geocode, "_resolve_bias", bias)

    assert await geocode.search("haupstrasse 12") == []
    assert asked == ["haupstrasse 12"]

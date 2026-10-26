"""The alarm-bearing Trupp fields a workspace write must get right — see app/alarm_validation."""

import pytest

from app.alarm_validation import validate_alarm_workspace, validate_trupp


def test_a_trupp_number_is_a_whole_nonnegative_number_or_absent():
    validate_trupp({"id": "t1", "no": 3})
    validate_trupp({"id": "t1"})  # a record from before 12.09.
    for bad in ("3", 2.5, -1, True):
        with pytest.raises(ValueError, match="no:"):
            validate_trupp({"id": "t1", "no": bad})


def test_a_notfall_trigger_is_a_timestamp_or_absent():
    # the Atemschutznotfall (F1, 08.10.2026) — the push sweep keys its crossing on it
    validate_trupp({"id": "t1", "notfallAt": "2026-10-08T02:14:00.000Z"})
    validate_trupp({"id": "t1"})
    with pytest.raises(ValueError, match="notfallAt"):
        validate_trupp({"id": "t1", "notfallAt": "gestern"})


def test_the_kind_and_status_words_are_the_known_ones_or_absent():
    """A typo kind («atemschut») used to be stored and read as «not under PA» (audit F01)."""
    for ok in ({}, {"kind": "atemschutz"}, {"kind": "einfach"}, {"status": "rueckzug"}):
        validate_trupp({"id": "t1", **ok})
    for bad in ({"kind": "atemschut"}, {"kind": ""}, {"status": "of fen"}, {"status": ""}):
        with pytest.raises(ValueError, match=r"kind:|status:"):
            validate_trupp({"id": "t1", **bad})


@pytest.mark.parametrize(
    "bad",
    [
        {"members": [None]},
        {"members": {"a": "b"}},
        {"memberPersonIds": [3]},
        {"leaderPersonId": 3},
        {"readings": [None]},
    ],
)
def test_the_crew_lists_hold_only_text(bad):
    """`members: [null]` was stored and then threw in every label on every device (audit F03)."""
    validate_trupp({"id": "t1", "members": ["Müller Hans"], "memberPersonIds": ["p1"], "readings": []})
    with pytest.raises(ValueError):
        validate_trupp({"id": "t1", **bad})


def test_a_save_cannot_add_a_second_trupp_under_one_id():
    """Clients merge Trupps by id, so a duplicate collapses into one crew at the next merge (F04)."""
    a, b = {"id": "t1", "name": "A"}, {"id": "t1", "name": "B"}
    with pytest.raises(ValueError, match="doppelt"):
        validate_alarm_workspace({"trupps": [a, b]})
    # a duplicate already stored rides as often as it was stored — never more
    validate_alarm_workspace({"trupps": [a, b]}, {"trupps": [a, b]})
    with pytest.raises(ValueError, match="doppelt"):
        validate_alarm_workspace({"trupps": [a, b, a]}, {"trupps": [a, b]})


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("contactIntervalMin", 0),
        ("contactIntervalMin", 31),
        ("contactIntervalMin", 1e308),
        ("contactIntervalMin", True),
        ("contactGraceSec", -1),
        ("contactGraceSec", 301),
    ],
)
def test_a_per_einsatz_contact_override_stays_in_the_station_range(key, value):
    """1–30 min and 0–300 s (owner, 26.10.2026): 0 and 1e308 both passed before (audit F02)."""
    validate_alarm_workspace({"settings": {"contactIntervalMin": 30, "contactGraceSec": 0}})
    with pytest.raises(ValueError, match=key):
        validate_alarm_workspace({"settings": {key: value}})
    # an override stored before the bound keeps riding until somebody changes it
    validate_alarm_workspace({"settings": {key: value}}, {"settings": {key: value}})

"""Pure unit tests for the Divera Mannschaft sync diff + name formatting (no DB)."""

import uuid
from dataclasses import dataclass

from app.personnel import (
    derive_rank_from_quals,
    diff_members,
    format_name,
    match_rank,
    name_sort_key,
    normalize_name,
    person_display_name,
    split_name,
)

RANKS = [
    {"key": "hptm", "label": "Hauptmann", "abbr": "Hptm", "tier": "officer"},
    {"key": "lt", "label": "Leutnant", "abbr": "Lt", "tier": "officer"},
    {"key": "fwm", "label": "Feuerwehrmann", "abbr": "Fwm", "tier": "crew"},
]


@dataclass
class FakePerson:
    external_id: str | None
    display_name: str
    is_active: bool = True
    rank: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    id: uuid.UUID = None  # type: ignore[assignment]

    def __post_init__(self):
        if self.id is None:
            self.id = uuid.uuid4()


def test_format_name_stdformat():
    assert format_name("Müller, Hans", "", "") == "Müller Hans"


def test_format_name_stdformat_no_comma():
    assert format_name("Florian Meier", "", "") == "Florian Meier"


def test_format_name_firstlast_fallback():
    assert format_name("", "Hans", "Müller") == "Müller Hans"


def test_format_name_lastname_only():
    assert format_name("", "", "Müller") == "Müller"


def test_format_name_empty_is_none():
    assert format_name("", "", "") is None


# --- roster.nameOrder --------------------------------------------------------------


def test_format_name_first_last_order():
    assert format_name("", "Hans", "Müller", "first-last") == "Hans Müller"


def test_format_name_stdformat_under_both_orders():
    # Divera always delivers "Lastname, Firstname" — only the join changes with the setting.
    assert format_name("Müller, Hans", "", "", "last-first") == "Müller Hans"
    assert format_name("Müller, Hans", "", "", "first-last") == "Hans Müller"


def test_format_name_half_a_name_is_order_independent():
    # Nothing to reorder — one token comes back as it is, whichever way round the station reads.
    for order in ("last-first", "first-last"):
        assert format_name("", "", "Müller", order) == "Müller"
        assert format_name("", "Hans", "", order) == "Hans"


def test_split_name_fills_both_halves_from_stdformat():
    # The sync persists these; without them a stored name could never be reordered later.
    assert split_name("Müller, Hans", "", "") == ("Müller", "Hans")
    assert split_name("", "Hans", "Müller") == ("Müller", "Hans")


def test_person_display_name_reorders_when_the_split_is_there():
    p = FakePerson(external_id="1", display_name="Müller Hans", first_name="Hans", last_name="Müller")
    assert person_display_name(p, "last-first") == "Müller Hans"
    assert person_display_name(p, "first-last") == "Hans Müller"


def test_person_display_name_keeps_the_stored_string_without_a_split():
    # Hand-entered crew: no first/last, so «Von Arx Beat» must survive verbatim in either order.
    p = FakePerson(external_id=None, display_name="Von Arx Beat")
    assert person_display_name(p, "last-first") == "Von Arx Beat"
    assert person_display_name(p, "first-last") == "Von Arx Beat"


def test_person_display_name_keeps_the_stored_string_with_half_a_split():
    p = FakePerson(external_id=None, display_name="Müller", last_name="Müller")
    assert person_display_name(p, "first-last") == "Müller"


def test_name_sort_key_is_accent_and_case_insensitive():
    assert sorted(["Zbinden A.", "Ärni B.", "abegg C."], key=name_sort_key) == ["abegg C.", "Ärni B.", "Zbinden A."]


def test_normalize_name_accent_case_whitespace():
    assert normalize_name("  Müller   Hans ") == "muller hans"
    assert normalize_name("MÜLLER HANS") == "muller hans"


def member(divera_id: int, name: str) -> dict:
    return {"divera_id": divera_id, "name": name, "first_name": None, "last_name": None}


def test_match_rank_by_key_label_abbr():
    assert match_rank("hptm", RANKS) == "hptm"
    assert match_rank("Hauptmann", RANKS) == "hptm"
    assert match_rank("Hptm", RANKS) == "hptm"


def test_match_rank_accent_and_case_insensitive():
    assert match_rank("  FEUERWEHRMANN ", RANKS) == "fwm"


def test_match_rank_blank_and_unknown_are_none():
    assert match_rank("", RANKS) is None
    assert match_rank("Admiral", RANKS) is None


def test_derive_rank_picks_most_senior():
    # Hauptmann outranks Leutnant; unrelated quals are ignored
    assert derive_rank_from_quals(["Atemschutz", "Leutnant", "Hauptmann"], RANKS) == "hptm"


def test_derive_rank_base_fallback_when_no_rank_qual():
    # only functional quals → base rank (most junior entry)
    assert derive_rank_from_quals(["Atemschutz", "Fahrer C1/118"], RANKS) == "fwm"


def test_derive_rank_empty_quals_is_base():
    assert derive_rank_from_quals([], RANKS) == "fwm"


def test_derive_rank_no_ranks_config_is_none():
    assert derive_rank_from_quals(["Hauptmann"], []) is None


def test_diff_new_member():
    d = diff_members([member(1, "Müller Hans")], [])
    assert [x["divera_id"] for x in d["new"]] == [1]
    assert d["updated"] == [] and d["unchanged"] == [] and d["stale"] == []


def test_diff_unchanged_member():
    existing = [FakePerson(external_id="1", display_name="Müller Hans")]
    d = diff_members([member(1, "Müller Hans")], existing)
    assert len(d["unchanged"]) == 1
    assert d["new"] == [] and d["updated"] == []


def test_diff_renamed_member_is_updated():
    existing = [FakePerson(external_id="1", display_name="Müller H")]
    d = diff_members([member(1, "Müller Hans")], existing)
    assert len(d["updated"]) == 1
    assert d["updated"][0]["name"] == "Müller Hans"
    assert d["updated"][0]["was_inactive"] is False


def test_diff_inactive_match_is_updated_and_flagged():
    existing = [FakePerson(external_id="1", display_name="Müller Hans", is_active=False)]
    d = diff_members([member(1, "Müller Hans")], existing)
    assert len(d["updated"]) == 1
    assert d["updated"][0]["was_inactive"] is True


def test_diff_stale_member():
    existing = [FakePerson(external_id="9", display_name="Weg Walter")]
    d = diff_members([], existing)
    assert [x["name"] for x in d["stale"]] == ["Weg Walter"]


def test_diff_manual_person_never_stale():
    existing = [FakePerson(external_id=None, display_name="Gast Mutual Aid")]
    d = diff_members([], existing)
    assert d["stale"] == []


def member_r(divera_id: int, name: str, rank: str | None) -> dict:
    return {"divera_id": divera_id, "name": name, "first_name": None, "last_name": None, "rank": rank}


def test_diff_rank_change_is_updated_when_rank_known():
    existing = [FakePerson(external_id="1", display_name="Müller Hans", rank="fwm")]
    d = diff_members([member_r(1, "Müller Hans", "lt")], existing)
    assert len(d["updated"]) == 1
    assert d["updated"][0]["rank"] == "lt"


def test_diff_same_rank_is_unchanged():
    existing = [FakePerson(external_id="1", display_name="Müller Hans", rank="lt")]
    d = diff_members([member_r(1, "Müller Hans", "lt")], existing)
    assert len(d["unchanged"]) == 1 and d["updated"] == []


def test_diff_without_rank_key_never_touches_rank():
    # feed couldn't see qualifications → member dict has no "rank" key → rank not compared,
    # so a CSV/admin-set rank isn't flagged as changed (and won't be overwritten downstream)
    existing = [FakePerson(external_id="1", display_name="Müller Hans", rank="lt")]
    d = diff_members([member(1, "Müller Hans")], existing)
    assert len(d["unchanged"]) == 1 and d["updated"] == []


def test_diff_inactive_stale_not_reported():
    # an already-deactivated stale member is not surfaced again
    existing = [FakePerson(external_id="9", display_name="Weg Walter", is_active=False)]
    d = diff_members([], existing)
    assert d["stale"] == []

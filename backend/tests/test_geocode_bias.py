"""Region bias of the address autocomplete (app.geocode).

Pure-function tests — no network. Each one guards a way the bias made the answer WORSE than
no bias at all, which is the failure mode that matters: an operator typing an address under
pressure gets a list with the right street missing from it.
"""

from app.geocode import GeoHit, _bias, _home_first

LOCALITY = "4104 Oberwil"


def test_a_bare_street_gets_the_home_locality():
    assert _bias("Storchenweg 8", LOCALITY) == "Storchenweg 8 4104 Oberwil"


def test_a_typed_postal_code_is_left_alone():
    assert _bias("Hauptstrasse 4, 4103 Bottmingen", LOCALITY) == "Hauptstrasse 4, 4103 Bottmingen"


def test_a_half_typed_postal_code_is_left_alone():
    """⚠️ The reported bug. A postal code is four digits, so «410» did not read as one and the
    home locality was appended on top — «storchenweg 8, 410 4103 Bottmingen». swisstopo then
    matched the NUMBERS and dropped the street name: six hits, not one of them a Storchenweg."""
    assert _bias("storchenweg 8, 410", LOCALITY) == "storchenweg 8, 410"
    assert _bias("storchenweg 8, 41", LOCALITY) == "storchenweg 8, 41"


def test_a_trailing_comma_is_not_a_locality_yet():
    assert _bias("Storchenweg 8, ", LOCALITY).endswith(LOCALITY)


def test_a_house_number_is_not_mistaken_for_a_postal_code():
    # no comma → the digits are a house number, and the locality is still wanted
    assert _bias("Bahnhofstrasse 120", LOCALITY) == "Bahnhofstrasse 120 4104 Oberwil"


def test_no_configured_locality_leaves_every_query_untouched():
    assert _bias("Storchenweg 8", "") == "Storchenweg 8"


def _hit(label: str) -> GeoHit:
    return GeoHit(label=label, lat=47.5, lng=7.5)


def test_the_home_town_ranks_first():
    hits = [_hit("Hauptstrasse 10 4103 Bottmingen"), _hit("Hauptstrasse 10 4104 Oberwil BL")]
    assert next(h.label for h in _home_first(hits, LOCALITY)).endswith("Oberwil BL")


def test_ranking_is_stable_behind_the_home_town():
    hits = [_hit("A 1 4103 Bottmingen"), _hit("B 2 4123 Allschwil"), _hit("C 3 4104 Oberwil")]
    assert [h.label[0] for h in _home_first(hits, LOCALITY)] == ["C", "A", "B"]


def test_no_locality_configured_keeps_the_upstream_order():
    hits = [_hit("A 1 4103 Bottmingen"), _hit("B 2 4104 Oberwil")]
    assert [h.label[0] for h in _home_first(hits, "")] == ["A", "B"]

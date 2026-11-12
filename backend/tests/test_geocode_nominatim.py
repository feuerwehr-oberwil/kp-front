"""Nominatim-compatible geocoder path (GEOCODER_URL not swisstopo SearchServer).

No network — fixtures cover Moldova labels: diacritics, ASCII fold, duplicate place names,
and WGS84 pin coordinates for Chișinău / Bălți / Cahul / Ghidighici.
"""

from app.geocode import (
    GeoHit,
    _is_swisstopo,
    _parse_bbox_wgs84,
    _parse_nominatim,
    _shares_a_word,
)


def test_swisstopo_detected_on_default_url():
    # settings default is geo.admin SearchServer in a normal checkout
    assert _is_swisstopo() is True


def test_nominatim_root_strips_search_suffix(monkeypatch):
    from app import geocode
    from app.config import settings

    monkeypatch.setattr(settings, "geocoder_url", "https://nominatim.example/search", raising=False)
    # re-read through the helper (uses settings live)
    assert geocode._nominatim_root() == "https://nominatim.example"


def test_parse_bbox_wgs84():
    assert _parse_bbox_wgs84("28.7,46.9,29.0,47.1") == (28.7, 46.9, 29.0, 47.1)
    assert _parse_bbox_wgs84("29,47,28,46") is None  # min >= max
    assert _parse_bbox_wgs84("nope") is None


def _nom(label: str, lat: float, lon: float) -> dict:
    return {"display_name": label, "lat": str(lat), "lon": str(lon)}


CHI = "Bulevardul Ștefan cel Mare și Sfânt 1, Chișinău, Moldova"
BAL = "Strada Independenței 1, Bălți, Moldova"
CAH = "Piața Independenței, Cahul, Moldova"
GHI = "Satul Ghidighici, Municipiul Chișinău, Moldova"


def test_parse_nominatim_keeps_wgs84_lng_lat():
    hits = _parse_nominatim(
        [
            _nom(CHI, 47.026, 28.842),
            _nom(BAL, 47.761, 27.929),
            {"display_name": "broken", "lat": "x", "lon": "1"},
        ]
    )
    assert hits == [
        GeoHit(label=CHI, lat=47.026, lng=28.842),
        GeoHit(label=BAL, lat=47.761, lng=27.929),
    ]


def test_diacritics_and_ascii_share_a_word_with_chisinau_labels():
    hits = [
        GeoHit(label=CHI, lat=47.026, lng=28.842),
        GeoHit(label=CAH, lat=45.904, lng=28.194),
        GeoHit(label=GHI, lat=47.092, lng=28.764),
    ]
    assert [h.label for h in _shares_a_word(hits, "Ștefan cel Mare")] == [CHI]
    assert [h.label for h in _shares_a_word(hits, "Stefan")] == [CHI]
    assert [h.label for h in _shares_a_word(hits, "Ghidighici")] == [GHI]


async def test_search_nominatim_ranks_home_and_keeps_duplicate_streets(monkeypatch):
    from app import geocode

    async def bias():
        return "Chișinău", "", "28.7,46.9,29.0,47.1"

    async def upstream(text: str, bbox: str, limit: int) -> list[dict]:
        assert "Chișinău" in text or "Chisinau" in text or "Eminescu" in text
        assert bbox.startswith("28.7")
        return [
            _nom("Strada Mihai Eminescu, Bălți, Moldova", 47.76, 27.92),
            _nom("Strada Mihai Eminescu, Chișinău, Moldova", 47.03, 28.83),
            _nom("Strada Mihai Eminescu, sectorul Centru, Chișinău, Moldova", 47.025, 28.835),
        ]

    monkeypatch.setattr(geocode, "_resolve_bias", bias)
    monkeypatch.setattr(geocode, "_is_swisstopo", lambda: False)
    monkeypatch.setattr(geocode, "_nominatim_upstream", upstream)
    monkeypatch.setattr(geocode, "_GEOCODER_OK", True)

    labels = [h.label for h in await geocode.search("Eminescu")]
    assert labels[0].endswith("Chișinău, Moldova") or "Chișinău" in labels[0]
    assert any("Bălți" in l for l in labels)
    assert len(labels) == 3
    assert all(isinstance(h.lng, float) and h.lng > 27 for h in await geocode.search("Eminescu"))


async def test_reverse_nominatim(monkeypatch):
    from app import geocode

    class _Resp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"display_name": CHI}

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, params=None):
            assert url.endswith("/reverse")
            assert params["lat"] == 47.026 and params["lon"] == 28.842
            return _Resp()

    monkeypatch.setattr(geocode, "_is_swisstopo", lambda: False)
    monkeypatch.setattr(geocode, "_GEOCODER_OK", True)
    monkeypatch.setattr(geocode, "_nominatim_root", lambda: "https://nominatim.example")
    monkeypatch.setattr(geocode.httpx, "AsyncClient", _Client)

    hit = await geocode.reverse(47.026, 28.842)
    assert hit == GeoHit(label=CHI, lat=47.026, lng=28.842)

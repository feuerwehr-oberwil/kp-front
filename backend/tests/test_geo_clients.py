"""Failure-path coverage for the outbound geo/GPS clients: the swisstopo geocoder
(app.geocode), the Traccar GPS client (app.traccar) and the Overpass building-footprint
proxy (app.overpass).

All three call an external service and are meant to DEGRADE — an empty list / a None / a
clean exception the router turns into a 502/503 — rather than surface a raw crash or a
malformed result. That degrade path is what this file pins: timeouts and non-200 answers
are stood in for by a MockTransport-backed httpx.AsyncClient (same technique as
tests/test_weather.py's `patch_httpx` fixture, kept local here rather than promoted to
conftest.py), so no real network call is ever made — test_overpass_proxy.py already flags a
live Overpass/Traccar call as a regression waiting to happen.

tests/test_geocode_bias.py, tests/test_overpass_proxy.py and tests/test_traccar_fake.py
already cover the pure bias helpers, the FastAPI proxy endpoint (auth/validation/fail-closed)
and the fake-mode HTTP surface respectively — this file stays under the client modules
themselves: geocode.reverse()/_label_from_gwr()/_parse()/search()/_resolve_bias(), the full
TraccarClient, and overpass.fetch_buildings().
"""

import asyncio

import httpx
import pytest

from app import geocode, overpass, traccar
from app.config import settings

# --- shared httpx stubbing ----------------------------------------------------------


@pytest.fixture
def patch_httpx(monkeypatch):
    """Install a MockTransport-backed AsyncClient for the duration of a test — same technique
    as tests/test_weather.py's fixture of the same name."""

    def _install(handler):
        transport = httpx.MockTransport(handler)
        orig_init = httpx.AsyncClient.__init__

        def patched_init(self, *args, **kwargs):
            kwargs["transport"] = transport
            orig_init(self, *args, **kwargs)

        monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)

    return _install


@pytest.fixture(autouse=True)
def _reset_geocode_bias_cache():
    """`_resolve_bias`'s TTL cache is process-global state; a value another test (in this
    file or, in a full run, another test module exercising search()/geocode()) leaves behind
    would otherwise leak into whichever test happens to run next."""
    geocode._bias_cache = None
    yield
    geocode._bias_cache = None


# =====================================================================================
# app.geocode
# =====================================================================================

# --- _label_from_gwr: composing "Strasse Nr, PLZ Ort" from GWR register attributes -----


def test_label_from_gwr_composes_street_plz_ort():
    attrs = {
        "strname_deinr": "Hohlegasse 3",
        "plz_plz6": "4104/410400",
        "ggdename": "Musterort (BL)",
    }
    assert geocode._label_from_gwr(attrs) == "Hohlegasse 3, 4104 Musterort"


def test_label_from_gwr_falls_back_to_the_split_street_name_list():
    """No ready-made `strname_deinr` → compose from the `strname` list + house number, and
    the PLZ from `dplz4` when `plz_plz6` is absent."""
    attrs = {"strname": ["Hohlegasse"], "deinr": "3", "dplz4": "4104", "gdename": "Musterort"}
    assert geocode._label_from_gwr(attrs) == "Hohlegasse 3, 4104 Musterort"


def test_label_from_gwr_falls_back_to_a_plain_string_street_name():
    """`strname` as a bare string (not a list) plus the `plz4`/`dplzname` fallback chain."""
    attrs = {"strname": "Hohlegasse", "deinr": "3", "plz4": "4104", "dplzname": "Musterort"}
    assert geocode._label_from_gwr(attrs) == "Hohlegasse 3, 4104 Musterort"


def test_label_from_gwr_empty_attrs_is_none():
    assert geocode._label_from_gwr({}) is None


# --- _parse: raw swisstopo `results` → GeoHit list --------------------------------------


def test_parse_skips_hits_missing_a_coordinate_and_strips_highlight_markup():
    results = [
        {"attrs": {"label": "No coordinate at all"}},
        {"attrs": {"lat": 47.5, "lon": 7.5, "detail": "<b>Foo</b> Bar"}},
    ]
    hits = geocode._parse(results)
    assert len(hits) == 1
    assert hits[0].label == "Foo Bar"


# --- reverse() ----------------------------------------------------------------------

HOME_POINT = (47.5239, 7.5706)  # (lat, lng) — an arbitrary WGS84 point, not a real address


async def test_reverse_short_circuits_when_the_geocoder_url_is_invalid(monkeypatch):
    monkeypatch.setattr(geocode, "_GEOCODER_OK", False)
    assert await geocode.reverse(*HOME_POINT) is None


async def test_reverse_echoes_the_clicked_point_not_a_registry_coordinate(patch_httpx):
    """reverse() is a label lookup for a map-click, not a coordinate correction — the
    returned GeoHit must carry the caller's own lat/lng."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "attributes": {
                            "strname_deinr": "Hohlegasse 3",
                            "plz_plz6": "4104/410400",
                            "ggdename": "Musterort (BL)",
                        }
                    }
                ]
            },
        )

    patch_httpx(handler)
    hit = await geocode.reverse(*HOME_POINT)
    assert hit is not None
    assert hit.label == "Hohlegasse 3, 4104 Musterort"
    assert (hit.lat, hit.lng) == HOME_POINT


async def test_reverse_reads_the_properties_key_when_attributes_is_absent(patch_httpx):
    """The identify API answers with `attributes` normally; `properties` is read the same
    way (`feat.get("attributes", {}) or feat.get("properties", {})` in the source)."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [{"properties": {"strname_deinr": "X 1", "ggdename": "Y"}}]})

    patch_httpx(handler)
    hit = await geocode.reverse(*HOME_POINT)
    assert hit is not None
    assert hit.label == "X 1, Y"


async def test_reverse_skips_a_feature_with_no_usable_label(patch_httpx):
    """A register row that composes to nothing is skipped, not returned as a hit with an
    empty label."""
    patch_httpx(lambda r: httpx.Response(200, json={"results": [{"attributes": {}}]}))
    assert await geocode.reverse(*HOME_POINT) is None


async def test_reverse_no_results_is_none(patch_httpx):
    patch_httpx(lambda r: httpx.Response(200, json={"results": []}))
    assert await geocode.reverse(*HOME_POINT) is None


async def test_reverse_degrades_to_none_on_an_upstream_error(patch_httpx):
    patch_httpx(lambda r: httpx.Response(500, text="boom"))
    assert await geocode.reverse(*HOME_POINT) is None


async def test_reverse_degrades_to_none_on_malformed_json(patch_httpx):
    patch_httpx(lambda r: httpx.Response(200, text="not json"))
    assert await geocode.reverse(*HOME_POINT) is None


# --- search() -------------------------------------------------------------------------


async def test_search_blank_address_short_circuits_without_a_request(patch_httpx):
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"results": []})

    patch_httpx(handler)
    assert await geocode.search("   ") == []
    assert calls["n"] == 0


async def test_search_short_circuits_when_the_geocoder_url_is_invalid(monkeypatch, patch_httpx):
    monkeypatch.setattr(geocode, "_GEOCODER_OK", False)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"results": []})

    patch_httpx(handler)
    assert await geocode.search("Storchenweg 8") == []
    assert calls["n"] == 0


async def test_search_applies_the_region_bias_and_reranks_the_home_town_first(patch_httpx, monkeypatch):
    monkeypatch.setattr(settings, "geocoder_default_locality", "4104 Oberwil", raising=False)
    monkeypatch.setattr(settings, "geocoder_bbox_lv95", "2610000,1265000,2620000,1267000", raising=False)
    seen_params = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_params.append(dict(request.url.params))
        return httpx.Response(
            200,
            json={
                "results": [
                    {"attrs": {"lat": 47.51, "lon": 7.56, "label": "Hauptstrasse 10 4103 Bottmingen"}},
                    {"attrs": {"lat": 47.52, "lon": 7.57, "label": "Hauptstrasse 10 4104 Oberwil BL"}},
                ]
            },
        )

    patch_httpx(handler)
    hits = await geocode.search("Hauptstrasse 10")
    assert [h.label for h in hits] == ["Hauptstrasse 10 4104 Oberwil BL", "Hauptstrasse 10 4103 Bottmingen"]
    # Pass 1 carries the bbox + sortbbox and the locality-appended search text.
    assert seen_params[0]["bbox"] == "2610000,1265000,2620000,1267000"
    assert seen_params[0]["sortbbox"] == "true"
    assert seen_params[0]["searchText"] == "Hauptstrasse 10 4104 Oberwil"


async def test_search_retries_unbiased_when_the_biased_pass_finds_nothing(patch_httpx, monkeypatch):
    """Mutual aid in a neighbouring town: the region bbox excludes it on pass 1, so pass 2
    drops the bias and searches nationally instead of answering an empty list."""
    monkeypatch.setattr(settings, "geocoder_default_locality", "4104 Oberwil", raising=False)
    monkeypatch.setattr(settings, "geocoder_bbox_lv95", "2610000,1265000,2620000,1267000", raising=False)
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        params = dict(request.url.params)
        calls.append(params)
        if "bbox" in params:
            return httpx.Response(200, json={"results": []})
        return httpx.Response(200, json={"results": [{"attrs": {"lat": 46.0, "lon": 6.0, "label": "Weit weg 1"}}]})

    patch_httpx(handler)
    hits = await geocode.search("Weit weg 1")
    assert [h.label for h in hits] == ["Weit weg 1"]
    assert len(calls) == 2
    assert "bbox" not in calls[1]


async def test_search_with_no_bias_configured_is_a_single_national_pass(patch_httpx, monkeypatch):
    """No bbox → no retry-on-empty either: the first pass is already unbiased, so a second,
    identical request would only waste a round-trip."""
    monkeypatch.setattr(settings, "geocoder_default_locality", "", raising=False)
    monkeypatch.setattr(settings, "geocoder_bbox_lv95", "", raising=False)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        assert "bbox" not in dict(request.url.params)
        return httpx.Response(200, json={"results": []})

    patch_httpx(handler)
    assert await geocode.search("Nirgendwo") == []
    assert calls["n"] == 1


async def test_search_degrades_to_empty_list_on_an_upstream_error(patch_httpx, monkeypatch):
    monkeypatch.setattr(settings, "geocoder_default_locality", "", raising=False)
    monkeypatch.setattr(settings, "geocoder_bbox_lv95", "", raising=False)
    patch_httpx(lambda r: httpx.Response(503, text="boom"))
    assert await geocode.search("Storchenweg 8") == []


async def test_search_degrades_to_empty_list_on_malformed_json(patch_httpx, monkeypatch):
    monkeypatch.setattr(settings, "geocoder_default_locality", "", raising=False)
    monkeypatch.setattr(settings, "geocoder_bbox_lv95", "", raising=False)
    patch_httpx(lambda r: httpx.Response(200, text="not json"))
    assert await geocode.search("Storchenweg 8") == []


# --- geocode(): thin single-result wrapper over search() -------------------------------


async def test_geocode_wrapper_returns_the_first_hits_coordinates(patch_httpx, monkeypatch):
    monkeypatch.setattr(settings, "geocoder_default_locality", "", raising=False)
    monkeypatch.setattr(settings, "geocoder_bbox_lv95", "", raising=False)
    patch_httpx(lambda r: httpx.Response(200, json={"results": [{"attrs": {"lat": 47.5, "lon": 7.5, "label": "X"}}]}))
    assert await geocode.geocode("Storchenweg 8") == (47.5, 7.5)


async def test_geocode_wrapper_is_none_on_no_hits(patch_httpx, monkeypatch):
    monkeypatch.setattr(settings, "geocoder_default_locality", "", raising=False)
    monkeypatch.setattr(settings, "geocoder_bbox_lv95", "", raising=False)
    patch_httpx(lambda r: httpx.Response(200, json={"results": []}))
    assert await geocode.geocode("Nirgendwo") is None


# --- _resolve_bias(): DeploymentConfig-first, settings fallback, cached, never raises ---
#
# `_resolve_bias` opens its own session straight off `app.database.async_session_maker`
# rather than the request-scoped `get_db` the `client`/`db_session` fixtures override — and
# asyncpg connections are bound to the event loop they were opened on, which doesn't survive
# a real DB round-trip across pytest-asyncio's per-test loop. A tiny fake session (below)
# exercises the exact two calls the function makes — `db.execute(select(...))` then
# `.scalar_one_or_none()` — without touching a real connection at all.


class _FakeConfigResult:
    def __init__(self, row):
        self._row = row

    def scalar_one_or_none(self):
        return self._row


class _FakeConfigSession:
    def __init__(self, row):
        self._row = row

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def execute(self, _stmt):
        return _FakeConfigResult(self._row)


def _fake_session_maker(row):
    """A stand-in for `async_session_maker` that always hands back the given config row."""

    def _factory():
        return _FakeConfigSession(row)

    return _factory


async def test_resolve_bias_prefers_deployment_config_over_settings(monkeypatch):
    import app.database as database_module
    from app.models import DeploymentConfig

    monkeypatch.setattr(settings, "geocoder_default_locality", "4104 Oberwil", raising=False)
    monkeypatch.setattr(settings, "geocoder_bbox_lv95", "1,2,3,4", raising=False)
    row = DeploymentConfig(
        id=1,
        config_json={"map": {"geocoder": {"defaultLocality": "4144 Arlesheim", "bboxLv95": "9,9,9,9"}}},
    )
    monkeypatch.setattr(database_module, "async_session_maker", _fake_session_maker(row))

    assert await geocode._resolve_bias() == ("4144 Arlesheim", "9,9,9,9")


async def test_resolve_bias_falls_back_to_settings_when_the_config_section_is_empty(monkeypatch):
    import app.database as database_module
    from app.models import DeploymentConfig

    monkeypatch.setattr(settings, "geocoder_default_locality", "4104 Oberwil", raising=False)
    monkeypatch.setattr(settings, "geocoder_bbox_lv95", "1,2,3,4", raising=False)
    row = DeploymentConfig(id=1, config_json={"map": {"geocoder": {}}})
    monkeypatch.setattr(database_module, "async_session_maker", _fake_session_maker(row))

    assert await geocode._resolve_bias() == ("4104 Oberwil", "1,2,3,4")


async def test_resolve_bias_degrades_to_settings_when_the_db_lookup_fails(monkeypatch):
    """Never raises: a broken DB must not turn every address lookup into a 500."""
    import app.database as database_module

    monkeypatch.setattr(settings, "geocoder_default_locality", "4104 Oberwil", raising=False)
    monkeypatch.setattr(settings, "geocoder_bbox_lv95", "1,2,3,4", raising=False)

    def _boom():
        raise RuntimeError("db is down")

    monkeypatch.setattr(database_module, "async_session_maker", _boom)
    assert await geocode._resolve_bias() == ("4104 Oberwil", "1,2,3,4")


async def test_resolve_bias_cache_hit_never_touches_the_db(monkeypatch):
    """Every keystroke of the intake autocomplete calls search() → _resolve_bias(); a cache
    hit inside the TTL must not re-query DeploymentConfig each time."""
    import app.database as database_module

    def _boom():
        raise AssertionError("cache hit should not reach the DB")

    monkeypatch.setattr(database_module, "async_session_maker", _boom)
    geocode._bias_cache = (geocode.time.monotonic(), ("cached-locality", "cached-bbox"))
    assert await geocode._resolve_bias() == ("cached-locality", "cached-bbox")


# =====================================================================================
# app.traccar
# =====================================================================================

# --- is_configured / host: the https-only SSRF guard + status-display hostname ---------


def test_is_configured_requires_all_three_credentials(monkeypatch):
    monkeypatch.setattr(settings, "traccar_url", "https://traccar.example.com", raising=False)
    monkeypatch.setattr(settings, "traccar_email", "", raising=False)
    monkeypatch.setattr(settings, "traccar_password", "secret", raising=False)
    assert traccar.traccar_client.is_configured is False


def test_is_configured_rejects_http(monkeypatch):
    """A plain http:// TRACCAR_URL must not become a way to reach an internal endpoint."""
    monkeypatch.setattr(settings, "traccar_url", "http://traccar.example.com", raising=False)
    monkeypatch.setattr(settings, "traccar_email", "ops@example.com", raising=False)
    monkeypatch.setattr(settings, "traccar_password", "secret", raising=False)
    assert traccar.traccar_client.is_configured is False


def test_is_configured_true_when_https_and_complete(monkeypatch):
    monkeypatch.setattr(settings, "traccar_url", "https://traccar.example.com", raising=False)
    monkeypatch.setattr(settings, "traccar_email", "ops@example.com", raising=False)
    monkeypatch.setattr(settings, "traccar_password", "secret", raising=False)
    assert traccar.traccar_client.is_configured is True


def test_host_is_none_when_unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "traccar_url", "", raising=False)
    assert traccar.traccar_client.host is None


def test_host_strips_scheme_and_port_for_display(monkeypatch):
    monkeypatch.setattr(settings, "traccar_url", "https://fleet.example.com:8443", raising=False)
    assert traccar.traccar_client.host == "fleet.example.com"


# --- unconfigured client: [] without ever opening a connection -------------------------


async def test_get_vehicle_positions_is_empty_when_unconfigured(monkeypatch, patch_httpx):
    monkeypatch.setattr(settings, "traccar_url", "", raising=False)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=[])

    patch_httpx(handler)
    assert await traccar.traccar_client.get_vehicle_positions() == []
    assert calls["n"] == 0


async def test_get_trails_is_empty_when_unconfigured(monkeypatch, patch_httpx):
    monkeypatch.setattr(settings, "traccar_url", "", raising=False)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=[])

    patch_httpx(handler)
    assert await traccar.traccar_client.get_trails() == []
    assert calls["n"] == 0


# --- configured client: session → devices → positions -----------------------------------


@pytest.fixture
def configured_traccar(monkeypatch):
    monkeypatch.setattr(settings, "traccar_url", "https://traccar.example.com", raising=False)
    monkeypatch.setattr(settings, "traccar_email", "ops@example.com", raising=False)
    monkeypatch.setattr(settings, "traccar_password", "secret", raising=False)


DEVICES = [
    {"id": 1, "name": "TLF", "uniqueId": "tlf-1", "status": "online"},
    {"id": 2, "name": "MTF", "uniqueId": "mtf-1", "status": "offline"},
]


async def test_get_vehicle_positions_converts_knots_and_drops_orphan_positions(patch_httpx, configured_traccar):
    """A position whose deviceId has no matching device (decommissioned, still reporting
    for a while) is dropped rather than surfaced with a missing name/uniqueId."""
    positions = [
        {
            "deviceId": 1,
            "latitude": 47.5,
            "longitude": 7.5,
            "speed": 10.0,  # knots
            "course": 90,
            "deviceTime": "2026-09-02T10:00:00Z",
            "address": "Hauptstrasse 1",
        },
        {"deviceId": 99, "latitude": 47.6, "longitude": 7.6, "deviceTime": "2026-09-02T10:00:00Z"},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api/session"):
            return httpx.Response(200, json={})
        if request.url.path.endswith("/api/devices"):
            return httpx.Response(200, json=DEVICES)
        if request.url.path.endswith("/api/positions"):
            return httpx.Response(200, json=positions)
        raise AssertionError(f"unexpected request: {request.url}")

    patch_httpx(handler)
    result = await traccar.traccar_client.get_vehicle_positions()
    assert len(result) == 1
    p = result[0]
    assert p.device_id == 1
    assert p.device_name == "TLF"
    assert p.speed == pytest.approx(18.52)  # 10 knots → km/h
    assert p.address == "Hauptstrasse 1"


async def test_get_vehicle_positions_propagates_a_failed_login(patch_httpx, configured_traccar):
    """A bad login answers 401; the client does not swallow it — app/api/traccar.py ‑
    the caller in production — is the layer that turns an httpx.HTTPError into a clean 502
    instead of this becoming an unhandled 500."""
    patch_httpx(lambda r: httpx.Response(401, text="bad credentials"))
    with pytest.raises(httpx.HTTPStatusError):
        await traccar.traccar_client.get_vehicle_positions()


DEVICES_FOR_TRAILS = [
    {"id": 1, "name": "TLF"},
    {"id": 2, "name": "MTF"},
    {"id": 3, "name": "PIKW"},
]


async def test_get_trails_drops_failing_and_empty_devices(patch_httpx, configured_traccar):
    """Per-device history is fetched concurrently; a device that 500s (checked via
    status_code, not raise_for_status) and one with no points in the window are both
    dropped silently rather than failing the whole /trails response."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api/session"):
            return httpx.Response(200, json={})
        if request.url.path.endswith("/api/devices"):
            return httpx.Response(200, json=DEVICES_FOR_TRAILS)
        device_id = request.url.params.get("deviceId")
        if device_id == "1":
            return httpx.Response(
                200,
                json=[{"latitude": 47.5, "longitude": 7.5, "deviceTime": "t", "course": 1, "speed": 5.0}],
            )
        if device_id == "2":
            return httpx.Response(500, text="boom")
        if device_id == "3":
            return httpx.Response(200, json=[])
        raise AssertionError(f"unexpected device {device_id}")

    patch_httpx(handler)
    trails = await traccar.traccar_client.get_trails(minutes=15)
    assert [t.device_id for t in trails] == [1]
    assert trails[0].points[0]["speed"] == pytest.approx(9.26)  # 5 knots → km/h


# =====================================================================================
# app.overpass
# =====================================================================================

# --- mirrors(): blank-entry skip (comma-list parsing edge) -----------------------------


def test_mirrors_skips_blank_entries(monkeypatch):
    """A trailing/doubled comma in OVERPASS_MIRRORS must not become an empty mirror URL."""
    monkeypatch.setattr(
        overpass.settings,
        "overpass_mirrors",
        "https://a.example/api,,https://b.example/api,",
        raising=False,
    )
    assert overpass.mirrors() == ["https://a.example/api", "https://b.example/api"]


# --- fetch_buildings(): mirror race, fail-closed, degrade on total failure -------------


async def test_fetch_buildings_raises_when_no_mirrors_configured(monkeypatch):
    """Distinguishable from an upstream failure: the caller (app/api/overpass.py) answers
    503 for this, not 502 — a station simply hasn't set OVERPASS_MIRRORS."""
    monkeypatch.setattr(overpass, "mirrors", list)
    with pytest.raises(RuntimeError, match="no Overpass mirrors configured"):
        await overpass.fetch_buildings("out body;")


async def test_fetch_buildings_posts_form_encoded_query_with_the_user_agent(patch_httpx, monkeypatch):
    monkeypatch.setattr(overpass, "mirrors", lambda: ["https://only.example/api"])
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["content_type"] = request.headers.get("content-type")
        seen["user_agent"] = request.headers.get("user-agent")
        seen["body"] = request.content.decode()
        return httpx.Response(200, json={"elements": []})

    patch_httpx(handler)
    await overpass.fetch_buildings("out body qt;")
    assert seen["content_type"] == "application/x-www-form-urlencoded"
    assert seen["user_agent"] == overpass._USER_AGENT
    assert seen["body"] == "data=out body qt;"


async def test_fetch_buildings_falls_through_a_failing_mirror_to_a_working_one(patch_httpx, monkeypatch):
    """Three mirrors, staggered: `bad` fails instantly, `good` succeeds a beat later, and
    `slow` is still in flight when `good` wins — exercising both the second `asyncio.wait`
    round (the winner isn't in the very first FIRST_COMPLETED batch) and the finally block
    actually cancelling a still-pending mirror rather than finding nothing left to cancel."""
    monkeypatch.setattr(
        overpass,
        "mirrors",
        lambda: ["https://bad.example/api", "https://good.example/api", "https://slow.example/api"],
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        if "bad.example" in request.url.host:
            return httpx.Response(500, text="query rejected")
        if "slow.example" in request.url.host:
            await asyncio.sleep(5)  # never resolves within the test — must be cancelled
            return httpx.Response(200, json={"elements": ["too-late"]})
        await asyncio.sleep(0.01)
        return httpx.Response(200, json={"elements": ["ok"]})

    patch_httpx(handler)
    assert await overpass.fetch_buildings("out body;") == {"elements": ["ok"]}


async def test_fetch_buildings_returns_whichever_mirror_wins_the_race(patch_httpx, monkeypatch):
    """Both mirrors succeed; the race is genuinely first-completed, so either answer is a
    pass — this pins that a successful race returns *a* result, not that mirror order is
    deterministic (it isn't: `asyncio.wait(..., FIRST_COMPLETED)` doesn't guarantee it)."""
    monkeypatch.setattr(overpass, "mirrors", lambda: ["https://a.example/api", "https://b.example/api"])

    def handler(request: httpx.Request) -> httpx.Response:
        tag = "from-a" if "a.example" in request.url.host else "from-b"
        return httpx.Response(200, json={"elements": [tag]})

    patch_httpx(handler)
    result = await overpass.fetch_buildings("out body;")
    assert result["elements"] in (["from-a"], ["from-b"])


async def test_fetch_buildings_raises_when_every_mirror_fails(patch_httpx, monkeypatch):
    monkeypatch.setattr(overpass, "mirrors", lambda: ["https://a.example/api", "https://b.example/api"])
    patch_httpx(lambda r: httpx.Response(504, text="gateway timeout"))
    with pytest.raises(RuntimeError, match="all Overpass mirrors failed"):
        await overpass.fetch_buildings("out body;")

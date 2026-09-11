"""What `admin_config validate|load|push` tells the operator about a file it accepted.

Every config model is `extra="ignore"`, which is what lets an older deployment read a newer file
— and it means a misspelled key is indistinguishable from an intent. A file of nothing but
`identitiy` / `map.defaultview` / `doctrin` validated clean, and the summary line still read
«Top-level keys set: identity, map, …» because a normalized document has every section present
with its defaults filled in. Both halves of that «OK» were untrue.
"""

import httpx

from app.admin_config import _push, _summary
from app.config_guard import ignored_keys, layer_warnings
from app.schemas import DeploymentConfigIn


def _normalized(raw: dict) -> dict:
    return DeploymentConfigIn(**raw).model_dump(mode="json")


def test_a_config_that_configures_nothing_says_so():
    """The defaults filled in by normalization are not things this station set."""
    assert _summary(_normalized({})) == "(none — empty config)"
    assert _summary(_normalized({"identitiy": {"appName": "X"}, "doctrin": {}})) == "(none — empty config)"


def test_what_the_file_really_sets_is_still_named():
    assert _summary(_normalized({"identity": {"appName": "Feuerwehr Musterdorf"}})) == "identity"
    summary = _summary(_normalized({"identity": {"appName": "X"}, "doctrine": {"alarmBar": 90}}))
    assert summary == "identity, doctrine"


def test_dry_run_names_defaults_that_would_overwrite_a_stored_non_default():
    stored = _normalized({"alarms": {"autoArchiveDays": 30}})
    incoming = _normalized({})

    assert _summary(incoming) == "(none — empty config)"
    assert _summary(incoming, stored) == "alarms"


def test_dropped_keys_are_named_with_a_did_you_mean():
    lines = ignored_keys(
        {"identitiy": {"appName": "X"}, "map": {"defaultview": {}}, "doctrin": {}, "wetterstation": True}
    )
    assert lines == [
        "identitiy — did you mean identity?",
        "map.defaultview — did you mean map.defaultView?",
        "doctrin — did you mean doctrine?",
        # nothing in the schema is close to this, and a wrong suggestion reads as confirmation
        "wetterstation",
    ]


def test_a_correct_file_is_reported_clean():
    assert ignored_keys({"identity": {"appName": "X", "accentColor": "#fff"}, "modules": []}) == []


def test_a_geojson_layer_the_app_cannot_fetch_is_flagged():
    """The string goes straight to MapLibre as a URL (src/lib/deploymentConfig · mapReferenceLayers).
    A bare filename resolves against the app's own routes and 404s — the layer is listed in the
    Ebenen panel and draws nothing, which is exactly what nobody notices until an Einsatz."""
    [warning] = layer_warnings(
        {"referenceLayers": [{"id": "hydrant", "kind": "geojson", "geojson": "hydranten.geojson"}]}
    )
    assert "'hydrant'" in warning
    assert "hydranten.geojson" in warning


def test_the_two_shapes_that_do_resolve_are_quiet():
    assert (
        layer_warnings(
            {
                "referenceLayers": [
                    {"id": "a", "kind": "geojson", "geojson": "/api/reference/geo:hydrant"},
                    {"id": "b", "kind": "geojson", "geojson": "https://geo.example.ch/h.geojson"},
                    {"id": "c", "kind": "wms", "tiles": ["https://example.ch/{z}/{x}/{y}.png"]},
                ]
            }
        )
        == []
    )


# --- push: the local refusal and the server's now have to agree -------------------------


class _FakeClient:
    """Just enough of `httpx.Client` for `_push`: an admin login, a config GET, a config PUT."""

    def __init__(self, remote: dict) -> None:
        self.remote = remote
        self.put_params: dict | None = None

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return None

    def post(self, url: str, **_kw):
        assert url == "/api/admin/login"
        return httpx.Response(200, json={"ok": True})

    def get(self, url: str, **_kw):
        assert url == "/api/config"
        return httpx.Response(200, json=self.remote)

    def put(self, url: str, **kw):
        assert url == "/api/config"
        self.put_params = kw.get("params")
        return httpx.Response(200, json={})


#: A deployment with a section somebody filled in — what an old file would empty.
REMOTE = {"identity": {"appName": "Feuerwehr Musterdorf"}, "report": {"partnerOrgs": ["Polizei"]}, "version": "v1"}
TALHEIM = {"identity": {"appName": "Feuerwehr Talheim"}}


def test_a_push_that_would_empty_a_section_is_refused_locally(monkeypatch, capsys):
    """The refusal a person reads at a terminal: it names the section and the flag. The server
    refuses this too, but a 409 is not a sentence anybody can act on."""
    fake = _FakeClient(REMOTE)
    monkeypatch.setattr(httpx, "Client", lambda **_kw: fake)

    code = _push({}, _normalized(TALHEIM), "https://s.example", "s", False, False)

    assert code == 2
    assert fake.put_params is None, "a refused push must not reach the deployment at all"
    assert "report.partnerOrgs" in capsys.readouterr().err


def test_force_is_sent_to_the_server_as_well_as_honoured_here(monkeypatch):
    """⚠️ `--force` is now two things: the local refusal it always overrode, and `?force=true` on
    the wire. The server refuses the same write (api/config · put_config), so without the query
    parameter a forced push would be rejected by the deployment it was told to change."""
    fake = _FakeClient(REMOTE)
    monkeypatch.setattr(httpx, "Client", lambda **_kw: fake)

    code = _push({}, _normalized(TALHEIM), "https://s.example", "s", False, True)

    assert code == 0
    assert fake.put_params == {"force": "true"}


def test_an_ordinary_push_sends_no_force(monkeypatch):
    fake = _FakeClient(REMOTE)
    monkeypatch.setattr(httpx, "Client", lambda **_kw: fake)

    code = _push({}, _normalized(REMOTE), "https://s.example", "s", False, False)

    assert code == 0
    assert fake.put_params == {}

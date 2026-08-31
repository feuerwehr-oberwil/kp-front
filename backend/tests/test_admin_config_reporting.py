"""What `admin_config validate|load|push` tells the operator about a file it accepted.

Every config model is `extra="ignore"`, which is what lets an older deployment read a newer file
— and it means a misspelled key is indistinguishable from an intent. A file of nothing but
`identitiy` / `map.defaultview` / `doctrin` validated clean, and the summary line still read
«Top-level keys set: identity, map, …» because a normalized document has every section present
with its defaults filled in. Both halves of that «OK» were untrue.
"""

from app.admin_config import _ignored_keys, _layer_warnings, _summary
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
    lines = _ignored_keys(
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
    assert _ignored_keys({"identity": {"appName": "X", "accentColor": "#fff"}, "modules": []}) == []


def test_a_geojson_layer_the_app_cannot_fetch_is_flagged():
    """The string goes straight to MapLibre as a URL (src/lib/deploymentConfig · mapReferenceLayers).
    A bare filename resolves against the app's own routes and 404s — the layer is listed in the
    Ebenen panel and draws nothing, which is exactly what nobody notices until an Einsatz."""
    [warning] = _layer_warnings(
        {"referenceLayers": [{"id": "hydrant", "kind": "geojson", "geojson": "hydranten.geojson"}]}
    )
    assert "'hydrant'" in warning
    assert "hydranten.geojson" in warning


def test_the_two_shapes_that_do_resolve_are_quiet():
    assert (
        _layer_warnings(
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

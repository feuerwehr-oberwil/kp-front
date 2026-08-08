"""`admin_config load` must not delete what it cannot write.

`identity.assets` and `referenceLayers` are written at RUNTIME — by a branding upload and by a
geodata push — and no config FILE names them, because the URLs inside them only exist once the
blob is stored. A plain load used to drop both. That is how the public demo lost its logo and,
on 08.08., its hydrants: the reset script loads the config first and re-pushes afterwards, so a
run that dies in between left the demo stripped. Same trap for a station: upload a logo, load a
config change an hour later, logo gone, nothing said.
"""

from app.admin_config import _carry_runtime_sections

STORED = {
    "identity": {
        "appName": "Feuerwehr Oberwil",
        "assets": {"logo": "/api/branding/file/branding/a.png", "favicon": None},
    },
    "referenceLayers": [{"id": "hydranten"}, {"id": "wasserleitung"}],
    "map": {"zoom": 15},
}


def test_carries_what_the_file_does_not_name():
    incoming = {"identity": {"appName": "Feuerwehr Musterdorf"}, "map": {"zoom": 16}}
    carried = _carry_runtime_sections(STORED, incoming)
    assert set(carried) == {"referenceLayers", "identity.assets"}
    assert incoming["identity"]["assets"] == {"logo": "/api/branding/file/branding/a.png"}
    assert len(incoming["referenceLayers"]) == 2
    # ...and the file still wins for everything it DOES name — this is config-as-code
    assert incoming["identity"]["appName"] == "Feuerwehr Musterdorf"
    assert incoming["map"] == {"zoom": 16}


def test_a_file_that_names_them_keeps_its_own():
    incoming = {"identity": {"assets": {"logo": "/explicit.png"}}, "referenceLayers": [{"id": "own"}]}
    assert _carry_runtime_sections(STORED, incoming) == []
    assert incoming["identity"]["assets"] == {"logo": "/explicit.png"}
    assert incoming["referenceLayers"] == [{"id": "own"}]


def test_nothing_stored_yet_is_not_an_error():
    incoming = {"identity": {"appName": "X"}}
    assert _carry_runtime_sections(None, incoming) == []
    assert _carry_runtime_sections({}, incoming) == []
    assert incoming == {"identity": {"appName": "X"}}


def test_empty_slots_are_not_carried_as_if_they_were_set():
    """An assets block of nothing but nulls is not a logo — carrying it would report a
    carry-over that restored nothing and hide that the station has no mark."""
    stored = {"identity": {"assets": {"logo": None, "favicon": None}}, "referenceLayers": []}
    incoming = {"identity": {"appName": "X"}}
    assert _carry_runtime_sections(stored, incoming) == []
    assert "assets" not in incoming["identity"]

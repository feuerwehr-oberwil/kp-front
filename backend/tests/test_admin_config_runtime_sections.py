"""`admin_config load` must not delete what it cannot write.

`identity.assets` and `referenceLayers` are written at RUNTIME — by a branding upload and by a
geodata push — and no config FILE names them, because the URLs inside them only exist once the
blob is stored. A plain load used to drop both. That is how the public demo lost its logo and,
on 08.08., its hydrants: the reset script loads the config first and re-pushes afterwards, so a
run that dies in between left the demo stripped. Same trap for a station: upload a logo, load a
config change an hour later, logo gone, nothing said.
"""

import pytest

import app.admin_config as admin_config
from app.config_guard import carry_runtime_sections

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
    carried = carry_runtime_sections(STORED, incoming)
    assert set(carried) == {"referenceLayers", "identity.assets"}
    assert incoming["identity"]["assets"] == {"logo": "/api/branding/file/branding/a.png"}
    assert len(incoming["referenceLayers"]) == 2
    # ...and the file still wins for everything it DOES name — this is config-as-code
    assert incoming["identity"]["appName"] == "Feuerwehr Musterdorf"
    assert incoming["map"] == {"zoom": 16}


def test_a_file_that_names_the_layers_keeps_its_own():
    incoming = {"referenceLayers": [{"id": "own"}]}
    assert "referenceLayers" not in carry_runtime_sections(STORED, incoming)
    assert incoming["referenceLayers"] == [{"id": "own"}]


def test_a_stored_brandmark_survives_a_file_that_names_a_different_one():
    """⚠️ `identity.assets` is not config-as-code, whatever a file says. The URL behind a slot
    only exists once a blob has been stored, so a document naming `/explicit.png` names nothing
    the deployment can serve — while the stored slot points at a blob that IS there. Installing
    a brandmark is `admin_branding` / the upload endpoints; removing one is DELETE
    /api/branding/{slot}. The slots are merged one by one, so a file carrying a logo and a null
    favicon cannot take the favicon with it.
    """
    incoming = {"identity": {"assets": {"logo": "/explicit.png", "favicon": None}}}
    assert "identity.assets" in carry_runtime_sections(STORED, incoming)
    assert incoming["identity"]["assets"]["logo"] == STORED["identity"]["assets"]["logo"]


def test_nothing_stored_yet_is_not_an_error():
    incoming = {"identity": {"appName": "X"}}
    assert carry_runtime_sections(None, incoming) == []
    assert carry_runtime_sections({}, incoming) == []
    assert incoming == {"identity": {"appName": "X"}}


def test_empty_slots_are_not_carried_as_if_they_were_set():
    """An assets block of nothing but nulls is not a logo — carrying it would report a
    carry-over that restored nothing and hide that the station has no mark."""
    stored = {"identity": {"assets": {"logo": None, "favicon": None}}, "referenceLayers": []}
    incoming = {"identity": {"appName": "X"}}
    assert carry_runtime_sections(stored, incoming) == []
    assert "assets" not in incoming["identity"]


@pytest.mark.asyncio
async def test_diff_reports_what_load_will_actually_keep(monkeypatch, capsys):
    incoming = {"identity": {"appName": "Feuerwehr Musterdorf"}}
    monkeypatch.setattr(admin_config, "_read_and_validate", lambda _path: ({}, incoming))

    async def stored():
        return STORED

    monkeypatch.setattr(admin_config, "_show", stored)
    assert await admin_config._amain(["diff", "station.json"]) == 0

    out = capsys.readouterr().out
    assert "kept from the stored config (runtime-written):" in out
    assert "referenceLayers" in out
    assert "identity.assets" in out
    assert "referenceLayers:" not in out.split("kept from", 1)[0]

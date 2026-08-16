"""An Einsatzobjekt's id is an upsert key, so nobody should be inventing one by hand.

The shipped example manifest used to carry a literal ``11111111-2222-5333-8444-555555555555``
and ``admin_objects schema`` marked ``id`` required with no description. An operator who reuses
that placeholder for a second object, or retypes it a year later with one digit wrong, does not
get an error — the upsert matches on the id and nothing else, so they get a DUPLICATE object and
a plan library that quietly splits in two. ``key`` is the retypable half of the fix.
"""

import json
import uuid
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app import admin_objects
from app.admin_objects import ObjectEntry, _read_manifest, object_id_for_key
from app.models import ObjectSite


def _manifest(tmp: Path, obj: dict) -> Path:
    mp = tmp / "objects.manifest.json"
    mp.write_text(json.dumps({"objects": [obj]}), encoding="utf-8")
    return mp


def test_the_same_key_yields_the_same_id_every_time():
    """The whole point: next year's rerun has to address this year's object."""
    first = object_id_for_key("schulhaus-dorfmatt")
    second = object_id_for_key("schulhaus-dorfmatt")
    assert first == second
    assert first.version == 5
    # ...and pinned, so a refactor of the namespace or the normalisation is a visible break
    # rather than a silent duplication of every keyed object in every station.
    assert str(first) == "f4db7b86-e0fb-5ba7-856d-8e356d2ff3af"


def test_a_retyped_key_still_lands_on_the_same_object():
    """Case and stray whitespace are what a human gets wrong; neither may fork the object."""
    assert object_id_for_key("Schulhaus Dorfmatt") == object_id_for_key("  schulhaus   dorfmatt ")


def test_different_keys_are_different_objects():
    assert object_id_for_key("wache") != object_id_for_key("schulhaus")


def test_a_key_manifest_resolves_to_the_hashed_id(tmp_path: Path):
    mp = _manifest(tmp_path, {"key": "schulhaus-dorfmatt", "name": "Schulhaus Dorfmatt"})
    (entry,) = _read_manifest(mp)
    assert entry.id is None  # kept verbatim: the manifest said `key`, not `id`
    assert entry.object_id == object_id_for_key("schulhaus-dorfmatt")


def test_an_id_manifest_still_works_untouched(tmp_path: Path):
    """Existing manifests are machine-written by the private importer and must keep loading."""
    oid = "d0000000-0000-5000-8000-00000000b077"
    mp = _manifest(tmp_path, {"id": oid, "name": "Schloss"})
    (entry,) = _read_manifest(mp)
    assert entry.object_id == uuid.UUID(oid)


def test_neither_id_nor_key_is_refused():
    with pytest.raises(ValueError, match="key"):
        ObjectEntry(name="Namenlos")


def test_an_id_that_contradicts_its_key_is_refused():
    """Two disagreeing keys in one entry is precisely how an object gets duplicated — so it is
    the manifest that fails, not the deployment."""
    with pytest.raises(ValueError, match="not the uuid5"):
        ObjectEntry(id="11111111-2222-5333-8444-555555555555", key="schulhaus-dorfmatt", name="Schulhaus")


def test_the_schema_documents_the_key(tmp_path: Path):
    """`admin_objects schema` is the contract an operator reads before writing a manifest."""
    props = ObjectEntry.model_json_schema()["properties"]
    assert "uuid5" in props["key"]["description"]
    assert props["id"]["description"], "'id' shipped with no description at all"


def test_the_shipped_example_manifest_no_longer_hands_out_a_uuid(tmp_path: Path):
    example = Path(__file__).resolve().parents[1] / "objects.manifest.example.json"
    objects = json.loads(example.read_text(encoding="utf-8"))["objects"]
    assert all("id" not in o for o in objects), "the template still invites a copied UUID"
    assert all(o.get("key") for o in objects)


async def test_loading_the_same_key_twice_updates_one_row(tmp_path: Path, session_factory, db_session, monkeypatch):
    """The DB half of the promise, and the actual question an operator has: does next year's
    rerun edit this object or add a second one next to it?"""
    monkeypatch.setattr(admin_objects, "async_session_maker", session_factory)

    first = _manifest(tmp_path, {"key": "Schulhaus Dorfmatt", "name": "Schulhaus Dorfmatt"})
    res = await admin_objects._load(first, _read_manifest(first))
    assert res.created == ["Schulhaus Dorfmatt"] and res.updated == []

    # Retyped a year later — different case, extra spaces, corrected name.
    second = _manifest(tmp_path, {"key": "  schulhaus   dorfmatt", "name": "Schulhaus Dorfmatt (Neubau)"})
    res = await admin_objects._load(second, _read_manifest(second))
    assert res.created == [] and res.updated == ["Schulhaus Dorfmatt (Neubau)"]

    rows = (await db_session.execute(select(func.count()).select_from(ObjectSite))).scalar_one()
    assert rows == 1, "the retyped key created a second Einsatzobjekt"
    stored = (await db_session.execute(select(ObjectSite))).scalar_one()
    assert stored.id == object_id_for_key("schulhaus-dorfmatt".replace("-", " "))
    assert stored.name == "Schulhaus Dorfmatt (Neubau)"

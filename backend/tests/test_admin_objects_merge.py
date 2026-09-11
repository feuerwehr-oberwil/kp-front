"""Two folder names that look identical are one Einsatzobjekt — and merging them may not lose a
single plan, landmark pair or picked object.

The FWO deployment carries ~195 objects for ~157 real ones: an import that read the plan-library
folder names off a Mac spelled «ü» as ``u`` + U+0308 while every other run spelled it U+00FC, and
``object_id_for_key`` hashes the string, so the same letters minted two ids. `merge-duplicates`
folds them back together; these tests pin the parts that are dangerous — that everything pointing
at the loser follows it, that a plan slot already on the survivor is never overwritten, and that
the default run writes nothing at all.
"""

import unicodedata
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from app import admin_objects
from app.admin_objects import object_id_for_key
from app.models import (
    DeploymentConfig,
    Incident,
    IncidentEvent,
    JournalEntry,
    ObjectSite,
    ReferenceDataset,
)

NFC_NAME = "Kindergarten Hüsli"  # ü = U+00FC
NFD_NAME = unicodedata.normalize("NFD", NFC_NAME)  # ü = u + U+0308


@pytest.fixture(autouse=True)
def _cli_session(monkeypatch, session_factory):
    """The CLI opens its own session; point it at the test database."""
    monkeypatch.setattr(admin_objects, "async_session_maker", session_factory)


async def _object(
    db,
    name: str,
    *,
    oid: uuid.UUID | None = None,
    plans: dict[str, str | None] | None = None,
    source_key: str | None = None,
    updated_at: datetime | None = None,
) -> uuid.UUID:
    """One stored Einsatzobjekt + its plan rows ({module: source_digest})."""
    oid = oid or object_id_for_key(name)
    db.add(ObjectSite(id=oid, name=name, source_key=source_key, updated_at=updated_at or datetime.now(UTC)))
    for module, digest in (plans or {}).items():
        db.add(
            ReferenceDataset(
                id=f"plan:{oid}:{module}",
                object_id=oid,
                module=module,
                kind="pdf",
                title=f"{name} – {module}",
                storage_key=f"plans/{oid}/{module}.pdf",
                source_digest=digest,
            )
        )
    await db.commit()
    return oid


async def _scales(db, doc: dict[str, object]) -> None:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1)
        db.add(row)
    row.plan_scales_json = doc
    await db.commit()


async def _incident(db, *, picked: uuid.UUID | None = None) -> uuid.UUID:
    row = Incident(
        title="Brand Kindergarten",
        source="manual",
        status="offen",
        map_workspace_json={"pickedObjectId": str(picked), "entities": []} if picked else {"entities": []},
    )
    db.add(row)
    await db.commit()
    return row.id


async def _count(db, model) -> int:
    return int((await db.execute(select(func.count()).select_from(model))).scalar_one())


async def test_the_nfc_twin_survives_and_the_nfd_row_hands_everything_over(db_session, capsys):
    """The prod case: the NFC-keyed row is the id every future import mints, so it is the one
    that may stay — and the twin's plans, calibration, source_key and picked-object references
    all have to arrive on it."""
    survivor = await _object(db_session, NFC_NAME, plans={"modul1": "a" * 64})
    loser = await _object(
        db_session,
        NFD_NAME,
        oid=object_id_for_key(NFD_NAME),
        plans={"modul2": "b" * 64, "modul3": "c" * 64},
        source_key="Kindergarten Hüsli",
    )
    assert survivor != loser, "the two spellings must start out as two different ids"
    await _scales(
        db_session,
        {
            "byPlan": {f"object:{loser}:plan:modul2": {"mPerU": 1.0, "refM": 10.0, "ar": 1.4}},
            "georefByPlan": {f"object:{loser}:plan:modul2": {"pairs": []}},
        },
    )
    incident = await _incident(db_session, picked=loser)

    assert await admin_objects._merge_duplicates(apply=True) == 0

    objects = list((await db_session.execute(select(ObjectSite))).scalars())
    assert [o.id for o in objects] == [survivor]
    assert objects[0].source_key == "Kindergarten Hüsli", "the pull key died with the loser"

    moved = list((await db_session.execute(select(ReferenceDataset).order_by(ReferenceDataset.id))).scalars())
    assert {d.id for d in moved} == {f"plan:{survivor}:modul{n}" for n in (1, 2, 3)}
    assert {d.object_id for d in moved} == {survivor}
    # Re-keyed, not just re-pointed: a row left under `plan:<loser>:modul2` is a row the next
    # `load` would mint a second time.
    assert all(str(loser) not in d.id for d in moved)

    scales = (await db_session.execute(select(DeploymentConfig))).scalar_one().plan_scales_json or {}
    assert list(scales["byPlan"]) == [f"object:{survivor}:plan:modul2"]
    assert list(scales["georefByPlan"]) == [f"object:{survivor}:plan:modul2"]

    workspace = (await db_session.execute(select(Incident).where(Incident.id == incident))).scalar_one()
    assert (workspace.map_workspace_json or {})["pickedObjectId"] == str(survivor)

    out = capsys.readouterr().out
    assert "U+0308" in out and "U+00FC" in out, "the diff has to show the spellings apart"


async def test_the_dry_run_is_the_default_and_writes_nothing(db_session, capsys):
    """A maintenance command that deletes rows earns its default the hard way."""
    survivor = await _object(db_session, NFC_NAME, plans={"modul1": "a" * 64})
    loser = await _object(db_session, NFD_NAME, oid=object_id_for_key(NFD_NAME), plans={"modul2": "b" * 64})
    await _scales(db_session, {"georefByPlan": {f"object:{loser}:plan:modul2": {"pairs": []}}})
    incident = await _incident(db_session, picked=loser)

    assert await admin_objects._amain(["merge-duplicates"]) == 0

    assert await _count(db_session, ObjectSite) == 2
    assert {d.id for d in (await db_session.execute(select(ReferenceDataset))).scalars()} == {
        f"plan:{survivor}:modul1",
        f"plan:{loser}:modul2",
    }
    scales = (await db_session.execute(select(DeploymentConfig))).scalar_one().plan_scales_json or {}
    assert list(scales["georefByPlan"]) == [f"object:{loser}:plan:modul2"]
    workspace = (await db_session.execute(select(Incident).where(Incident.id == incident))).scalar_one()
    assert (workspace.map_workspace_json or {})["pickedObjectId"] == str(loser)

    out = capsys.readouterr().out
    assert "dry-run" in out and "Nothing written" in out
    assert "--apply" in out, "the report has to say how to actually do it"


async def test_a_byte_identical_pair_keeps_the_richer_twin(db_session, capsys):
    """Two rows under the exact same name and neither carrying the NFC-key id — the one holding
    more data is the one the other folds into (and is then re-keyed onto the NFC id)."""
    poor = await _object(db_session, NFC_NAME, oid=uuid.uuid4(), plans={"modul1": "a" * 64})
    rich = await _object(db_session, NFC_NAME, oid=uuid.uuid4(), plans={"modul2": "b" * 64, "modul3": "c" * 64})

    assert await admin_objects._merge_duplicates(apply=True) == 0

    canonical = object_id_for_key(NFC_NAME)
    assert [o.id for o in (await db_session.execute(select(ObjectSite))).scalars()] == [canonical]
    assert {d.id for d in (await db_session.execute(select(ReferenceDataset))).scalars()} == {
        f"plan:{canonical}:modul{n}" for n in (1, 2, 3)
    }
    out = capsys.readouterr().out
    assert f"keep   {rich}" in out and f"merge  {poor}" in out, "the emptier row was the one kept"
    assert "no row carries the NFC-key id" in out


async def test_the_survivor_is_re_keyed_onto_the_nfc_id_and_takes_everything_with_it(db_session, capsys):
    """A merge that leaves the survivor on a non-NFC id is a merge the next sync undoes: the
    SharePoint pull creates objects under ``object_id_for_key(NFC name)``, so it would mint a
    third row under the same name. 27 of 79 prod groups look like this."""
    poor = await _object(db_session, NFC_NAME, oid=uuid.uuid4(), plans={"modul1": "a" * 64})
    rich = await _object(
        db_session,
        NFC_NAME,
        oid=uuid.uuid4(),
        plans={"modul2": "b" * 64},
        source_key="Kindergarten Hüsli",
    )
    await _scales(db_session, {"georefByPlan": {f"object:{rich}:plan:modul2": {"pairs": []}}})
    picked_the_loser = await _incident(db_session, picked=poor)
    picked_the_survivor = await _incident(db_session, picked=rich)
    canonical = object_id_for_key(NFC_NAME)
    assert canonical not in {poor, rich}

    assert await admin_objects._merge_duplicates(apply=False) == 0
    assert {o.id for o in (await db_session.execute(select(ObjectSite))).scalars()} == {poor, rich}, (
        "the dry run minted the canonical row"
    )

    assert await admin_objects._merge_duplicates(apply=True) == 0

    row = (await db_session.execute(select(ObjectSite))).scalar_one()
    assert row.id == canonical, "the survivor kept an id the next sync does not resolve to"
    assert row.source_key == "Kindergarten Hüsli", "the pull key did not survive the re-key"
    assert {d.id for d in (await db_session.execute(select(ReferenceDataset))).scalars()} == {
        f"plan:{canonical}:modul1",
        f"plan:{canonical}:modul2",
    }
    scales = (await db_session.execute(select(DeploymentConfig))).scalar_one().plan_scales_json or {}
    assert list(scales["georefByPlan"]) == [f"object:{canonical}:plan:modul2"]
    for incident in (picked_the_loser, picked_the_survivor):
        workspace = (await db_session.execute(select(Incident).where(Incident.id == incident))).scalar_one()
        assert (workspace.map_workspace_json or {})["pickedObjectId"] == str(canonical)

    out = capsys.readouterr().out
    assert f"rekey  {rich} → {canonical}" in out
    assert "1 survivor(s) re-keyed to the NFC id" in out


async def test_a_survivor_that_already_carries_the_nfc_id_is_left_alone(db_session, capsys):
    """Nothing to do is nothing done — no new row, no re-key line, no id churn."""
    survivor = await _object(db_session, NFC_NAME, plans={"modul1": "a" * 64})
    await _object(db_session, NFD_NAME, oid=object_id_for_key(NFD_NAME), plans={"modul2": "b" * 64})

    assert await admin_objects._merge_duplicates(apply=True) == 0

    assert [o.id for o in (await db_session.execute(select(ObjectSite))).scalars()] == [survivor]
    out = capsys.readouterr().out
    assert "rekey" not in out
    assert "0 survivor(s) re-keyed" in out
    assert "the survivor carries the NFC-key id" in out


async def test_a_group_kept_back_by_a_conflict_is_not_re_keyed(db_session, capsys):
    """Half a merge on a fresh id is worse than none: the conflicting twin would be left under a
    spelling the pull no longer resolves to anything."""
    poor = await _object(db_session, NFC_NAME, oid=uuid.uuid4(), plans={"modul1": "a" * 64})
    rich = await _object(db_session, NFC_NAME, oid=uuid.uuid4(), plans={"modul1": "b" * 64, "modul2": "c" * 64})

    assert await admin_objects._merge_duplicates(apply=True) == 1

    assert {o.id for o in (await db_session.execute(select(ObjectSite))).scalars()} == {poor, rich}
    out = capsys.readouterr().out
    assert f"rekey {rich} → {object_id_for_key(NFC_NAME)} NOT done" in out
    assert "would mint a THIRD row" in out
    assert "1 re-key(s) left undone by conflicts" in out


async def test_a_stray_row_already_on_the_nfc_id_is_refused_not_guessed_at(db_session, capsys):
    """The NFC id belonging to a row under ANOTHER name is not this command's call to make."""
    stray = object_id_for_key(NFC_NAME)
    await _object(db_session, "Ganz anderes Objekt", oid=stray)
    poor = await _object(db_session, NFC_NAME, oid=uuid.uuid4())
    rich = await _object(db_session, NFC_NAME, oid=uuid.uuid4(), plans={"modul1": "b" * 64})

    assert await admin_objects._merge_duplicates(apply=True) == 1, "a refused re-key is not a clean run"

    assert {o.id for o in (await db_session.execute(select(ObjectSite))).scalars()} == {stray, rich}
    assert poor not in {o.id for o in (await db_session.execute(select(ObjectSite))).scalars()}
    out = capsys.readouterr().out
    assert f"REFUSED: an object already carries {stray}" in out


async def test_an_equal_pair_is_broken_the_same_way_every_run(db_session, capsys):
    """Same plan count, same timestamp: the lowest id wins, so two operators comparing two dry
    runs see the same answer about which row's address and coordinates are kept."""
    same_moment = datetime(2026, 9, 11, 8, 0, tzinfo=UTC)
    low = uuid.UUID("00000000-0000-4000-8000-000000000001")
    high = uuid.UUID("ffffffff-0000-4000-8000-000000000001")
    await _object(db_session, NFC_NAME, oid=high, updated_at=same_moment)
    await _object(db_session, NFC_NAME, oid=low, updated_at=same_moment)

    assert await admin_objects._merge_duplicates(apply=False) == 0
    out = capsys.readouterr().out
    assert f"keep   {low}" in out and f"merge  {high}" in out


async def test_a_slot_the_survivor_already_holds_is_reported_not_overwritten(db_session, capsys):
    """Two different sheets under one module is the one case this command must NOT decide. The
    survivor's plan stays, the loser keeps its own — and its row survives with it."""
    survivor = await _object(db_session, NFC_NAME, plans={"modul1": "a" * 64})
    loser = await _object(
        db_session,
        NFD_NAME,
        oid=object_id_for_key(NFD_NAME),
        plans={"modul1": "b" * 64},
        source_key="Kindergarten Hüsli",
    )

    assert await admin_objects._merge_duplicates(apply=True) == 1, "an unfinished merge exits non-zero"

    assert await _count(db_session, ObjectSite) == 2, "a row still holding a plan was deleted"
    surviving_row = (await db_session.execute(select(ObjectSite).where(ObjectSite.id == loser))).scalar_one()
    assert surviving_row.source_key == "Kindergarten Hüsli", "a row that stays keeps the key the pull matches on"
    kept = (
        await db_session.execute(select(ReferenceDataset).where(ReferenceDataset.id == f"plan:{survivor}:modul1"))
    ).scalar_one()
    assert kept.source_digest == "a" * 64, "the survivor's sheet was overwritten by the twin's"
    still_there = (
        await db_session.execute(select(ReferenceDataset).where(ReferenceDataset.object_id == loser))
    ).scalar_one()
    assert still_there.id == f"plan:{loser}:modul1"
    assert "CONFLICT" in capsys.readouterr().out


async def test_an_identical_duplicate_plan_row_is_dropped(db_session, monkeypatch):
    """The same PDF imported twice under two spellings: one row is redundant, and only then may
    the twin row go. Bytes are compared — the plans a hand upload wrote carry no digest."""
    survivor = await _object(db_session, NFC_NAME, plans={"modul1": None})
    loser = await _object(db_session, NFD_NAME, oid=object_id_for_key(NFD_NAME), plans={"modul1": None})
    monkeypatch.setattr(admin_objects.storage, "get_bytes", lambda key: b"%PDF-1.4 same sheet")

    assert await admin_objects._merge_duplicates(apply=True) == 0

    assert [o.id for o in (await db_session.execute(select(ObjectSite))).scalars()] == [survivor]
    rows = list((await db_session.execute(select(ReferenceDataset))).scalars())
    assert [r.id for r in rows] == [f"plan:{survivor}:modul1"]
    assert str(loser) not in (rows[0].storage_key or ""), "the survivor's own blob must be the one kept"


async def test_the_history_is_counted_and_left_alone(db_session, capsys):
    """The audit chain is the record of what was true that night. Rewriting it to tidy the object
    table would break the hash chain and lie about the Einsatz."""
    await _object(db_session, NFC_NAME)
    loser = await _object(db_session, NFD_NAME, oid=object_id_for_key(NFD_NAME))
    incident = await _incident(db_session)
    db_session.add(
        IncidentEvent(
            incident_id=incident,
            seq=1,
            occurred_at=datetime.now(UTC),
            source="client",
            op_type="object.picked",
            payload_json={"objectId": str(loser)},
            hash="deadbeef",
        )
    )
    db_session.add(
        JournalEntry(incident_id=incident, client_id="t1", seq=1, row_json={"text": f"Objekt {loser} gewählt"})
    )
    await db_session.commit()

    assert await admin_objects._merge_duplicates(apply=True) == 0

    event = (await db_session.execute(select(IncidentEvent))).scalar_one()
    assert (event.payload_json or {})["objectId"] == str(loser), "the audit trail was rewritten"
    journal = (await db_session.execute(select(JournalEntry))).scalar_one()
    assert str(loser) in (journal.row_json or {})["text"]
    assert "left untouched" in capsys.readouterr().out


async def test_an_empty_object_goes_and_a_junk_folder_goes_when_it_is_named(db_session, capsys):
    """«Grosspläne» is a category folder an import read as an Einsatzobjekt. With no plans under it
    it falls out on its own; with plans it takes naming it out loud."""
    keeper = await _object(db_session, "Wache", plans={"modul1": "a" * 64})
    empty = await _object(db_session, "Leerer Ordner")
    junk = await _object(db_session, "Grosspläne", plans={"modul1": "z" * 64})

    assert await admin_objects._remove_empty(apply=False, names=["Grosspläne"]) == 0
    assert await _count(db_session, ObjectSite) == 3, "the dry run deleted something"

    assert await admin_objects._remove_empty(apply=True, names=["grosspläne"]) == 0  # name match is case-folded
    assert {o.id for o in (await db_session.execute(select(ObjectSite))).scalars()} == {keeper}
    assert {d.object_id for d in (await db_session.execute(select(ReferenceDataset))).scalars()} == {keeper}
    out = capsys.readouterr().out
    assert str(empty) in out and str(junk) in out


async def test_an_object_something_still_points_at_is_refused(db_session, capsys):
    """An object with no plans but a georeference or an incident behind it is not junk — deleting
    it would take a station's landmark work with it."""
    calibrated = await _object(db_session, "Vermessen")
    picked = await _object(db_session, "Gewählt")
    await _scales(db_session, {"georefByPlan": {f"object:{calibrated}:plan:modul2": {"pairs": []}}})
    await _incident(db_session, picked=picked)

    assert await admin_objects._remove_empty(apply=True, names=[]) == 0

    assert await _count(db_session, ObjectSite) == 2
    err = capsys.readouterr().err
    assert "NOT removed" in err and str(calibrated) in err and str(picked) in err


async def test_a_deployment_without_duplicates_says_so(db_session, capsys):
    await _object(db_session, "Wache")
    await _object(db_session, "Schulhaus")

    assert await admin_objects._merge_duplicates(apply=True) == 0
    assert "No duplicate object names" in capsys.readouterr().out

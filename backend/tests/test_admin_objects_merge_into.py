"""One twin under ANOTHER name folded into an object — `admin_objects_repair merge <loser> --into <id>`
(review round 3, 17.10.2026: the plan-less «Stallenmattstrasse 2-14, Kaibmattweg 1-5 (EH)» is the
plan library's «Stallenmattstrasse 1-14 …»; owner: «merge number 2 onto 1 and drop 2»), and the
`twins` report that finds such pairs. Synthetic Musterdorf data.
"""

import json
import uuid

import pytest
from sqlalchemy import func, select

from app import admin_objects_repair, object_footprints, storage
from app import object_visits as ov
from app.models import ObjectPositionEvent, ObjectRef, ObjectSite, ObjectVisit, ReferenceDataset

ONE = uuid.UUID("11111111-1111-5111-8111-111111111111")
TWO = uuid.UUID("22222222-2222-4222-8222-222222222222")


@pytest.fixture(autouse=True)
def _cli_session(monkeypatch, session_factory):
    monkeypatch.setattr(admin_objects_repair, "async_session_maker", session_factory)


async def _twins(db) -> None:
    db.add(
        ObjectSite(
            id=ONE,
            name="Musterweg 1-14 (EH)",
            lat=47.52,
            lng=7.57,
            source_note="OneDrive: Einsatzpläne/Musterweg 1-14 (EH)",
        )
    )
    db.add(
        ObjectSite(
            id=TWO,
            name="Musterweg 2-14 (EH)",
            address="Musterweg 2a",
            lat=47.5201,
            lng=7.5701,
            source_note="Integration: fwo",
            filing_folder="Musterweg 2-14 (EH)",
            measures="Zufahrt über den Hof",
        )
    )
    db.add(
        ReferenceDataset(
            id=f"plan:{ONE}:modul1",
            object_id=ONE,
            module="modul1",
            kind="pdf",
            title="Übersicht",
            storage_key="p/1.pdf",
        )
    )
    await db.flush()
    db.add(ObjectRef(object_id=TWO, source="fwo-schlue", external_id="k-2"))
    db.add(ObjectPositionEvent(object_id=TWO, action="set", actor="Verwaltung", before={}, after={"lat": 47.5201}))
    db.add(ObjectVisit(id="ov-merge-1", object_id=TWO, lifecycle="completed", doc={}, revision=1))
    await db.commit()


async def _count(db, model, **where) -> int:
    stmt = select(func.count()).select_from(model)
    for k, v in where.items():
        stmt = stmt.where(getattr(model, k) == v)
    return int((await db.execute(stmt)).scalar_one())


async def test_the_dry_run_says_everything_and_writes_nothing(db_session, capsys):
    await _twins(db_session)
    assert await admin_objects_repair._merge_into(TWO, ONE, apply=False) == 0
    out = capsys.readouterr().out
    assert "created by: Integration: fwo" in out and "fwo-schlue:k-2" in out
    assert "1 Objektbesuch(e) and 1 outside id(s) move" in out and "1 position correction(s)" in out
    assert "alias 'Musterweg 2-14 (EH)'" in out and "dry-run" in out
    db_session.expire_all()
    assert await db_session.get(ObjectSite, TWO) is not None
    assert await _count(db_session, ObjectRef, object_id=TWO) == 1


async def test_apply_moves_everything_onto_the_survivor_and_drops_the_twin(db_session, capsys):
    await _twins(db_session)
    assert await admin_objects_repair._merge_into(TWO, ONE, apply=True) == 0
    db_session.expire_all()
    assert await db_session.get(ObjectSite, TWO) is None
    one = await db_session.get(ObjectSite, ONE)
    assert one is not None and one.name == "Musterweg 1-14 (EH)"  # the survivor keeps its name …
    assert (float(one.lat), float(one.lng)) == (47.52, 7.57)  # … and its position
    assert one.measures == "Zufahrt über den Hof"  # the twin's notes fill an empty survivor
    assert await _count(db_session, ObjectVisit, object_id=ONE) == 1
    assert await _count(db_session, ObjectPositionEvent, object_id=ONE) == 1
    refs = {(r.source, r.external_id) for r in (await db_session.execute(select(ObjectRef))).scalars()}
    assert refs == {("fwo-schlue", "k-2"), (ov.ALIAS_SOURCE, "Musterweg 2-14 (EH)")}
    # the alias is the survivor's own business: never shown to an organizer
    assert (await ov.refs_by_object(db_session))[ONE] == [{"source": "fwo-schlue", "id": "k-2"}]
    assert (await ov.aliases_by_object(db_session))[ONE] == ["Musterweg 2-14 (EH)"]


async def test_no_organizer_push_mints_the_twin_again(db_session):
    await _twins(db_session)
    assert await admin_objects_repair._merge_into(TWO, ONE, apply=True) == 0
    db_session.expire_all()
    # a new outside id under the merged-away folder/name resolves to the survivor
    got = await ov.upsert_integration_object(
        db_session, "fwo", "Musterweg 2-14 (EH)", {"name": "Musterweg 2-14 (EH)", "folder": "Musterweg 2-14 (EH)"}
    )
    assert got == {"objectId": str(ONE), "created": False}
    assert await _count(db_session, ObjectSite) == 1


async def test_the_viewer_finds_the_old_name(client, db_session, editor):
    from tests.test_building_facts import _login

    await _twins(db_session)
    assert await admin_objects_repair._merge_into(TWO, ONE, apply=True) == 0
    await _login(client, editor)
    objs = (await client.get("/api/reference/objects")).json()["objects"]
    assert [o["aliases"] for o in objs if o["id"] == str(ONE)] == [["Musterweg 2-14 (EH)"]]


async def test_refuses_nonsense(db_session):
    await _twins(db_session)
    with pytest.raises(SystemExit):
        await admin_objects_repair._merge_into(ONE, ONE, apply=False)
    with pytest.raises(SystemExit):
        await admin_objects_repair._merge_into(uuid.uuid4(), ONE, apply=False)


async def test_twins_reports_a_plan_less_row_on_another_s_buildings(db_session, capsys):
    await _twins(db_session)
    house = [[7.5699, 47.5199], [7.5703, 47.5199], [7.5703, 47.5202], [7.5699, 47.5202], [7.5699, 47.5199]]
    shed = [[7.5710, 47.5199], [7.5712, 47.5199], [7.5712, 47.5201], [7.5710, 47.5201], [7.5710, 47.5199]]
    one = {
        "at": "47.520000,7.570000",
        "source": "name",
        "footprint": {"type": "MultiPolygon", "coordinates": [[house], [shed]]},
    }
    two = {
        "at": "47.520100,7.570100",
        "source": "name",
        "footprint": {"type": "MultiPolygon", "coordinates": [[house]]},
    }
    storage.put_bytes(object_footprints.STORE_KEY, json.dumps({"footprints": {str(ONE): one, str(TWO): two}}).encode())
    object_footprints.clear_cache()
    try:
        assert await admin_objects_repair._report_twins() == 0
    finally:
        storage.delete(object_footprints.STORE_KEY)
        object_footprints.clear_cache()
    out = capsys.readouterr().out
    assert f"merge {TWO} --into {ONE}" in out and "100% of its 1 building(s)" in out
    assert f"merge {ONE} --into" not in out  # a row WITH plans is never offered as the loser
    assert "1 likely twin(s)" in out

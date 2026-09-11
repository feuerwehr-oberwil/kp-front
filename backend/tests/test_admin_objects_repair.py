"""Two conventions read one plans folder, so every Einsatzobjekt existed twice — and the copy
the crew could reach was the stale one.

A plans folder is named «Adresse - Name». The importer has always keyed the object on the NAME
half and stored the address beside it; the SharePoint pull hashed the WHOLE folder string. On the
FWO deployment (field-diagnosed 11.09.2026) that minted 150 address-less, coordinate-less objects
next to the ones the station already had — and because the app surfaces an Einsatzobjekt at an
incident by DISTANCE, none of them ever appeared: «Im Buech 15» was at v2 on an object nobody
could see while the Einsatz showed v1 on the other.

`repair-sharepoint-keys` folds those back together. These tests pin what is dangerous about that:
that the richer, older row is the one that survives, that the newer sheet of a slot both rows hold
wins, that a re-keyed survivor ends up where the next sync looks for it, and that the default run
writes nothing whatever.
"""

import unicodedata
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from app import admin_objects
from app.admin_objects import folder_identity, object_id_for_key
from app.models import DeploymentConfig, ObjectSite, ReferenceDataset

#: A folder name off the station's plan library, and the identity it is read as.
FOLDER = "Im Buech 10 - Hof Thürkauf, Im Buech 15, Im Buech 20"
NAME = "Hof Thürkauf, Im Buech 15, Im Buech 20"
ADDRESS = "Im Buech 10"
COORDS = (47.49811, 7.55402)

MORNING = datetime(2026, 9, 11, 9, 59, tzinfo=UTC)
MIDDAY = datetime(2026, 9, 11, 11, 21, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _cli_session(monkeypatch, session_factory):
    """The CLI opens its own session; point it at the test database."""
    monkeypatch.setattr(admin_objects, "async_session_maker", session_factory)


@pytest.fixture(autouse=True)
def _no_geocoder(monkeypatch):
    """No test reaches swisstopo. The tests about geocoding install their own answer."""

    async def none(_address):
        return None

    monkeypatch.setattr(admin_objects, "geocode", none)


def geocoder(monkeypatch, coords, calls=None):
    async def fake(address):
        if calls is not None:
            calls.append(address)
        if isinstance(coords, Exception):
            raise coords
        return coords

    monkeypatch.setattr(admin_objects, "geocode", fake)


async def _object(
    db,
    name: str,
    *,
    oid: uuid.UUID | None = None,
    address: str | None = None,
    coords: tuple[float, float] | None = None,
    source_note: str | None = None,
    plans: dict[str, tuple[str, int, datetime]] | None = None,
) -> uuid.UUID:
    """One stored Einsatzobjekt + its plan rows ({module: (source_type, version, written_at)})."""
    oid = oid or object_id_for_key(name)
    db.add(
        ObjectSite(
            id=oid,
            name=name,
            address=address,
            lat=coords[0] if coords else None,
            lng=coords[1] if coords else None,
            source_note=source_note,
        )
    )
    for module, (source_type, version, at) in (plans or {}).items():
        db.add(
            ReferenceDataset(
                id=f"plan:{oid}:{module}",
                object_id=oid,
                module=module,
                kind="pdf",
                title=f"{name} – {module}",
                source_type=source_type,
                current_version=version,
                storage_key=f"plans/{oid}/{module}-v{version}.pdf",
                # Distinct per row: `_same_bytes` must see two different sheets, not one.
                source_digest=f"{module}{source_type}{version}".ljust(64, "0")[:64],
                updated_at=at,
            )
        )
    await db.commit()
    return oid


async def _plans(db) -> dict[str, ReferenceDataset]:
    await db.flush()
    return {r.id: r for r in (await db.execute(select(ReferenceDataset))).scalars()}


async def _count(db, model) -> int:
    return int((await db.execute(select(func.count()).select_from(model))).scalar_one())


async def test_the_bare_twin_folds_into_the_importers_object_and_the_newer_sheets_win(db_session, capsys):
    """The exact production shape. The older object carries the address, the coordinates and v1
    of the two PV sheets; the SharePoint twin carries nothing but v2 of those same two sheets.
    One object afterwards, the real coordinates kept, and the sheets the crew opens are v2."""
    older = await _object(
        db_session,
        NAME,
        address=ADDRESS,
        coords=COORDS,
        plans={
            "modul1": ("uploaded", 1, MORNING),
            "modul5-pv15": ("uploaded", 1, MORNING),
            "modul5-pv20": ("uploaded", 1, MORNING),
        },
    )
    twin = await _object(
        db_session,
        FOLDER,
        oid=object_id_for_key(FOLDER),
        source_note="SharePoint",
        plans={
            "modul2": ("sharepoint", 1, MIDDAY),
            "modul5-pv15": ("sharepoint", 2, MIDDAY),
            "modul5-pv20": ("sharepoint", 2, MIDDAY),
        },
    )
    assert older != twin, "the fixture only means anything if the two conventions disagree"

    assert await admin_objects._repair_sharepoint_keys(apply=True, do_geocode=False) == 0

    rows = list((await db_session.execute(select(ObjectSite))).scalars())
    assert [r.id for r in rows] == [older]
    kept = rows[0]
    assert (kept.name, kept.address) == (NAME, ADDRESS)
    assert (float(kept.lat), float(kept.lng)) == COORDS, "the bare twin's empty coordinates won"

    plans = await _plans(db_session)
    assert set(plans) == {f"plan:{older}:{m}" for m in ("modul1", "modul2", "modul5-pv15", "modul5-pv20")}
    for module in ("modul5-pv15", "modul5-pv20"):
        sheet = plans[f"plan:{older}:{module}"]
        assert (sheet.source_type, sheet.current_version) == ("sharepoint", 2), "the stale v1 is still served"
        assert str(twin) in (sheet.storage_key or ""), "the row moved but not its bytes"
    assert plans[f"plan:{older}:modul2"].source_type == "sharepoint", "the twin's own sheet did not move over"

    # And the next sync resolves the folder to exactly this row — no third object.
    assert folder_identity(FOLDER).object_id == older

    out = capsys.readouterr().out
    assert f"keep   {older}" in out and f"merge  {twin}" in out
    assert "replaces the survivor's sheet" in out and "v2" in out and "v1" in out
    assert "no re-key" in out


async def test_the_survivors_newer_sheet_is_not_replaced_by_an_older_copy(db_session):
    """Newest wins is a rule, not a direction: a sheet somebody uploaded by hand this morning
    stays when the twin's copy of that slot is older."""
    older = await _object(db_session, NAME, address=ADDRESS, plans={"modul1": ("uploaded", 3, MIDDAY)})
    await _object(
        db_session,
        FOLDER,
        oid=object_id_for_key(FOLDER),
        plans={"modul1": ("sharepoint", 1, MORNING)},
    )

    assert await admin_objects._repair_sharepoint_keys(apply=True, do_geocode=False) == 0

    plans = await _plans(db_session)
    assert set(plans) == {f"plan:{older}:modul1"}
    assert (plans[f"plan:{older}:modul1"].source_type, plans[f"plan:{older}:modul1"].current_version) == (
        "uploaded",
        3,
    )


async def test_a_twinless_object_is_rekeyed_with_its_address_split_out_and_geocoded(db_session, capsys, monkeypatch):
    """68 of the 150 had no older twin. Those are re-keyed onto the corrected id, their name is
    split into address + name, and the address is geocoded — without coordinates the object
    surfaces at no incident, which is the half of the defect a merge alone does not fix."""
    calls: list[str] = []
    geocoder(monkeypatch, COORDS, calls)
    bare = await _object(
        db_session,
        FOLDER,
        oid=object_id_for_key(FOLDER),
        source_note="SharePoint",
        plans={"modul1": ("sharepoint", 1, MIDDAY)},
    )

    assert await admin_objects._repair_sharepoint_keys(apply=True, do_geocode=True) == 0

    row = (await db_session.execute(select(ObjectSite))).scalar_one()
    assert row.id == folder_identity(FOLDER).object_id != bare
    assert (row.name, row.address) == (NAME, ADDRESS)
    assert (float(row.lat), float(row.lng)) == COORDS
    assert row.source_note == "SharePoint", "the provenance of the row was lost in the re-key"
    assert calls == [ADDRESS], "the geocoder was asked something other than the address half"
    assert set(await _plans(db_session)) == {f"plan:{row.id}:modul1"}

    out = capsys.readouterr().out
    assert f"rekey  {bare} → {row.id}" in out
    assert "geocoded to 47.49811, 7.55402" in out
    assert "every one that carries plans has coordinates" in out


async def test_a_geocoder_that_answers_nothing_still_repairs_and_says_what_is_left(db_session, capsys, monkeypatch):
    """The repair is not allowed to hang on swisstopo: the keys are fixed either way, and the
    objects still without coordinates are listed by name and address for a person to place."""
    geocoder(monkeypatch, RuntimeError("swisstopo timed out"))
    await _object(
        db_session,
        FOLDER,
        oid=object_id_for_key(FOLDER),
        plans={"modul1": ("sharepoint", 1, MIDDAY)},
    )

    assert await admin_objects._repair_sharepoint_keys(apply=True, do_geocode=True) == 0

    row = (await db_session.execute(select(ObjectSite))).scalar_one()
    assert (row.name, row.address, row.lat) == (NAME, ADDRESS, None)
    out = capsys.readouterr().out
    assert "1 of them carry plans and NO coordinates" in out
    assert f"«{NAME}» — address {ADDRESS}" in out


async def test_the_older_twin_is_found_by_its_two_fields_and_then_re_keyed(db_session, capsys):
    """The twin an id lookup misses: the older row was keyed by a decomposed spelling (that is the
    25-pair NFD defect) so it does not sit on the corrected id. It is still the same building —
    it says so in its own address + name — and after the fold it is moved onto the id the next
    sync derives, or the sync would mint the bare row all over again."""
    other_key = uuid.uuid4()
    older = await _object(
        db_session,
        NAME,
        oid=other_key,
        address=ADDRESS,
        coords=COORDS,
        plans={"modul1": ("uploaded", 1, MORNING)},
    )
    twin = await _object(
        db_session,
        FOLDER,
        oid=object_id_for_key(FOLDER),
        plans={"modul2": ("sharepoint", 1, MIDDAY)},
    )

    assert await admin_objects._repair_sharepoint_keys(apply=True, do_geocode=False) == 0

    row = (await db_session.execute(select(ObjectSite))).scalar_one()
    assert row.id == folder_identity(FOLDER).object_id
    assert row.id not in (older, twin)
    assert (row.name, row.address) == (NAME, ADDRESS)
    assert (float(row.lat), float(row.lng)) == COORDS
    assert set(await _plans(db_session)) == {f"plan:{row.id}:modul1", f"plan:{row.id}:modul2"}
    assert f"rekey  {older} → {row.id}" in capsys.readouterr().out


async def test_an_empty_survivor_address_is_filled_from_the_folder_name(db_session):
    """The other way an object surfaces: `objects_near_incident` matches the incident's address
    against the object's. A survivor that never had one gets the folder's — that is not a guess,
    it is the string the folder is named after."""
    older = await _object(
        db_session,
        NAME,
        plans={"modul1": ("uploaded", 1, MORNING)},
    )
    await _object(db_session, FOLDER, oid=object_id_for_key(FOLDER), plans={"modul2": ("sharepoint", 1, MIDDAY)})

    assert await admin_objects._repair_sharepoint_keys(apply=True, do_geocode=False) == 0

    row = (await db_session.execute(select(ObjectSite).where(ObjectSite.id == older))).scalar_one()
    assert row.address == ADDRESS


async def test_the_dry_run_is_the_default_and_writes_nothing(db_session, capsys, monkeypatch):
    """A maintenance command that deletes object rows earns its default the hard way — and its
    report still has to say what it WOULD do, coordinates included."""
    geocoder(monkeypatch, COORDS)
    older = await _object(db_session, NAME, address=ADDRESS, plans={"modul1": ("uploaded", 1, MORNING)})
    twin = await _object(
        db_session,
        FOLDER,
        oid=object_id_for_key(FOLDER),
        plans={"modul5-pv15": ("sharepoint", 2, MIDDAY)},
    )

    assert await admin_objects._amain(["repair-sharepoint-keys"]) == 0

    assert await _count(db_session, ObjectSite) == 2
    assert set(await _plans(db_session)) == {f"plan:{older}:modul1", f"plan:{twin}:modul5-pv15"}
    untouched = (await db_session.execute(select(ObjectSite).where(ObjectSite.id == older))).scalar_one()
    assert untouched.lat is None, "the dry run geocoded the object for real"

    out = capsys.readouterr().out
    assert "dry-run" in out and "Nothing written" in out and "--apply" in out
    assert f"merge  {twin}" in out
    assert "geocoded to 47.49811, 7.55402" in out


async def test_nothing_a_person_typed_is_touched(db_session, capsys):
    """The test that decides what this command may not do. An object created in /admin under a
    key somebody chose is not keyed on its own whole name — and a folder with no « - » in it was
    always keyed correctly. Neither is a candidate, however much the name looks like one."""
    typed = await _object(
        db_session,
        "Bahnhofstrasse 6 - Gemeindebibliothek",
        oid=object_id_for_key("gemeindebibliothek"),
        plans={"modul1": ("uploaded", 1, MORNING)},
    )
    plain = await _object(db_session, "Grosspläne", plans={"modul1": ("sharepoint", 1, MIDDAY)})

    assert await admin_objects._repair_sharepoint_keys(apply=True, do_geocode=False) == 0

    assert {o.id for o in (await db_session.execute(select(ObjectSite))).scalars()} == {typed, plain}
    assert set(await _plans(db_session)) == {f"plan:{typed}:modul1", f"plan:{plain}:modul1"}
    out = capsys.readouterr().out
    assert "No object is keyed on a whole «Adresse - Name» folder name among 2 object(s)" in out


async def test_a_repaired_deployment_re_checks_itself_read_only(db_session, capsys):
    """The verification run, and the reason the census is printed even when there is nothing to
    repair: after the real run against production, the SAME command (dry, read-only) has to be
    able to answer «did it work, and is anything still unreachable»."""
    await _object(db_session, NAME, address=ADDRESS, coords=COORDS, plans={"modul1": ("sharepoint", 2, MIDDAY)})
    await _object(
        db_session, "Schulhaus Dorfmatt", address="Schulstrasse 7", plans={"modul1": ("uploaded", 1, MORNING)}
    )
    await _object(db_session, "Ohne Pläne")  # no plans: nothing to surface, so not on the list

    assert await admin_objects._repair_sharepoint_keys(apply=False, do_geocode=False) == 0

    out = capsys.readouterr().out
    assert "No object is keyed on a whole «Adresse - Name» folder name among 3 object(s)" in out
    assert "3 Einsatzobjekt(e) stored, 1 of them carry plans and NO coordinates" in out
    assert "«Schulhaus Dorfmatt» — address Schulstrasse 7" in out
    assert "Ohne Pläne" not in out


async def test_a_sheet_the_survivor_also_holds_under_an_odd_key_is_reported_not_guessed_at(db_session, capsys):
    """The one thing that still stops this command: a plan row whose id is not
    `plan:<object>:<module>` at all, so «which of the two is newer» cannot even be asked of a
    slot. The bare row keeps it and says so, and its object is not re-keyed half-way."""
    older = await _object(db_session, NAME, address=ADDRESS, coords=COORDS)
    db_session.add(
        ReferenceDataset(
            id=f"plan:{older}:modul1",  # occupied, but with no module recorded
            object_id=older,
            kind="pdf",
            source_type="uploaded",
            current_version=1,
            updated_at=MORNING,
        )
    )
    twin = await _object(
        db_session,
        FOLDER,
        oid=object_id_for_key(FOLDER),
        plans={"modul1": ("sharepoint", 2, MIDDAY)},
    )
    await db_session.commit()

    assert await admin_objects._repair_sharepoint_keys(apply=True, do_geocode=False) == 1

    assert {o.id for o in (await db_session.execute(select(ObjectSite))).scalars()} == {older, twin}
    out = capsys.readouterr().out
    assert "CONFLICT" in out
    assert "left as it is" in out and "INCOMPLETE" in out


async def test_the_station_calibration_follows_the_plans(db_session):
    """Losing `plan_scales_json` is losing every landmark pair an FU ever tapped — and the twin
    may well be the row a georeference was drawn on, since /admin could open it."""
    older = await _object(db_session, NAME, address=ADDRESS, coords=COORDS)
    twin = await _object(
        db_session,
        FOLDER,
        oid=object_id_for_key(FOLDER),
        plans={"modul2": ("sharepoint", 1, MIDDAY)},
    )
    db_session.add(
        DeploymentConfig(
            id=1,
            plan_scales_json={"georefByPlan": {f"object:{twin}:plan:modul2": {"pairs": [{"kind": "auto"}]}}},
        )
    )
    await db_session.commit()

    assert await admin_objects._repair_sharepoint_keys(apply=True, do_geocode=False) == 0

    scales = (await db_session.execute(select(DeploymentConfig))).scalar_one().plan_scales_json or {}
    assert list(scales["georefByPlan"]) == [f"object:{older}:plan:modul2"]


async def test_a_later_sync_over_the_repaired_deployment_changes_nothing(db_session):
    """The property the whole repair exists for, stated as one assertion: whatever the folder is
    called, the id the connector derives for it is the id the repaired row carries."""
    older = await _object(db_session, NAME, address=ADDRESS, coords=COORDS)
    await _object(db_session, FOLDER, oid=object_id_for_key(FOLDER), plans={"modul1": ("sharepoint", 1, MIDDAY)})

    assert await admin_objects._repair_sharepoint_keys(apply=True, do_geocode=False) == 0

    row = (await db_session.execute(select(ObjectSite))).scalar_one()
    assert row.id == older == folder_identity(FOLDER).object_id
    # ...and the decomposed spelling of the same folder resolves there too — macOS against Graph.
    decomposed = unicodedata.normalize("NFD", FOLDER)
    assert decomposed != FOLDER and folder_identity(decomposed).object_id == older


async def test_an_equal_timestamp_is_broken_by_the_version_counter(db_session):
    """Equal timestamps: the version counter breaks the tie, so the sheet that has been written
    more often is the current one."""
    older = await _object(db_session, NAME, address=ADDRESS, plans={"modul1": ("uploaded", 1, MIDDAY)})
    await _object(
        db_session,
        FOLDER,
        oid=object_id_for_key(FOLDER),
        plans={"modul1": ("sharepoint", 2, MIDDAY)},
    )

    assert await admin_objects._repair_sharepoint_keys(apply=True, do_geocode=False) == 0

    plans = await _plans(db_session)
    assert plans[f"plan:{older}:modul1"].current_version == 2

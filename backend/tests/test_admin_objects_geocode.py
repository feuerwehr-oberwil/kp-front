"""An Einsatzobjekt without coordinates is offered at no incident — so its plans are reachable by
nobody, however correct its key is.

After the two object-key conventions were folded back together (`repair-sharepoint-keys`, PR #156)
the FWO deployment still carried 52 such objects, written that way by the ORIGINAL importer years
earlier: their name is a bare street address («Benkenstrasse 66a»), their address column is empty,
and they carry plans. `geocode-missing` gives them a position. These tests pin what it looks the
address up BY, that a row it cannot resolve is left exactly as it was, and that the default run
writes nothing.
"""

import uuid

import pytest
from sqlalchemy import select

from app import admin_objects
from app.admin_objects import object_id_for_key
from app.models import ObjectSite, ReferenceDataset

#: The shape of the 52: the street stands in the NAME column, nothing in `address`.
STREET = "Benkenstrasse 66a"
COORDS = (47.49811, 7.55402)


@pytest.fixture(autouse=True)
def _cli_session(monkeypatch, session_factory):
    """The CLI opens its own session; point it at the test database."""
    monkeypatch.setattr(admin_objects, "async_session_maker", session_factory)


def geocoder(monkeypatch, answers: dict[str, tuple[float, float]] | Exception, asked: list[str] | None = None):
    """A swisstopo that answers only the queries named — everything else finds nothing, which is
    what an object whose name is not an address gets. No test reaches the network."""

    async def fake(address):
        if asked is not None:
            asked.append(address)
        if isinstance(answers, Exception):
            raise answers
        return answers.get(address)

    monkeypatch.setattr(admin_objects, "geocode", fake)


async def _object(
    db,
    name: str,
    *,
    address: str | None = None,
    coords: tuple[float, float] | None = None,
    plans: bool = True,
) -> uuid.UUID:
    """One stored Einsatzobjekt, with or without a Modul-PDF hanging off it."""
    oid = object_id_for_key(name)
    db.add(
        ObjectSite(
            id=oid,
            name=name,
            address=address,
            lat=coords[0] if coords else None,
            lng=coords[1] if coords else None,
        )
    )
    if plans:
        db.add(ReferenceDataset(id=f"plan:{oid}:modul1", object_id=oid, module="modul1", kind="pdf"))
    await db.commit()
    return oid


async def _row(db, oid: uuid.UUID) -> ObjectSite:
    return (await db.execute(select(ObjectSite).where(ObjectSite.id == oid))).scalar_one()


async def test_the_address_is_what_is_looked_up_when_the_row_has_one(db_session, capsys, monkeypatch):
    asked: list[str] = []
    geocoder(monkeypatch, {"Schulstrasse 7": COORDS}, asked)
    oid = await _object(db_session, "Schulhaus Dorfmatt", address="Schulstrasse 7")

    assert await admin_objects._geocode_missing(apply=True) == 0

    row = await _row(db_session, oid)
    assert (float(row.lat), float(row.lng)) == COORDS
    assert asked == ["Schulstrasse 7"], "the name was looked up over an address the row already had"
    out = capsys.readouterr().out
    assert "(its address) → 47.49811, 7.55402" in out
    assert "every one that carries plans has coordinates" in out


async def test_a_row_whose_name_is_its_address_is_looked_up_by_that(db_session, capsys, monkeypatch):
    """The 52. The import that wrote them never split «Adresse - Name», so the street sits in the
    name column — and the geocoder is region-biased, so a bare street number resolves at home."""
    asked: list[str] = []
    geocoder(monkeypatch, {STREET: COORDS}, asked)
    oid = await _object(db_session, STREET)

    assert await admin_objects._geocode_missing(apply=True) == 0

    row = await _row(db_session, oid)
    assert (float(row.lat), float(row.lng)) == COORDS
    assert row.address is None, "geocoding is not the same act as naming an address"
    assert asked == [STREET]
    assert "(its name) → 47.49811, 7.55402" in capsys.readouterr().out, "the report hid which field it used"


async def test_a_name_the_geocoder_cannot_place_is_left_alone_and_stays_listed(db_session, capsys, monkeypatch):
    """«Waldhütte» is not an address. Nothing is invented for it — it keeps its empty position and
    stays on the census, which is where a person picks it up."""
    geocoder(monkeypatch, {STREET: COORDS})
    placed = await _object(db_session, STREET)
    unplaceable = await _object(db_session, "Waldhütte")

    assert await admin_objects._geocode_missing(apply=True) == 0

    assert (await _row(db_session, placed)).lat is not None
    left = await _row(db_session, unplaceable)
    assert (left.lat, left.lng) == (None, None)
    out = capsys.readouterr().out
    assert "nothing found for 'Waldhütte' (its name)" in out
    assert "1 of 2 object(s) geocoded, 1 still without a position" in out
    assert "«Waldhütte» — address (none)" in out, "the one that failed fell off the census"


async def test_a_geocoder_that_raises_does_not_end_the_run(db_session, capsys, monkeypatch):
    """swisstopo being down is not a reason for the command to die halfway through a list."""
    geocoder(monkeypatch, RuntimeError("swisstopo timed out"))
    oid = await _object(db_session, STREET)

    assert await admin_objects._geocode_missing(apply=True) == 0

    assert (await _row(db_session, oid)).lat is None
    assert "0 of 1 object(s) geocoded" in capsys.readouterr().out


async def test_the_dry_run_is_the_default_and_writes_nothing(db_session, capsys, monkeypatch):
    geocoder(monkeypatch, {STREET: COORDS})
    oid = await _object(db_session, STREET)

    assert await admin_objects._amain(["geocode-missing"]) == 0

    assert (await _row(db_session, oid)).lat is None, "the dry run wrote the coordinates"
    out = capsys.readouterr().out
    assert "→ 47.49811, 7.55402" in out, "a dry run that does not say what it would write is no use"
    assert "dry-run" in out and "Nothing written" in out and "--apply" in out
    # The census is the run's own prediction: this one would come off the list.
    assert "every one that carries plans has coordinates" in out


async def test_a_position_the_station_already_has_is_never_touched(db_session, capsys, monkeypatch):
    """Two rows this command has no business with: one that is already placed, and one with no
    plans at all — nothing to surface, so nothing to geocode."""
    asked: list[str] = []
    geocoder(monkeypatch, {STREET: COORDS, "Wache": COORDS}, asked)
    placed = await _object(db_session, "Schulhaus Dorfmatt", address="Schulstrasse 7", coords=(47.5, 7.57))
    planless = await _object(db_session, "Wache", plans=False)

    assert await admin_objects._geocode_missing(apply=True) == 0

    kept = await _row(db_session, placed)
    assert (float(kept.lat), float(kept.lng)) == (47.5, 7.57)
    assert (await _row(db_session, planless)).lat is None
    assert asked == [], "the geocoder was asked about an object that needed nothing"
    assert "Nothing to geocode" in capsys.readouterr().out

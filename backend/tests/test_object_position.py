"""Where a station object is, and how the station corrects it (Karte & Objekte, review round 2).

* `geocode.locate` — an object's address resolves only to an EXACT street + number in the area,
  the home town first; never to the fuzzy neighbour `geocode()` answers with (ARA Birsig,
  17.10.2026: «Erlenstrasse 60» without its town became «Vorderbergstrasse 60» in the home town).
* «Lage korrigieren» (`PUT /api/objects/{id}/position`) — station-set, audited, undoable, and never
  overwritten by a push, a manifest reload or the footprint job.
* `object_address` — an address for every object where one is knowable, the town only when it
  is not the home town.

Nothing leaves the machine: the geocoder's upstream and the bias are replaced per test.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app import admin_objects, geocode
from app import object_footprints as of
from app.api.station_reference import object_address
from app.models import ObjectPositionEvent, ObjectSite

PIN = "135790"
HOME = "4104 Oberwil BL"
BBOX = "2598000,1252000,2625000,1270000"


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": PIN})
    assert r.status_code == 200, r.text


def _hit(label: str, e: float, n: float, lat: float = 47.5, lng: float = 7.55) -> dict:
    return {"attrs": {"origin": "address", "label": label, "y": e, "x": n, "lat": lat, "lng": lng, "lon": lng}}


@pytest.fixture
def upstream(monkeypatch):
    """A swisstopo that answers with the hits a test hands it, under the FWO-shaped bias."""
    answers: list[dict] = []

    async def fake_upstream(text, bbox, limit):
        return answers

    async def fake_bias():
        return HOME, BBOX

    monkeypatch.setattr(geocode, "_upstream", fake_upstream)
    monkeypatch.setattr(geocode, "_resolve_bias", fake_bias)
    monkeypatch.setattr(geocode, "_GEOCODER_OK", True)
    return answers


# --- locate --------------------------------------------------------------------------------------


async def test_an_address_missing_from_the_home_town_is_found_where_it_is(upstream):
    # what swisstopo answers for «Erlenstrasse 60»: the real one in Therwil, its sub-entrances,
    # and the fuzzy «…strasse 60» in the home town the old path took
    upstream += [
        _hit("Vorderbergstrasse 60 <b>4104 Oberwil BL</b>", 2608100, 1262300, 47.51236, 7.54668),
        _hit("Erlenstrasse 60.1 <b>4106 Therwil</b>", 2608939, 1261591),
        _hit("Erlenstrasse 60 <b>4106 Therwil</b>", 2608938, 1261618, 47.50526, 7.55727),
        _hit("Erlenstrasse 60a <b>4106 Therwil</b>", 2608906, 1261609),
    ]
    loc = await geocode.locate("Erlenstrasse 60")
    assert loc.status == "exact"
    assert loc.hit is not None
    assert (loc.hit.lat, loc.hit.lng) == (47.50526, 7.55727)
    assert loc.hit.label == "Erlenstrasse 60, 4106 Therwil" and loc.hit.town == "Therwil" and not loc.hit.home


async def test_the_home_town_wins_over_a_neighbour_with_the_same_address(upstream):
    upstream += [
        _hit("Bahnhofstrasse 19a <b>4106 Therwil</b>", 2608865, 1260954, 47.49, 7.55),
        _hit("Bahnhofstrasse 19a <b>4104 Oberwil BL</b>", 2608977, 1262537, 47.51, 7.56),
    ]
    loc = await geocode.locate("Bahnhofstr. 19a")
    assert loc.status == "exact" and loc.hit is not None and loc.hit.home and loc.hit.town == "Oberwil"


async def test_several_towns_and_none_of_them_home_is_ambiguous_not_a_guess(upstream):
    upstream += [
        _hit("Föhrenstrasse 15 <b>4106 Therwil</b>", 2608000, 1261000),
        _hit("Föhrenstrasse 15 <b>4142 Münchenstein</b>", 2613000, 1260000),
    ]
    loc = await geocode.locate("Föhrenstrasse 15")
    assert loc.status == "ambiguous" and loc.hit is None and len(loc.candidates) == 2
    assert await geocode.locate_coordinates("Föhrenstrasse 15") is None


async def test_outside_the_area_or_not_the_same_number_is_nothing(upstream):
    upstream += [
        _hit("Erlenstrasse 60 <b>8000 Zürich</b>", 2683000, 1248000),  # outside the bbox
        _hit("Erlenstrasse 6 <b>4106 Therwil</b>", 2608938, 1261618),
    ]
    assert (await geocode.locate("Erlenstrasse 60")).status == "none"


async def test_a_name_is_not_an_address(upstream):
    upstream.append(_hit("Birsigstrasse 1 <b>4104 Oberwil BL</b>", 2608000, 1262000))
    assert (await geocode.locate("ARA Birsig")).status == "not_an_address"


async def test_a_typed_town_must_match(upstream):
    upstream += [
        _hit("Langegasse 61 <b>4104 Oberwil BL</b>", 2608000, 1262000, 47.51, 7.55),
        _hit("Langegasse 61 <b>4102 Binningen</b>", 2610000, 1264000, 47.53, 7.57),
    ]
    loc = await geocode.locate("Langegasse 61, 4102 Binningen")
    assert loc.hit is not None and loc.hit.town == "Binningen"


# --- the address the catalogue serves ------------------------------------------------------------


def _site(**kw) -> ObjectSite:
    return ObjectSite(**{"id": uuid.uuid4(), "name": "Objekt", **kw})


def test_an_address_for_every_object_that_has_one_somewhere():
    there = {"street": "Feldweg 3", "plz": "4104", "town": "Oberwil", "egid": "1"}
    # the station's own address first
    assert object_address(_site(name="Migros", address="Mühlemattstrasse 18"), there, HOME) == (
        "Mühlemattstrasse 18",
        None,
    )
    # a name that IS an address (a key box named by its door), its note dropped
    assert object_address(_site(name="Bienenstrasse 28 (EH)"), None, HOME) == ("Bienenstrasse 28", None)
    # else the register's address at the pin
    assert object_address(_site(name="Schlüsseldepot Feld"), there, HOME) == ("Feldweg 3", None)
    # nothing knowable: nothing — never the kind word
    assert object_address(_site(name="Schlüsseldepot Feld"), None, HOME) == (None, None)


def test_the_town_only_when_it_is_not_home():
    therwil = {"street": "Erlenstrasse 60", "plz": "4106", "town": "Therwil"}
    oberwil = {"street": "Vorderbergstrasse 60", "plz": "4104", "town": "Oberwil"}
    ara = _site(name="ARA Birsig", address="Erlenstrasse 60")
    assert object_address(ara, therwil, HOME) == ("Erlenstrasse 60", "Therwil")
    assert object_address(ara, oberwil, HOME) == ("Erlenstrasse 60", None)
    # the station's stored town beats the pin's
    assert object_address(_site(name="X", address="Erlenstrasse 60", locality="Therwil"), oberwil, HOME)[1] == (
        "Therwil"
    )


# --- «Lage korrigieren» --------------------------------------------------------------------------

WRONG = (47.51232, 7.54670)  # «Vorderbergstrasse 60, Oberwil» — where the import put the ARA
RIGHT = (47.50526, 7.55727)  # «Erlenstrasse 60, Therwil»


async def _ara(db) -> ObjectSite:
    o = ObjectSite(id=uuid.uuid4(), name="ARA Birsig", address="Erlenstrasse 60", lat=WRONG[0], lng=WRONG[1])
    db.add(o)
    await db.commit()
    return o


async def test_the_station_corrects_a_position_and_no_push_moves_it_back(
    client, db_session, admin_login, monkeypatch, session_factory
):
    async def bias():
        return HOME, BBOX

    monkeypatch.setattr(geocode, "_resolve_bias", bias)
    o = await _ara(db_session)
    await admin_login(client)

    r = await client.put(
        f"/api/objects/{o.id}/position",
        json={"lat": RIGHT[0], "lng": RIGHT[1], "outline": "building", "locality": "Therwil"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["lat"], body["lng"]) == RIGHT
    assert body["position_source"] == "station" and body["outline"] == "building" and body["locality"] == "Therwil"

    # the manifest push (`admin_objects push` = PUT /api/objects/{id}) keeps the station's pin…
    r = await client.put(
        f"/api/objects/{o.id}",
        json={"name": "ARA Birsig", "address": "Erlenstrasse 60", "lat": WRONG[0], "lng": WRONG[1]},
    )
    assert r.status_code == 200, r.text
    assert (r.json()["lat"], r.json()["lng"]) == RIGHT

    # …and so does a manifest reload straight into the database
    monkeypatch.setattr(admin_objects, "async_session_maker", session_factory)
    entry = admin_objects.ObjectEntry(
        id=str(o.id), name="ARA Birsig", address="Erlenstrasse 60", lat=WRONG[0], lng=WRONG[1]
    )
    await admin_objects._load(admin_objects.Path("/nonexistent/objects.manifest.json"), [entry])
    oid = o.id
    db_session.expire_all()
    row = (await db_session.execute(select(ObjectSite).where(ObjectSite.id == oid))).scalar_one()
    assert (float(row.lat), float(row.lng)) == RIGHT

    # the change is in the object's history, with what it said before
    hist = (await client.get(f"/api/objects/{oid}/position/history")).json()
    assert [h["action"] for h in hist] == ["set"]
    assert hist[0]["before"]["lat"] == WRONG[0] and hist[0]["after"]["position_source"] == "station"
    assert hist[0]["actor"] == "Verwaltung"


async def test_undo_takes_the_last_correction_back_once(client, db_session, admin_login):
    o = await _ara(db_session)
    await admin_login(client)
    await client.put(f"/api/objects/{o.id}/position", json={"lat": RIGHT[0], "lng": RIGHT[1], "outline": "none"})

    r = await client.post(f"/api/objects/{o.id}/position/undo")
    assert r.status_code == 200, r.text
    assert (r.json()["lat"], r.json()["lng"]) == WRONG
    assert r.json()["position_source"] is None and r.json()["outline"] is None
    assert (await client.post(f"/api/objects/{o.id}/position/undo")).status_code == 409
    rows = (await db_session.execute(select(ObjectPositionEvent.action).order_by(ObjectPositionEvent.id))).scalars()
    assert list(rows) == ["set", "undo"]


async def test_only_editors_and_the_admin_correct_a_position(client, db_session, viewer, editor):
    o = await _ara(db_session)
    await _login(client, viewer)
    r = await client.put(f"/api/objects/{o.id}/position", json={"lat": RIGHT[0], "lng": RIGHT[1]})
    assert r.status_code == 403
    await _login(client, editor)
    r = await client.put(f"/api/objects/{o.id}/position", json={"lat": RIGHT[0], "lng": RIGHT[1]})
    assert r.status_code == 200, r.text
    hist = (await client.get(f"/api/objects/{o.id}/position/history")).json()
    assert hist[0]["actor"] == editor.display_name


async def test_out_of_range_is_refused(client, db_session, admin_login):
    o = await _ara(db_session)
    await admin_login(client)
    r = await client.put(f"/api/objects/{o.id}/position", json={"lat": 2_600_000, "lng": 1_260_000})
    assert r.status_code == 422


# --- the outline choice in the footprint job -----------------------------------------------------


def _box(lng0: float, lat0: float, d: float) -> list[tuple[float, float]]:
    return [(lng0, lat0), (lng0 + d, lat0), (lng0 + d, lat0 + d), (lng0, lat0 + d)]


def test_the_stations_outline_choice_beats_the_rule():
    at = (7.5701, 47.5201)
    own = _box(7.5700, 47.5200, 0.0003)
    other = _box(7.5705, 47.5200, 0.0003)
    parcel = [[_box(7.5699, 47.5199, 0.001)]]
    facts = {of._point_key(at[1], at[0]): of.Facts(area_class=None, area=None, parcel=parcel, buildings=[own, other])}
    points = {"a": at}
    # automatic: every building on the parcel
    assert len(of.derive_all(points, facts)["a"]["footprint"]["coordinates"]) == 2
    # only the building at the pin
    got = of.derive_all(points, facts, {"a": "building"})["a"]
    assert got["source"] == "station" and len(got["footprint"]["coordinates"]) == 1
    # no outline at all
    assert "a" not in of.derive_all(points, facts, {"a": "none"})
    # a changed choice changes the signature, so the job re-derives
    assert of._signature(points, set(facts)) != of._signature(points, set(facts), {"a": "none"})


async def test_the_catalogue_says_none_and_sends_no_footprint(client, db_session, editor, admin_login):
    o = await _ara(db_session)
    await admin_login(client)
    await client.put(f"/api/objects/{o.id}/position", json={"lat": RIGHT[0], "lng": RIGHT[1], "outline": "none"})
    await _login(client, editor)
    body = (await client.get("/api/reference/objects")).json()
    ara = next(x for x in body["objects"] if x["name"] == "ARA Birsig")
    assert ara["outline"] == "none" and ara["footprint"] is None
    assert (ara["lat"], ara["lng"]) == RIGHT


# --- the colours' config ------------------------------------------------------------------------


def test_object_categories_are_validated_in_the_config():
    from pydantic import ValidationError

    from app.schemas import DeploymentConfigIn

    ok = DeploymentConfigIn.model_validate(
        {
            "map": {
                "objectCategories": [
                    {
                        "id": "pv",
                        "label": {"de": "Photovoltaik"},
                        "color": "#f59e0b",
                        "match": {"modules": ["modul5-pv*"]},
                    },
                    {"id": "rest", "label": "Ohne Pläne", "color": "#64748b", "match": {"kinds": ["objekt"]}},
                ]
            }
        }
    )
    assert [c.id for c in ok.map.objectCategories] == ["pv", "rest"]
    assert DeploymentConfigIn.model_validate({}).map.objectCategories == []  # unset = today's look
    for bad in (
        {"id": "pv", "label": "PV", "color": "orange"},
        {"id": "PV Anlagen", "label": "PV", "color": "#f59e0b"},
        {"id": "pv", "label": "PV", "color": "#f59e0b", "match": {"kinds": ["haus"]}},
    ):
        with pytest.raises(ValidationError):
            DeploymentConfigIn.model_validate({"map": {"objectCategories": [bad]}})
    with pytest.raises(ValidationError, match="used twice"):
        DeploymentConfigIn.model_validate(
            {"map": {"objectCategories": [{"id": "a", "label": "A", "color": "#000000"}] * 2}}
        )

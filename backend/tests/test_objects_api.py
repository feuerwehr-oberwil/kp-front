"""Einsatzobjekte + per-object module plans (`app/api/objects.py`).

Digest verification on `PUT /objects/{id}/plans/{module}` is already held end-to-end by
`test_plan_publish_guard.py`, and manifest-driven upsert/create-vs-update is held by
`test_admin_objects_key.py` / `test_admin_objects_push.py` (those go through `admin_objects`,
not this router) — none of that is repeated here. This file covers the router surface those
don't reach: listing/filtering, the plain CRUD door (as opposed to the CLI's upsert-by-key),
the two upload failure branches the digest tests don't exercise (missing object, wrong content
type), and — the least-covered branch of the file — `objects_near_incident`'s address-match-
beats-distance rule and its 400 m radius cutoff.
"""

import uuid

import pytest

from app.api.objects import _norm_addr
from app.models import Incident, ObjectSite, ReferenceDataset

PIN = "135790"


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": PIN})
    assert r.status_code == 200, r.text


def _obj(**kw) -> ObjectSite:
    base = {"name": "Schulhaus Dorfmatt"}
    return ObjectSite(**{**base, **kw})


# --- _norm_addr ---------------------------------------------------------------------------


def test_norm_addr_folds_diacritics_case_and_punctuation():
    """The reason it exists: a typed, NFC 'ü' and an NFD-decomposed one from a macOS folder
    name must compare equal, alongside the ordinary case/whitespace/punctuation noise."""
    assert _norm_addr("Mühlemattstrasse 22") == _norm_addr("muhlemattstrasse  22,")
    # NFD form: 'u' + combining diaeresis, the shape macOS folder names carry.
    assert _norm_addr("Mühlemattstrasse 22") == _norm_addr("Mühlemattstrasse 22")


def test_norm_addr_of_nothing_is_empty():
    assert _norm_addr(None) == ""
    assert _norm_addr("") == ""


# --- list_objects ---------------------------------------------------------------------------


async def test_list_objects_filters_by_name(client, editor, db_session):
    db_session.add_all([_obj(name="Schulhaus Dorfmatt"), _obj(name="Werkhof")])
    await db_session.commit()
    await _login(client, editor)

    r = await client.get("/api/objects", params={"q": "schulhaus"})
    assert r.status_code == 200, r.text
    names = [o["name"] for o in r.json()]
    assert names == ["Schulhaus Dorfmatt"]


async def test_list_objects_near_sorts_by_distance_object_without_coords_last(client, editor, db_session):
    near = _obj(name="Nah", lat=47.502, lng=7.5)  # ~222 m from the reference point
    far = _obj(name="Fern", lat=47.505, lng=7.5)  # ~556 m
    no_coords = _obj(name="Ohne Koordinaten")
    db_session.add_all([far, near, no_coords])
    await db_session.commit()
    await _login(client, editor)

    r = await client.get("/api/objects", params={"near": "7.5,47.5"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [o["name"] for o in body] == ["Nah", "Fern", "Ohne Koordinaten"]
    assert body[0]["distance_m"] < body[1]["distance_m"]
    assert body[2]["distance_m"] is None


async def test_list_objects_rejects_a_malformed_near(client, editor):
    await _login(client, editor)
    r = await client.get("/api/objects", params={"near": "not-a-coordinate"})
    assert r.status_code == 422
    assert r.json()["detail"] == "near muss 'lng,lat' sein"


# --- get_object -------------------------------------------------------------------------


async def test_get_object_404_for_unknown_id(client, editor):
    await _login(client, editor)
    r = await client.get(f"/api/objects/{uuid.uuid4()}")
    assert r.status_code == 404
    assert r.json()["detail"] == "Objekt nicht gefunden"


async def test_get_object_includes_its_plans(client, editor, db_session):
    obj = _obj()
    db_session.add(obj)
    await db_session.flush()
    db_session.add(ReferenceDataset(id=f"plan:{obj.id}:modul1", object_id=obj.id, module="modul1", kind="pdf"))
    await db_session.commit()
    await _login(client, editor)

    r = await client.get(f"/api/objects/{obj.id}")
    assert r.status_code == 200, r.text
    plans = r.json()["plans"]
    assert [p["module"] for p in plans] == ["modul1"]


# --- create_object ------------------------------------------------------------------------


async def test_create_object_stores_all_fields(client, admin_login, db_session):
    await admin_login(client)
    body = {
        "name": "Werkhof",
        "address": "Industriestrasse 5",
        "lat": 47.51,
        "lng": 7.52,
        "source_note": "manuell erfasst",
    }
    r = await client.post("/api/objects", json=body)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["name"] == "Werkhof"
    assert out["address"] == "Industriestrasse 5"
    assert out["source_note"] == "manuell erfasst"
    assert out["lat"] == pytest.approx(47.51)


# --- upsert_object --------------------------------------------------------------------------


async def test_upsert_object_creates_a_new_row_under_the_given_id(client, admin_login, db_session):
    """The CLI upserts by content-hashed key (see test_admin_objects_key.py); this door takes
    the id straight from the URL — the admin UI's "new object" form goes through it."""
    await admin_login(client)
    new_id = uuid.uuid4()
    r = await client.put(f"/api/objects/{new_id}", json={"name": "Neues Objekt"})
    assert r.status_code == 200, r.text
    assert r.json()["id"] == str(new_id)

    from sqlalchemy import select

    row = (await db_session.execute(select(ObjectSite).where(ObjectSite.id == new_id))).scalar_one()
    assert row.name == "Neues Objekt"


async def test_upsert_object_replaces_every_field_not_just_the_ones_given(client, admin_login, db_session):
    """PUT is a full replace, not a merge: `for k, v in body.model_dump().items(): setattr(...)`
    sets every ObjectIn field, so omitting `address`/`lat`/`lng` from the body clears them
    rather than leaving the old values standing. Worth pinning down explicitly — an admin form
    that only sends the fields it shows would silently null out the rest."""
    obj = _obj(address="Alte Adresse 1", lat=47.5, lng=7.5, source_note="alt")
    db_session.add(obj)
    await db_session.commit()
    await admin_login(client)

    r = await client.put(f"/api/objects/{obj.id}", json={"name": "Schulhaus Dorfmatt"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["address"] is None
    assert out["lat"] is None
    assert out["source_note"] is None


# --- upload_plan: the two failure branches the digest tests don't cover -------------------


async def test_upload_plan_404_when_the_object_does_not_exist(client, admin_login):
    await admin_login(client)
    r = await client.put(
        f"/api/objects/{uuid.uuid4()}/plans/modul1",
        files={"file": ("modul1.pdf", b"%PDF-1.4\n", "application/pdf")},
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "Objekt nicht gefunden"


async def test_upload_plan_415_when_the_file_is_not_a_pdf(client, admin_login, db_session):
    obj = _obj()
    db_session.add(obj)
    await db_session.commit()
    await admin_login(client)

    r = await client.put(
        f"/api/objects/{obj.id}/plans/modul1",
        files={"file": ("modul1.png", b"\x89PNG\r\n", "image/png")},
    )
    assert r.status_code == 415
    assert "PDF" in r.json()["detail"]


# --- objects_near_incident -----------------------------------------------------------------


def _incident(**kw) -> Incident:
    base = {"title": "Brand Bahnhofstrasse 12", "source": "manual", "status": "offen"}
    return Incident(**{**base, **kw})


async def test_objects_near_incident_404_for_unknown_incident(client, editor):
    await _login(client, editor)
    r = await client.get(f"/api/incidents/{uuid.uuid4()}/objects")
    assert r.status_code == 404
    assert r.json()["detail"] == "Einsatz nicht gefunden"


async def test_address_match_wins_over_a_closer_object(client, editor, db_session):
    """The doctrine reason for the whole address-match branch: geocoding is imprecise and many
    objects sit within 400 m of each other, so the nearest-by-coordinates object can be a
    neighbour. The address-matching one has to come first regardless of distance."""
    inc = _incident(address="Bahnhofstrasse 12", lat=47.5, lng=7.5)
    same_spot_wrong_address = _obj(name="Nachbar", address="Nebenstrasse 3", lat=47.5, lng=7.5)
    far_but_matching = _obj(name="Bahnhofstrasse Fern", address="Bahnhofstrasse 12", lat=47.9, lng=7.9)
    db_session.add_all([inc, same_spot_wrong_address, far_but_matching])
    await db_session.commit()
    await _login(client, editor)

    r = await client.get(f"/api/incidents/{inc.id}/objects")
    assert r.status_code == 200, r.text
    names = [o["name"] for o in r.json()]
    assert names == ["Bahnhofstrasse Fern", "Nachbar"]


async def test_address_match_tolerates_a_house_number_suffix(client, editor, db_session):
    """`oa.startswith(ia) or ia.startswith(oa)` — an incident address is a bare street+number
    from dispatch, and an Einsatzobjekt's address may carry a letter suffix (12 vs. 12b)."""
    inc = _incident(address="Bahnhofstrasse 12", lat=47.5, lng=7.5)
    obj = _obj(name="Hinterhaus", address="Bahnhofstrasse 12b", lat=47.9, lng=7.9)
    db_session.add_all([inc, obj])
    await db_session.commit()
    await _login(client, editor)

    r = await client.get(f"/api/incidents/{inc.id}/objects")
    assert [o["name"] for o in r.json()] == ["Hinterhaus"]


async def test_objects_outside_the_radius_and_without_an_address_match_are_excluded(client, editor, db_session):
    inc = _incident(address="Bahnhofstrasse 12", lat=47.5, lng=7.5)
    inside = _obj(name="Innerhalb", address="Andere Adresse", lat=47.503, lng=7.5)  # ~333 m
    outside = _obj(name="Ausserhalb", address="Ganz andere Adresse", lat=47.506, lng=7.5)  # ~667 m
    db_session.add_all([inc, inside, outside])
    await db_session.commit()
    await _login(client, editor)

    r = await client.get(f"/api/incidents/{inc.id}/objects")
    assert r.status_code == 200, r.text
    names = [o["name"] for o in r.json()]
    assert names == ["Innerhalb"]


async def test_objects_near_incident_includes_plans(client, editor, db_session):
    inc = _incident(address="Bahnhofstrasse 12", lat=47.5, lng=7.5)
    obj = _obj(address="Bahnhofstrasse 12", lat=47.5, lng=7.5)
    db_session.add_all([inc, obj])
    await db_session.flush()
    db_session.add(ReferenceDataset(id=f"plan:{obj.id}:modul1", object_id=obj.id, module="modul1", kind="pdf"))
    await db_session.commit()
    await _login(client, editor)

    r = await client.get(f"/api/incidents/{inc.id}/objects")
    (item,) = r.json()
    assert [p["module"] for p in item["plans"]] == ["modul1"]

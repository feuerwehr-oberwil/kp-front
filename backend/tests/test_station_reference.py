"""Station reference reads for «Karte & Objekte» (`app/api/station_reference.py`, contract C3).

Who may read (account sessions + the admin session; never a link or the poster), what the object
list carries (key boxes included, plans/floors/georef, last completed visit) and the building
facts for a bare point — with the registers answered by the same MockTransport the Gebäude
card's tests use, so nothing leaves the machine.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from app import plan_tiles
from app.auth.incident_link import LINK_COOKIE, create_link_session_token
from app.models import (
    Incident,
    ObjectRef,
    ObjectSite,
    ObjectVisit,
    PlanAlignment,
    PlanPageFloor,
    PlanRevision,
    ReferenceDataset,
)
from tests.conftest import _make_user
from tests.ov_support import set_config
from tests.test_building_facts import HOME, _down, _feature, _gwr_ok, _login, _pv_ok, registers  # noqa: F401

LINK_KEY = "mint-key-0123456789-0123456789-0123"  # gitleaks:allow


async def _station(db) -> dict[str, ObjectSite]:
    """A Schloss with two modules (one aligned, a floor pack), its key box at the same door, a
    plan-less catalogue object and one without coordinates."""
    schloss = ObjectSite(
        id=uuid.uuid4(),
        name="Schloss Musterdorf",
        address="Schlossgasse 9, 9999 Musterdorf",
        lat=47.523773,
        lng=7.570188,
        filing_folder="Schlossgasse 9 - Wasserschloss",
        measures="Zufahrt nur über Schlossgasse",
        measures_source="Modul 1 · Stand 03.2026",
    )
    depot = ObjectSite(
        id=uuid.uuid4(),
        name="Schlüsseldepot Schloss",
        address="Schlossgasse 9",
        lat=47.52402,
        lng=7.56985,
        source_note="Integration: fwo-schlue",
    )
    pumpwerk = ObjectSite(id=uuid.uuid4(), name="Pumpwerk Burggarten", address="Burggartenstrasse 15a")
    kiga = ObjectSite(
        id=uuid.uuid4(), name="Kindergarten Blauen", address="Blauenstrasse 1", lat=47.526563, lng=7.568866
    )
    db.add_all([schloss, depot, pumpwerk, kiga])
    await db.flush()
    db.add(ObjectRef(object_id=depot.id, source="fwo-schlue", external_id="h-1"))
    m1, m23 = f"plan:{schloss.id}:modul1", f"plan:{schloss.id}:modul23"
    db.add_all(
        [
            ReferenceDataset(
                id=m1,
                object_id=schloss.id,
                module="modul1",
                kind="pdf",
                title="Modul 1 · Übersicht",
                storage_key="plans/m1.pdf",
            ),
            ReferenceDataset(
                id=m23,
                object_id=schloss.id,
                module="modul23",
                kind="pdf",
                title="Modul 2/3",
                storage_key="plans/m23-v2.pdf",
                current_version=2,
            ),
        ]
    )
    await db.flush()
    db.add_all(
        [
            PlanRevision(dataset_id=m1, version=1, storage_key="plans/m1.pdf"),
            PlanRevision(dataset_id=m23, version=1, storage_key="plans/m23-v1.pdf"),
            PlanRevision(dataset_id=m23, version=2, storage_key="plans/m23-v2.pdf"),
        ]
    )
    await db.flush()
    db.add_all(
        [
            # the fit and the floors of the CURRENT revision count; v1's are history
            PlanAlignment(dataset_id=m23, plan_version=2, page=1, status="approved"),
            PlanAlignment(dataset_id=m1, plan_version=1, page=0, status="pending"),
            PlanPageFloor(dataset_id=m23, plan_version=2, page=0, floor_index=-1),
            PlanPageFloor(dataset_id=m23, plan_version=2, page=1, floor_index=0, floor_name="Hauptebene"),
            PlanPageFloor(dataset_id=m23, plan_version=2, page=2, floor_index=1),
            PlanPageFloor(dataset_id=m23, plan_version=1, page=3, floor_index=5),
        ]
    )
    db.add_all(
        [
            ObjectVisit(
                id="ov-old",
                object_id=schloss.id,
                lifecycle="completed",
                revision=1,
                doc={"checklist": {"id": "einsatzplan", "title": "Kontrolle Einsatzplan"}},
                visited_at=datetime(2026, 6, 4, tzinfo=UTC),
                findings=0,
            ),
            ObjectVisit(
                id="ov-new",
                object_id=schloss.id,
                lifecycle="completed",
                revision=1,
                doc={"checklist": {"id": "schluesselhuelse", "title": "Kontrolle Schlüsselhülse"}},
                visited_at=datetime(2026, 10, 15, tzinfo=UTC),
                findings=1,
            ),
            # a draft is not a visit that happened
            ObjectVisit(
                id="ov-draft",
                object_id=schloss.id,
                lifecycle="draft",
                revision=1,
                doc={},
                visited_at=datetime(2026, 10, 16, tzinfo=UTC),
                findings=4,
            ),
        ]
    )
    await db.commit()
    return {"schloss": schloss, "depot": depot, "pumpwerk": pumpwerk, "kiga": kiga}


def _by_name(body: dict) -> dict[str, dict]:
    return {o["name"]: o for o in body["objects"]}


# --- who may read ---------------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["editor", "el", "viewer"])
async def test_every_account_role_reads_the_whole_catalogue(client, db_session, role):
    await _station(db_session)
    user = await _make_user(db_session, username=f"u-{role}", role=role)
    await _login(client, user)
    r = await client.get("/api/reference/objects")
    assert r.status_code == 200, r.text
    names = [o["name"] for o in r.json()["objects"]]
    # the key box is here — the Einsatz pickers leave it out (api/objects · list_objects)
    assert names == ["Kindergarten Blauen", "Pumpwerk Burggarten", "Schloss Musterdorf", "Schlüsseldepot Schloss"]


async def test_the_admin_session_reads_too(client, db_session, admin_login):
    await _station(db_session)
    await admin_login(client)
    r = await client.get("/api/reference/objects")
    assert r.status_code == 200
    # the admin reads the visits even while the module is off
    assert _by_name(r.json())["Schloss Musterdorf"]["lastVisit"]["id"] == "ov-new"
    assert (await client.get("/api/reference/building", params={"lat": 60.0, "lng": 20.0})).status_code == 200


async def test_no_session_is_401(client):
    assert (await client.get("/api/reference/objects")).status_code == 401
    assert (await client.get("/api/reference/building", params={"lat": HOME[0], "lng": HOME[1]})).status_code == 401


@pytest.mark.parametrize("mode", [None, "use"])
async def test_an_incident_link_never_reads_the_station(client, db_session, mode):
    from app.deployment_config import config_row

    row = await config_row(db_session)
    row.incident_link_key = LINK_KEY
    inc = Incident(title="Brand", status="offen", source="test", source_ref="1")
    db_session.add(inc)
    await db_session.commit()
    client.cookies.set(LINK_COOKIE, create_link_session_token(str(inc.id), LINK_KEY))
    headers = {"X-Incident-Link": mode} if mode else {}
    assert (await client.get("/api/reference/objects", headers=headers)).status_code == 403
    r = await client.get("/api/reference/building", params={"lat": HOME[0], "lng": HOME[1]}, headers=headers)
    assert r.status_code == 403


async def test_the_poster_token_is_refused(client):
    r = await client.get("/api/reference/objects", headers={"X-Capture-Token": "anything"})
    assert r.status_code == 403


# --- what the list carries ------------------------------------------------------------------------


async def test_the_object_shapes(client, db_session, editor):
    await _station(db_session)
    await set_config(db_session)  # Objektbesuche on
    await _login(client, editor)
    body = (await client.get("/api/reference/objects")).json()
    assert body["generatedAt"]
    objs = _by_name(body)

    schloss = objs["Schloss Musterdorf"]
    assert schloss["kind"] == "einsatzobjekt"
    assert schloss["lat"] == pytest.approx(47.523773) and schloss["lng"] == pytest.approx(7.570188)
    assert schloss["aliases"] == ["Schlossgasse 9 - Wasserschloss"]
    assert schloss["measures"] == "Zufahrt nur über Schlossgasse"
    assert schloss["measuresSource"] == "Modul 1 · Stand 03.2026"
    assert schloss["egid"] is None and schloss["footprint"] is None
    plans = {p["module"]: p for p in schloss["plans"]}
    assert plans["modul1"]["code"] == "1" and plans["modul1"]["georef"] is False  # only a pending fit
    assert plans["modul23"]["code"] == "2/3" and plans["modul23"]["georef"] is True
    assert plans["modul23"]["version"] == 2 and plans["modul23"]["title"] == "Modul 2/3"
    assert plans["modul1"]["pages"] is None  # no tile manifest written yet → unknown, never guessed
    assert schloss["floors"] == [
        {"index": -1, "name": None},
        {"index": 0, "name": "Hauptebene"},
        {"index": 1, "name": None},
    ]
    assert schloss["lastVisit"]["id"] == "ov-new"
    assert schloss["lastVisit"]["checklist"] == "Kontrolle Schlüsselhülse"
    assert schloss["lastVisit"]["defects"] == 1
    assert schloss["lastVisit"]["date"].startswith("2026-10-15")

    depot = objs["Schlüsseldepot Schloss"]
    # no key-box kind any more (review round 3): a plan-less object on the Kontrollgang, its
    # `fwo-schlue` ref and its «Schlüssel…» name notwithstanding, is an object like any other
    assert depot["kind"] == "objekt" and depot["plans"] == [] and depot["lastVisit"] is None
    assert objs["Kindergarten Blauen"]["kind"] == "objekt"
    # no coordinates is still an object — the viewer finds it by search and marks it «ungefähr»
    assert objs["Pumpwerk Burggarten"]["lat"] is None and objs["Pumpwerk Burggarten"]["lng"] is None


async def test_last_visit_is_left_out_while_the_module_is_off(client, db_session, viewer):
    await _station(db_session)
    await _login(client, viewer)
    body = (await client.get("/api/reference/objects")).json()
    assert all(o["lastVisit"] is None for o in body["objects"])


async def test_pages_come_from_an_already_written_tile_manifest(client, db_session, editor, monkeypatch):
    await _station(db_session)
    monkeypatch.setattr(plan_tiles, "stored_page_count", lambda key: 2 if key == "plans/m1.pdf" else None)
    await _login(client, editor)
    schloss = _by_name((await client.get("/api/reference/objects")).json())["Schloss Musterdorf"]
    assert {p["module"]: p["pages"] for p in schloss["plans"]} == {"modul1": 2, "modul23": None}


def test_module_codes_and_kinds():
    from app.api.station_reference import module_code, object_kind

    assert module_code("modul1") == "1"
    assert module_code("modul23") == "2/3"
    assert module_code("modul5-wasser2") == "5-wasser2"
    assert module_code(None) == "?"
    # plans or none — nothing else: «depot» is retired (review round 3, 17.10.2026)
    assert object_kind(False) == "objekt"
    assert object_kind(True) == "einsatzobjekt"


# --- the building at a point ------------------------------------------------------------------------


async def test_building_facts_without_an_incident(client, db_session, editor, registers):  # noqa: F811
    registers(identify=_gwr_ok, find=_pv_ok)
    await _login(client, editor)
    r = await client.get("/api/reference/building", params={"lat": HOME[0], "lng": HOME[1]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["registers"] == "on" and body["egid"] == "408319"
    assert body["gwr_status"] == "ok" and body["gwr"]["floors"] == 2
    assert body["plants"][0]["kind"] == "pv"
    assert body["registers_fetched_at"]
    assert body["object"] is None  # nothing in the catalogue at that door


async def test_an_exact_register_address_names_the_object(client, db_session, editor, registers):  # noqa: F811
    registers(identify=_gwr_ok)
    await set_config(db_session)
    obj = ObjectSite(name="Wohnhaus Hauptstrasse", address="Hauptstrasse 10", measures="Gas im Keller")
    box = ObjectSite(name="Schlüsseldepot Wohnhaus", address="Hauptstrasse 10, 4104 Oberwil")
    db_session.add_all([box, obj])
    await db_session.flush()
    db_session.add(ReferenceDataset(id=f"plan:{obj.id}:modul1", object_id=obj.id, module="modul1", kind="pdf"))
    db_session.add(
        ObjectVisit(
            id="ov-1",
            object_id=obj.id,
            lifecycle="completed",
            revision=1,
            doc={},
            visited_at=datetime(2026, 5, 12, tzinfo=UTC),
            findings=2,
        )
    )
    await db_session.commit()
    await _login(client, editor)
    body = (await client.get("/api/reference/building", params={"lat": HOME[0], "lng": HOME[1]})).json()
    # two objects at one door: the one with plans speaks for the building
    assert body["object"]["id"] == str(obj.id) and body["object"]["address_match"] is True
    assert body["object"]["measures"] == "Gas im Keller"
    assert body["visit"]["id"] == "ov-1" and body["visit"]["findings"] == 2


async def test_a_neighbour_is_never_the_building(client, db_session, editor, registers):  # noqa: F811
    registers(identify=_gwr_ok)
    # 10 m away, but «Hauptstrasse 12» is not «Hauptstrasse 10»
    db_session.add(ObjectSite(name="Nachbar", address="Hauptstrasse 12", lat=HOME[0] + 0.0001, lng=HOME[1]))
    await db_session.commit()
    await _login(client, editor)
    body = (await client.get("/api/reference/building", params={"lat": HOME[0], "lng": HOME[1]})).json()
    assert body["object"] is None


async def test_a_searched_address_matches_when_the_register_has_nothing(client, db_session, viewer, registers):  # noqa: F811
    registers(identify=_down)
    db_session.add(ObjectSite(name="Pumpwerk", address="Burggartenstrasse 15a"))
    await db_session.commit()
    await _login(client, viewer)
    params = {"lat": HOME[0], "lng": HOME[1], "address": "Burggartenstrasse 15a, 9999 Musterdorf"}
    body = (await client.get("/api/reference/building", params=params)).json()
    assert body["gwr_status"] == "error"
    assert body["object"]["name"] == "Pumpwerk"
    assert body["visit"] is None  # module off


async def test_building_switch_box_and_bounds(client, db_session, editor, registers):  # noqa: F811
    calls = registers(identify=_gwr_ok, find=_pv_ok)
    await _login(client, editor)
    abroad = await client.get("/api/reference/building", params={"lat": 48.137, "lng": 11.575})
    assert abroad.json()["registers"] == "outside_ch"
    assert (await client.get("/api/reference/building", params={"lat": 91, "lng": 7.5})).status_code == 422
    assert (await client.get("/api/reference/building", params={"lat": HOME[0]})).status_code == 422
    assert calls["identify"] == 0
    await set_config(db_session, map={"buildingRegister": False})
    off = await client.get("/api/reference/building", params={"lat": HOME[0], "lng": HOME[1]})
    assert off.json()["registers"] == "off" and calls["identify"] == 0


async def test_a_single_page_fit_counts_without_leaking_its_page_count(client, db_session, editor, monkeypatch):
    """A fit on page 0 of a plan with no tile manifest needs the PDF's page count to pass the
    publish gate — that count decides `georef` only and never becomes `pages`."""
    import app.api.station_reference as sr

    obj = ObjectSite(id=uuid.uuid4(), name="Schulhaus", address="Schulweg 1", lat=47.52, lng=7.57)
    db_session.add(obj)
    await db_session.flush()
    pid = f"plan:{obj.id}:modul3"
    db_session.add(ReferenceDataset(id=pid, object_id=obj.id, module="modul3", kind="pdf", storage_key="plans/m3.pdf"))
    await db_session.flush()
    db_session.add(PlanRevision(dataset_id=pid, version=1, storage_key="plans/m3.pdf"))
    await db_session.flush()
    db_session.add(PlanAlignment(dataset_id=pid, plan_version=1, page=0, status="approved"))
    await db_session.commit()

    async def one_page(key, **_):
        return 1

    monkeypatch.setattr(sr, "revision_page_count", one_page)
    await _login(client, editor)
    [plan] = _by_name((await client.get("/api/reference/objects")).json())["Schulhaus"]["plans"]
    assert plan["georef"] is True and plan["pages"] is None

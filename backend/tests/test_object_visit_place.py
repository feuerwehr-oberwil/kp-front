"""Objektbesuche at a place (16.10.2026) — the visit target, contract C1/C2 (docs/object-visits.md).

Pinned: a visit at a pin/address needs no object and keeps its place; an object visit records
where the object is; what the document must say about its target (and what is refused); an older
build that drops ``target`` on a merge keeps the stored place; the field list, the full document
and the organizer's feed carry ``target_kind`` + ``location``; the report prints the place
(«Ort ohne Stationsobjekt», LV95 + WGS84, Ablage); filing goes to ``Allgemeine Meldungen/`` with
no object folder and no year; the checklist ``targets`` field is validated.
"""

from __future__ import annotations

import copy
import json

import pytest
import pytest_asyncio
from sqlalchemy import select

from app import credentials as creds
from app import object_visit_delivery as worker
from app import storage as storage_mod
from app.checklist_templates import template_problem
from app.geo_util import lv95_to_wgs84, wgs84_to_lv95
from app.models import ObjectVisit
from app.object_visit_report import place_kind
from tests.ov_support import (
    PLACE,
    PLACE_TEMPLATE,
    TEMPLATE,
    bearer,
    jpeg,
    login,
    make_object,
    new_id,
    place_doc,
    put,
    set_config,
    set_key,
    upload,
    visit_doc,
)
from tests.sharepoint_write_fake import CLIENT_ID, CLIENT_SECRET, SITE_URL, TENANT_ID, FakeDrive

ROOT = "FÜ/Einsatzpläne"
DEST = {
    "id": "sharepoint-fu",
    "kind": "sharepoint",
    "enabled": True,
    "timing": "every-sync",
    "siteUrl": SITE_URL,
    "root": ROOT,
}


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_mod, "_ROOT", str(tmp_path))


@pytest_asyncio.fixture
async def on(db_session):
    await set_config(db_session)


# --- the document ----------------------------------------------------------------------------


async def test_a_visit_at_a_place_needs_no_object(client, editor, on, db_session):
    await login(client, editor)
    vid = new_id("ov")
    r = await put(client, vid, place_doc(vid), None)
    assert r.status_code == 200, r.text
    visit = r.json()["visit"]
    assert visit["object"] is None and visit["target"] == PLACE
    assert visit["target_kind"] == "location"
    assert visit["location"] == {
        "label": "bei Talholzstrasse 15",
        "address": "Talholzstrasse 15, 4103 Bottmingen",
        "lat": 47.52015,
        "lng": 7.57175,
    }
    row = await db_session.get(ObjectVisit, vid)
    assert row.object_id is None and row.target_kind == "location" and (row.lat, row.lng) == (47.52015, 7.57175)

    listed = (await client.get("/api/object-visits", params={"mine": 1})).json()
    assert listed[0]["id"] == vid and listed[0]["objectId"] is None and listed[0]["objectName"] is None
    assert listed[0]["target_kind"] == "location" and listed[0]["location"]["label"] == "bei Talholzstrasse 15"

    # completed, corrected: the place stays
    assert (await put(client, vid, place_doc(vid, lifecycle="completed"), 1)).status_code == 200
    r = await put(client, vid, place_doc(vid, lifecycle="completed", notes="Hydrant neu"), 2)
    assert r.status_code == 200 and r.json()["visit"]["target"]["label"] == "bei Talholzstrasse 15"


async def test_a_failed_reverse_geocode_does_not_block_a_pin(client, editor, on):
    await login(client, editor)
    vid = new_id("ov")
    target = {**PLACE, "label": "Gesetzter Punkt", "address": None}
    r = await put(client, vid, place_doc(vid, target=target), None)
    assert r.status_code == 200, r.text
    assert r.json()["visit"]["location"]["address"] is None


async def test_an_object_visit_records_where_the_object_is(client, editor, on, db_session):
    await login(client, editor)
    located = await make_object(db_session, name="Schulhaus", lat=47.521, lng=7.569)
    bare = await make_object(db_session, name="Depot")
    a, b, c = new_id("ov"), new_id("ov"), new_id("ov")
    # an older build: no target, no coordinates in the snapshot → the catalogue's position
    assert (await put(client, a, visit_doc(a, located), None)).status_code == 200
    # the new build: target + the snapshot's coordinates win
    snap = {"id": str(located.id), "name": "Schulhaus", "address": None, "lat": 47.5215, "lng": 7.5695}
    doc = visit_doc(b, located, object=snap, target={"kind": "object", "objectId": str(located.id)})
    assert (await put(client, b, doc, None)).status_code == 200
    # an object without a position: known as an object visit, no coordinates
    assert (await put(client, c, visit_doc(c, bare), None)).status_code == 200

    rows = {v.id: v for v in (await db_session.execute(select(ObjectVisit))).scalars()}
    assert (rows[a].target_kind, rows[a].lat, rows[a].lng) == ("object", 47.521, 7.569)
    assert (rows[b].lat, rows[b].lng) == (47.5215, 7.5695)
    assert (rows[c].lat, rows[c].lng) == (None, None)
    got = (await client.get(f"/api/object-visits/{a}")).json()
    assert got["target_kind"] == "object"
    assert got["location"] == {"label": "Schulhaus", "address": "Hauptstrasse 24", "lat": 47.521, "lng": 7.569}


@pytest.mark.parametrize(
    ("patch", "fragment"),
    [
        ({"object": {"id": "00000000-0000-0000-0000-000000000000", "name": "X"}}, "kein Objekt"),
        ({"target": {**PLACE, "label": "  "}}, "Bezeichnung"),
        ({"target": {**PLACE, "label": "x" * 201}}, "zu lang"),
        ({"target": {k: v for k, v in PLACE.items() if k != "lat"}}, "lat"),
        ({"target": {**PLACE, "lat": 147.0}}, "ausserhalb"),
        ({"target": {**PLACE, "lng": "7.5"}}, "Zahl"),
        ({"target": {**PLACE, "kind": "hydrant"}}, "object oder location"),
        ({"target": None}, "Objekt fehlt"),
    ],
)
async def test_the_target_is_validated(client, editor, on, patch, fragment):
    await login(client, editor)
    vid = new_id("ov")
    r = await put(client, vid, place_doc(vid, **patch), None)
    assert r.status_code == 422, r.text
    assert fragment in r.json()["detail"]


async def test_a_visit_keeps_its_kind_of_target(client, editor, on, db_session):
    await login(client, editor)
    obj = await make_object(db_session)
    vid = new_id("ov")
    assert (await put(client, vid, place_doc(vid), None)).status_code == 200
    r = await put(client, vid, visit_doc(vid, obj, target={"kind": "object", "objectId": str(obj.id)}), 1)
    assert r.status_code == 422 and "Ziel" in r.json()["detail"]
    other = new_id("ov")
    assert (await put(client, other, visit_doc(other, obj), None)).status_code == 200
    r = await put(client, other, place_doc(other), 1)
    assert r.status_code == 422
    # an object target must name the visit's object
    third = new_id("ov")
    wrong = visit_doc(third, obj, target={"kind": "object", "objectId": "00000000-0000-0000-0000-000000000000"})
    assert (await put(client, third, wrong, None)).status_code == 422


async def test_an_older_build_that_drops_the_target_keeps_the_place(client, editor, on):
    """The deployed merge (src/objectVisits/merge.ts before 16.10.2026) rebuilds the document key
    by key: a location visit comes back without ``target`` and with ``object: null``. The server
    puts the stored place back instead of refusing the only copy."""
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, place_doc(vid), None)
    old = place_doc(vid, notes="von einem alten Gerät")
    del old["target"]
    r = await put(client, vid, old, 1)
    assert r.status_code == 200, r.text
    visit = r.json()["visit"]
    assert visit["target"] == PLACE and visit["notes"] == "von einem alten Gerät" and visit["object"] is None


async def test_viewer_reads_a_place_visit_but_cannot_make_one(client, editor, viewer, on):
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, place_doc(vid), None)
    await login(client, viewer)
    assert (await client.get(f"/api/object-visits/{vid}")).json()["target"] == PLACE
    other = new_id("ov")
    assert (await put(client, other, place_doc(other), None)).status_code == 403


# --- downstream: the organizer's feed and full document (C2) ---------------------------------


async def test_the_feed_carries_target_kind_and_location(client, editor, on, db_session):
    await set_key(db_session)
    obj = await make_object(db_session, lat=47.52, lng=7.57)
    await login(client, editor)
    a, b = new_id("ov"), new_id("ov")
    await put(client, a, visit_doc(a, obj), None)
    await put(client, b, place_doc(b, lifecycle="completed"), None)

    items = (await client.get("/api/integrations/object-visits/changes", headers=bearer())).json()["items"]
    by_id = {i["id"]: i for i in items}
    at_object, at_place = by_id[a], by_id[b]
    assert at_object["target_kind"] == "object" and at_object["objectId"] == str(obj.id)
    assert at_object["location"] == {"label": obj.name, "address": obj.address, "lat": 47.52, "lng": 7.57}
    assert at_place["target_kind"] == "location"
    assert at_place["objectId"] is None and at_place["objectName"] is None and at_place["objectRefs"] == []
    assert at_place["location"]["label"] == "bei Talholzstrasse 15" and at_place["location"]["lng"] == 7.57175
    # every field a reader had before is still there
    for key in ("seq", "workRef", "revision", "lifecycle", "ready", "visitedAt", "by", "with", "findings", "url"):
        assert key in at_place, key

    full = (await client.get(f"/api/integrations/object-visits/{b}", headers=bearer())).json()
    assert full["target_kind"] == "location" and full["location"]["address"].startswith("Talholzstrasse 15")
    report = await client.get(f"/api/integrations/object-visits/{b}/report.pdf", headers=bearer())
    assert report.status_code == 200 and report.content.startswith(b"%PDF")


# --- the report --------------------------------------------------------------------------------


def _pdf_text(pdf: bytes) -> str:
    import pypdfium2 as pdfium

    return "".join(page.get_textpage().get_text_range() for page in pdfium.PdfDocument(pdf))


async def test_the_report_prints_the_place(client, editor, db_session):
    await set_config(db_session, {"destinations": [DEST]})
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, place_doc(vid, answers={"beschreibung": {"v": "Hydrant fehlt"}}), None)
    r = await client.get(f"/api/object-visits/{vid}/report.pdf")
    assert r.status_code == 200
    text = _pdf_text(r.content)
    for needle in (
        "Ort ohne Stationsobjekt",
        "bei Talholzstrasse 15 (Pin)",
        "Talholzstrasse 15, 4103 Bottmingen",
        "LV95 2",
        "WGS84 47.52015, 7.57175",
        "Allgemeine Meldungen/2026-10-16 Fehlermeldung",
        "Hydrant fehlt",
    ):
        assert needle in text, needle
    # a Fehlermeldung is a report, not a clean check
    assert "Keine Mängel" not in text


def test_place_kind_and_lv95():
    assert place_kind({"label": "Talholzstrasse 15", "address": "Talholzstrasse 15, 4103 Bottmingen"}) == "Adresse"
    assert place_kind({"label": "bei Talholzstrasse 15", "address": "Talholzstrasse 15, 4103 Bottmingen"}) == "Pin"
    assert place_kind({"label": "Gesetzter Punkt", "address": None}) == "Pin"
    east, north = wgs84_to_lv95(47.52015, 7.57175)
    assert 2_610_000 < east < 2_611_000 and 1_263_000 < north < 1_264_000
    lat, lng = lv95_to_wgs84(east, north)
    assert abs(lat - 47.52015) < 2e-5 and abs(lng - 7.57175) < 2e-5


# --- filing --------------------------------------------------------------------------------


@pytest_asyncio.fixture
async def filing(db_session):
    for name, value in (
        ("sharepoint_export_tenant_id", TENANT_ID),
        ("sharepoint_export_client_id", CLIENT_ID),
        ("sharepoint_export_client_secret", CLIENT_SECRET),
    ):
        await creds.set_value(db_session, name, value, actor_id=None)
    await set_config(db_session, {"destinations": [DEST]})
    return FakeDrive(seed=[ROOT])


async def test_a_place_visit_is_filed_under_allgemeine_meldungen(client, editor, filing, session_factory, db_session):
    drive = filing
    await login(client, editor)
    vid, att = new_id("ov"), new_id("ova")
    doc = place_doc(vid, photos=[{"id": att, "caption": "Hydrant"}])
    assert (await put(client, vid, doc, None)).status_code == 200
    assert (await upload(client, vid, att, jpeg())).status_code == 201
    assert await worker.run_once(session_factory, transport=drive.transport) == "delivered"

    folder = f"{ROOT}/Allgemeine Meldungen/2026-10-16 Fehlermeldung ({vid[-4:]})"
    assert folder in drive.folders(), drive.folders()
    names = sorted(p[len(folder) + 1 :] for p in drive.files(folder))
    assert "Objektbesuch.pdf" in names and "Objektbesuch.json" in names
    assert f"Fotos/01 Hydrant ({att[-4:]}).jpg" in names
    assert drive.json_at(f"{folder}/Objektbesuch.json")["target"]["kind"] == "location"
    # no object folder, no year level
    assert not [f for f in drive.folders() if "/Objektbesuche" in f or "/2026/" in f]
    # the report printed where it went
    assert "Allgemeine Meldungen" in _pdf_text(drive.files(folder)[f"{folder}/Objektbesuch.pdf"])

    # a correction lands in the same folder
    await put(client, vid, {**doc, "lifecycle": "completed", "visitedAt": "2026-10-17T08:00:00+02:00"}, 1)
    assert await worker.run_once(session_factory, transport=drive.transport) == "delivered"
    assert drive.json_at(f"{folder}/Objektbesuch.json")["revision"] == 2


def test_the_location_folder_is_configurable_and_plain():
    from app.schemas import ObjectVisitDestination

    dest = ObjectVisitDestination.model_validate(DEST)
    assert dest.locationFolder == "Allgemeine Meldungen/{date} {checklist} ({short})"
    custom = ObjectVisitDestination.model_validate({**DEST, "locationFolder": "/Meldungen/{location.label} {short}/"})
    values = worker.placeholders("ov123456-7f3a", {"target": PLACE, "visitedAt": "2026-10-16T17:21:00+02:00"}, None)
    assert worker.folder_segments(custom, values, at_location=True) == ["Meldungen", "bei Talholzstrasse 15 7f3a"]
    with pytest.raises(ValueError, match="locationFolder"):
        ObjectVisitDestination.model_validate({**DEST, "locationFolder": "../oben"})


# --- the checklist's targets ---------------------------------------------------------------


def test_checklist_targets_are_validated():
    assert template_problem(PLACE_TEMPLATE) is None
    assert template_problem(TEMPLATE) is None  # no targets = object only, as before
    for bad, fragment in (
        ([], "Liste"),
        ("location", "Liste"),
        (["location", "pin"], "unbekanntes Ziel"),
        (["location", "location"], "doppelt"),
    ):
        tpl = copy.deepcopy(PLACE_TEMPLATE)
        tpl["targets"] = bad
        assert fragment in (template_problem(tpl) or ""), bad
    incident = {"id": "a", "kind": "action", "title": "A", "targets": ["location"], "phases": [{"items": []}]}
    assert "nur bei kind 'visit'" in (template_problem(incident) or "")


async def test_the_catalogue_carries_the_targets(client, editor, on, admin_login):
    await admin_login(client)
    r = await client.put(
        "/api/reference/checklists:fehlermeldung",
        files={"file": ("t.json", json.dumps(PLACE_TEMPLATE).encode(), "application/json")},
        data={"title": "Fehlermeldung"},
    )
    assert r.status_code == 200, r.text
    bad = {**PLACE_TEMPLATE, "targets": ["pin"]}
    r = await client.put(
        "/api/reference/checklists:fehlermeldung",
        files={"file": ("t.json", json.dumps(bad).encode(), "application/json")},
    )
    assert r.status_code == 422
    await client.post("/api/admin/logout")
    await login(client, editor)
    templates = (await client.get("/api/object-visits/catalogue")).json()["templates"]
    assert any(t["id"] == "fehlermeldung" and t["targets"] == ["object", "location"] for t in templates)


async def test_admin_lists_name_the_place(client, editor, db_session, admin_login):
    await set_config(db_session, {"destinations": [DEST]})
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, place_doc(vid), None)
    await client.post("/api/auth/logout")
    await admin_login(client)
    rows = (await client.get("/api/admin/object-visits")).json()
    assert rows[0]["target_kind"] == "location" and rows[0]["location"]["label"] == "bei Talholzstrasse 15"
    deliveries = (await client.get("/api/admin/object-visits/deliveries")).json()
    assert deliveries[0]["objectName"] == "bei Talholzstrasse 15"

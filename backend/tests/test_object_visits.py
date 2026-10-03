"""Objektbesuche — the field API, the organizer API, the admin list (docs/object-visits.md).

What is pinned here: revisions and the idempotent replay of a lost response, the stale-base
409, the no-op PUT, the lifecycle (no reopen), photos (idempotent by hash, a clash, magic bytes),
readiness flipping and enqueuing delivery in the same transaction, the catalogue, the organizer's
key + object upsert + lists + change feed, every session that must be refused, the module switch,
the report PDF, the checklist template validator, and that the backup covers the new tables and
blobs. The delivery worker has its own file (test_object_visit_delivery.py).
"""

from __future__ import annotations

import json
import pathlib
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select

from app import storage as storage_mod
from app.auth.incident_link import LINK_COOKIE, create_link_session_token
from app.checklist_templates import template_problem
from app.database import Base
from app.models import (
    DeploymentConfig,
    Incident,
    ObjectRef,
    ObjectSite,
    ObjectVisitDelivery,
    ObjectVisitRevision,
    ReferenceDataset,
)
from tests.conftest import _make_user
from tests.ov_support import (
    TEMPLATE,
    bearer,
    jpeg,
    login,
    make_object,
    new_id,
    put,
    set_config,
    set_key,
    sha,
    upload,
    visit_doc,
)

DEST = {
    "id": "sharepoint-fu",
    "kind": "sharepoint",
    "enabled": True,
    "timing": "every-sync",
    "siteUrl": "https://feuerwehr.sharepoint.com/sites/kp",
    "root": "Einsatzpläne",
}


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_mod, "_ROOT", str(tmp_path))


@pytest_asyncio.fixture
async def el(db_session):
    return await _make_user(db_session, username="einsatzleiter", role="el")


@pytest_asyncio.fixture
async def on(db_session):
    await set_config(db_session)


@pytest_asyncio.fixture
async def obj(db_session):
    return await make_object(db_session)


# --- revisions -------------------------------------------------------------------------------


async def test_create_read_and_revise(client, editor, on, obj):
    await login(client, editor)
    vid = new_id("ov")
    r = await put(client, vid, visit_doc(vid, obj), None)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["revision"] == 1 and body["ready"] is True and body["missing"] == []
    visit = body["visit"]
    assert visit["createdBy"]["name"] == "Cmd" and visit["findings"] == 0
    assert visit["url"].endswith(f"/besuche/{vid}") and visit["deliveries"] == []

    doc = visit_doc(vid, obj, answers={"oeffnen": {"v": "defect", "note": "klemmt"}, "zugaenglich": {"v": "ok"}})
    r = await put(client, vid, doc, 1)
    assert r.status_code == 200 and r.json()["revision"] == 2
    got = (await client.get(f"/api/object-visits/{vid}")).json()
    assert got["revision"] == 2 and got["findings"] == 1 and got["answers"]["oeffnen"]["note"] == "klemmt"

    revs = (await client.get(f"/api/object-visits/{vid}/revisions")).json()
    assert [r["revision"] for r in revs] == [1, 2] and revs[0]["acceptedBy"]["name"] == "Cmd"
    first = (await client.get(f"/api/object-visits/{vid}/revisions/1")).json()
    assert first["answers"] == {} and first["revision"] == 1

    listed = (await client.get("/api/object-visits", params={"object": str(obj.id)})).json()
    assert listed[0]["id"] == vid and listed[0]["findings"] == 1 and listed[0]["by"]["name"] == "Cmd"
    assert (await client.get("/api/object-visits", params={"lifecycle": "completed"})).json() == []
    assert len((await client.get("/api/object-visits", params={"mine": 1})).json()) == 1


async def test_same_op_id_twice_replays_the_first_answer(client, editor, on, obj):
    """The lost response: the device sends the same opId again and gets the STORED first answer —
    even after a newer revision exists — and no second revision is written."""
    await login(client, editor)
    vid = new_id("ov")
    op = new_id("ovo")
    first = await put(client, vid, visit_doc(vid, obj), None, op)
    again = await put(client, vid, visit_doc(vid, obj), None, op)
    assert again.status_code == 200 and again.json() == first.json()

    second = await put(client, vid, visit_doc(vid, obj, notes="zweite Fassung"), 1)
    assert second.json()["revision"] == 2
    replay = await put(client, vid, visit_doc(vid, obj), None, op)
    assert replay.json()["revision"] == 1 and replay.json() == first.json()
    assert len((await client.get(f"/api/object-visits/{vid}/revisions")).json()) == 2


async def test_stale_base_is_a_409_with_the_server_state(client, editor, on, obj):
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, visit_doc(vid, obj), None)
    await put(client, vid, visit_doc(vid, obj, notes="A"), 1)
    r = await put(client, vid, visit_doc(vid, obj, notes="B"), 1)
    assert r.status_code == 409
    body = r.json()
    assert body["code"] == "revision_conflict" and body["revision"] == 2 and body["visit"]["notes"] == "A"
    # a CREATE for a visit that exists is the same conflict
    r = await put(client, vid, visit_doc(vid, obj, notes="C"), None)
    assert r.status_code == 409 and r.json()["code"] == "revision_conflict"


async def test_a_no_op_put_writes_nothing(client, editor, on, obj, db_session):
    await login(client, editor)
    vid = new_id("ov")
    doc = visit_doc(vid, obj)
    await put(client, vid, doc, None)
    r = await put(client, vid, doc, 1)
    assert r.status_code == 200 and r.json()["revision"] == 1
    rows = (await db_session.execute(select(ObjectVisitRevision).where(ObjectVisitRevision.visit_id == vid))).all()
    assert len(rows) == 1


async def test_lifecycle_transitions_and_no_reopen(client, editor, on, obj):
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, visit_doc(vid, obj), None)
    assert (await put(client, vid, visit_doc(vid, obj, lifecycle="completed"), 1)).status_code == 200
    # a correction stays completed
    assert (await put(client, vid, visit_doc(vid, obj, lifecycle="completed", notes="Korr."), 2)).status_code == 200
    r = await put(client, vid, visit_doc(vid, obj, lifecycle="draft"), 3)
    assert r.status_code == 422 and r.json()["code"] == "lifecycle"
    assert (await put(client, vid, visit_doc(vid, obj, lifecycle="discarded"), 3)).status_code == 422
    # the checklist snapshot is frozen once completed
    other = {**TEMPLATE, "version": 2}
    r = await put(client, vid, visit_doc(vid, obj, lifecycle="completed", checklist=other), 3)
    assert r.status_code == 422

    vid2 = new_id("ov")
    await put(client, vid2, visit_doc(vid2, obj), None)
    assert (await put(client, vid2, visit_doc(vid2, obj, lifecycle="discarded"), 1)).status_code == 200
    r = await put(client, vid2, visit_doc(vid2, obj, lifecycle="discarded", notes="x"), 2)
    assert r.status_code == 422  # discarded is terminal


@pytest.mark.parametrize(
    ("patch", "fragment"),
    [
        ({"schema": "other/1"}, "Schema"),
        ({"id": "ov9999999-zzzz"}, "id"),
        ({"object": {"id": str(uuid.uuid4())}}, "Objekt unbekannt"),
        ({"visitedAt": "gestern"}, "visitedAt"),
        ({"notes": "x" * 20_001}, "Bemerkungen"),
        ({"photos": [{"id": "ova1234567", "caption": "x" * 301}]}, "Bildlegende"),
        ({"photos": [{"id": "ova1234567"}, {"id": "ova1234567"}]}, "doppelt"),
        ({"proposals": [{"id": "ovp1234567", "field": "x"}] * 2}, "doppelt"),
        ({"lifecycle": "reopened"}, "lifecycle"),
    ],
)
async def test_the_document_is_validated(client, editor, on, obj, patch, fragment):
    await login(client, editor)
    vid = new_id("ov")
    r = await put(client, vid, visit_doc(vid, obj, **patch), None)
    assert r.status_code == 422, r.text
    assert fragment in r.json()["detail"]


async def test_too_many_photos_are_refused(client, editor, on, obj):
    await login(client, editor)
    vid = new_id("ov")
    photos = [{"id": f"ova{n:08d}"} for n in range(201)]
    assert (await put(client, vid, visit_doc(vid, obj, photos=photos), None)).status_code == 422


# --- photos and readiness ------------------------------------------------------------------------


async def test_photo_upload_is_idempotent_and_flips_readiness(client, editor, on, obj, db_session):
    await set_config(db_session, {"destinations": [DEST]})
    await login(client, editor)
    vid, att = new_id("ov"), new_id("ova")
    data = jpeg()
    doc = visit_doc(vid, obj, photos=[{"id": att, "caption": "Deckel", "sha256": sha(data), "type": "image/jpeg"}])
    r = await put(client, vid, doc, None)
    assert r.json()["ready"] is False and r.json()["missing"] == [att]
    # not ready → nothing enqueued yet
    assert (await db_session.execute(select(ObjectVisitDelivery))).scalars().all() == []
    seq_before = (await client.get(f"/api/object-visits/{vid}")).json()

    r = await upload(client, vid, att, data)
    assert r.status_code == 201 and r.json() == {"id": att, "sha256": sha(data), "size": len(data)}
    got = (await client.get(f"/api/object-visits/{vid}")).json()
    assert got["ready"] is True and got["missing"] == []
    assert seq_before["ready"] is False
    rows = (await db_session.execute(select(ObjectVisitDelivery))).scalars().all()
    assert len(rows) == 1 and rows[0].wanted_revision == 1 and rows[0].state == "pending"
    revs = (await client.get(f"/api/object-visits/{vid}/revisions")).json()
    assert revs[0]["ready"] is True

    again = await upload(client, vid, att, data)
    assert again.status_code == 200 and again.json()["sha256"] == sha(data)
    other = jpeg("blue")
    clash = await upload(client, vid, att, other)
    assert clash.status_code == 409 and clash.json()["code"] == "attachment_conflict"

    full = await client.get(f"/api/object-visits/{vid}/attachments/{att}")
    assert full.status_code == 200 and full.content == data
    thumb = await client.get(f"/api/object-visits/{vid}/attachments/{att}", params={"thumb": 1})
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/jpeg"


async def test_photo_refusals(client, editor, on, obj):
    await login(client, editor)
    vid = new_id("ov")
    data = jpeg()
    # the visit must exist first
    r = await upload(client, vid, new_id("ova"), data)
    assert r.status_code == 404 and r.json()["code"] == "visit_not_found"
    await put(client, vid, visit_doc(vid, obj), None)
    # hash and body disagree
    assert (await upload(client, vid, new_id("ova"), data, digest=sha(b"other"))).status_code == 422
    # labelled JPEG, is not
    fake = b"GIF89a" + b"\x00" * 40
    assert (await upload(client, vid, new_id("ova"), fake)).status_code == 422
    # not an allowed type
    assert (await upload(client, vid, new_id("ova"), b"%PDF-1.4", ctype="application/pdf")).status_code == 422
    # nothing stored by any refusal
    files = [p for p in pathlib.Path(storage_mod._ROOT).rglob("*") if p.is_file() and ".kp-backup" not in p.parts]
    assert files == []


async def test_photo_over_the_cap_is_refused(client, editor, on, obj, monkeypatch):
    from app import object_visits

    monkeypatch.setattr(object_visits, "MAX_ATTACHMENT_BYTES", 100)
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, visit_doc(vid, obj), None)
    r = await upload(client, vid, new_id("ova"), jpeg(size=(200, 200)))
    assert r.status_code == 422 and "zu gross" in r.json()["detail"]


async def test_a_raw_photo_body_may_exceed_the_json_cap(client, editor, on, obj, monkeypatch):
    """The body limit treats a bare image PUT as an upload, not as an 8 MB JSON body."""
    from app.config import settings

    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, visit_doc(vid, obj), None)
    monkeypatch.setattr(settings, "max_json_body_mb", 0)
    assert (await upload(client, vid, new_id("ova"), jpeg())).status_code == 201
    assert (await put(client, vid, visit_doc(vid, obj, notes="x"), 1)).status_code == 413


async def test_completed_timing_enqueues_only_completed_revisions(client, editor, on, obj, db_session):
    await set_config(db_session, {"destinations": [{**DEST, "timing": "completed"}]})
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, visit_doc(vid, obj), None)
    assert (await db_session.execute(select(ObjectVisitDelivery))).scalars().all() == []
    await put(client, vid, visit_doc(vid, obj, lifecycle="completed"), 1)
    rows = (await db_session.execute(select(ObjectVisitDelivery))).scalars().all()
    assert len(rows) == 1 and rows[0].wanted_revision == 2
    # a discarded draft that was never filed is not filed now either
    vid2 = new_id("ov")
    await put(client, vid2, visit_doc(vid2, obj), None)
    await put(client, vid2, visit_doc(vid2, obj, lifecycle="discarded"), 1)
    assert len((await db_session.execute(select(ObjectVisitDelivery))).scalars().all()) == 1


# --- access ------------------------------------------------------------------------------------


async def test_viewer_reads_but_does_not_write(client, editor, viewer, on, obj):
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, visit_doc(vid, obj), None)
    await client.post("/api/auth/logout")
    await login(client, viewer)
    assert (await client.get(f"/api/object-visits/{vid}")).status_code == 200
    cat = (await client.get("/api/object-visits/catalogue")).json()
    assert cat["canCapture"] is False
    r = await put(client, vid, visit_doc(vid, obj, notes="x"), 1)
    assert r.status_code == 403
    assert (await upload(client, vid, new_id("ova"), jpeg())).status_code == 403


async def test_el_writes_by_default_and_capture_roles_narrow_it(client, el, on, obj, db_session):
    await login(client, el)
    vid = new_id("ov")
    assert (await put(client, vid, visit_doc(vid, obj), None)).status_code == 200
    await set_config(db_session, {"captureRoles": ["editor"]})
    assert (await put(client, vid, visit_doc(vid, obj, notes="x"), 1)).status_code == 403
    assert (await client.get("/api/object-visits/catalogue")).json()["canCapture"] is False


async def test_module_off_is_404_except_for_the_admin(client, editor, obj, db_session, admin_login):
    await set_config(db_session, {"enabled": False})
    await login(client, editor)
    r = await client.get("/api/object-visits/catalogue")
    assert r.status_code == 404 and r.json()["code"] == "object_visits_disabled"
    assert (await put(client, new_id("ov"), visit_doc("x", obj), None)).status_code == 404
    await client.post("/api/auth/logout")
    await admin_login(client)
    assert (await client.get("/api/object-visits/catalogue")).status_code == 200
    assert (await client.get("/api/admin/object-visits")).status_code == 200


async def test_admin_reads_but_does_not_capture(client, editor, on, obj, admin_login):
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, visit_doc(vid, obj), None)
    await client.post("/api/auth/logout")
    await admin_login(client)
    assert (await client.get(f"/api/object-visits/{vid}")).status_code == 200
    assert (await put(client, vid, visit_doc(vid, obj, notes="x"), 1)).status_code == 403


async def _incident_with_link(db_session) -> Incident:
    from app.deployment_config import config_row

    row = await config_row(db_session)
    row.incident_link_key = "mint-key-0123456789-0123456789-0123"  # gitleaks:allow
    row.terminal_link_key = "terminal-key-0123456789-0123456789-01"
    inc = Incident(title="Brand", status="offen", source="test", source_ref="1")
    db_session.add(inc)
    await db_session.commit()
    return inc


@pytest.mark.parametrize("kind", ["alarm", "terminal"])
@pytest.mark.parametrize("mode", [None, "use"])
async def test_link_and_terminal_sessions_are_refused(client, editor, on, obj, db_session, kind, mode):
    from app.auth.incident_link import create_terminal_session_token

    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, visit_doc(vid, obj), None)
    await client.post("/api/auth/logout")
    inc = await _incident_with_link(db_session)
    if kind == "alarm":
        token = create_link_session_token(str(inc.id), "mint-key-0123456789-0123456789-0123")
    else:
        token = create_terminal_session_token(str(inc.id), "terminal-key-0123456789-0123456789-01")
    client.cookies.set(LINK_COOKIE, token)
    headers = {"X-Incident-Link": mode} if mode else {}
    for path in ("/api/object-visits/catalogue", "/api/object-visits", f"/api/object-visits/{vid}"):
        assert (await client.get(path, headers=headers)).status_code == 403, path
    r = await client.put(
        f"/api/object-visits/{vid}",
        json={"opId": new_id("ovo"), "baseRevision": 1, "doc": visit_doc(vid, obj)},
        headers=headers,
    )
    assert r.status_code == 403
    assert (await client.get("/api/integrations/object-visits/catalogue", headers=headers)).status_code == 403


async def test_a_capture_poster_token_reaches_nothing(client, on, db_session):
    from app.deployment_config import config_row

    row = await config_row(db_session)
    row.capture_secret = "poster-secret"
    await db_session.commit()
    r = await client.get("/api/object-visits/catalogue", headers={"X-Capture-Token": "poster-secret"})
    assert r.status_code == 403
    assert (await client.get("/api/object-visits/catalogue")).status_code == 401


# --- catalogue ---------------------------------------------------------------------------------


async def _store_template(db, tpl: dict, storage_key: str) -> None:
    storage_mod.put_bytes(storage_key, json.dumps(tpl).encode())
    db.add(
        ReferenceDataset(id=f"checklists:{tpl['id']}", kind="checklists", title=tpl["title"], storage_key=storage_key)
    )
    await db.commit()


async def test_catalogue_lists_every_object_templates_and_lists(client, editor, on, obj, db_session):
    plan_obj = await make_object(db_session, name="Schulhaus", address="Schulweg 1", source_note="SharePoint")
    db_session.add(
        ReferenceDataset(id=f"plan:{plan_obj.id}:modul1", object_id=plan_obj.id, module="modul1", kind="pdf")
    )
    db_session.add(ObjectRef(object_id=obj.id, source="fwo", external_id="abc"))
    await db_session.commit()
    await _store_template(db_session, TEMPLATE, "reference/visit.json")
    await _store_template(
        db_session, {"id": "fu", "kind": "action", "title": "FU", "phases": [{}]}, "reference/fu.json"
    )
    await set_config(db_session, {"proposalFields": [{"id": "owner_contact", "label": "Kontakt Eigentümer"}]})

    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, visit_doc(vid, obj, lifecycle="completed"), None)
    cat = (await client.get("/api/object-visits/catalogue")).json()
    assert cat["canCapture"] is True
    by_name = {o["name"]: o for o in cat["objects"]}
    assert by_name["Schulhaus"]["hasPlans"] is True and by_name["Schulhaus"]["folder"] == "Schulweg 1 - Schulhaus"
    assert by_name["Gemeindeverwaltung"]["hasPlans"] is False
    assert by_name["Gemeindeverwaltung"]["refs"] == [{"source": "fwo", "id": "abc"}]
    assert by_name["Gemeindeverwaltung"]["lastVisit"]["id"] == vid
    assert [t["id"] for t in cat["templates"]] == ["schluesselhuelse"]  # incident templates stay out
    assert cat["proposalFields"] == [{"id": "owner_contact", "label": "Kontakt Eigentümer"}]
    assert cat["lists"] == []


# --- the organizer ------------------------------------------------------------------------------


async def test_organizer_key_gate(client, editor, on, db_session):
    assert (await client.get("/api/integrations/object-visits/catalogue", headers=bearer())).status_code == 403
    await set_key(db_session)
    assert (await client.get("/api/integrations/object-visits/catalogue")).status_code == 401
    bad = {"Authorization": "Bearer nope-nope-nope-nope-nope-nope"}
    assert (await client.get("/api/integrations/object-visits/catalogue", headers=bad)).status_code == 401
    # a browser session is not the key …
    await login(client, editor)
    assert (await client.get("/api/integrations/object-visits/catalogue")).status_code == 401
    await client.post("/api/auth/logout")
    # … and the key is not a session
    assert (await client.get("/api/object-visits/catalogue", headers=bearer())).status_code == 401
    r = await client.get("/api/integrations/object-visits/catalogue", headers=bearer())
    assert r.status_code == 200 and r.json()["canCapture"] is False
    await set_config(db_session, {"enabled": False})
    r = await client.get("/api/integrations/object-visits/catalogue", headers=bearer())
    assert r.status_code == 404 and r.json()["code"] == "object_visits_disabled"


async def test_organizer_object_upsert_resolution(client, on, db_session):
    await set_key(db_session)
    plans = await make_object(
        db_session,
        name="Gemeindeverwaltung",
        address="Hauptstrasse 24",
        source_note="OneDrive: Einsatzpläne/Hauptstrasse 24 - Gemeindeverwaltung",
    )
    db_session.add(ReferenceDataset(id=f"plan:{plans.id}:modul1", object_id=plans.id, module="modul1", kind="pdf"))
    await db_session.commit()

    # by folder → the plan object, ref attached, never renamed
    r = await client.put(
        "/api/integrations/objects/fwo/Hauptstrasse 24 - Gemeindeverwaltung",
        json={"name": "Gemeinde (anders)", "folder": "hauptstrasse 24 -  gemeindeverwaltung", "lat": 47.5, "lng": 7.5},
        headers=bearer(),
    )
    assert r.status_code == 200 and r.json() == {"objectId": str(plans.id), "created": False}
    await db_session.refresh(plans)
    assert plans.name == "Gemeindeverwaltung" and float(plans.lat) == 47.5

    # new → created, no plans, with its folder; idempotent the second time
    body = {"name": "Schlüsselbox Allmend", "address": "Allmend 1", "folder": "Allmend 1 - Box"}
    r1 = await client.put("/api/integrations/objects/fwo-schlue/a1b2", json=body, headers=bearer())
    r2 = await client.put("/api/integrations/objects/fwo-schlue/a1b2", json=body, headers=bearer())
    assert r1.json()["created"] is True and r2.json() == {"objectId": r1.json()["objectId"], "created": False}
    created = await db_session.get(ObjectSite, uuid.UUID(r1.json()["objectId"]))
    await db_session.refresh(created)
    assert created.source_note == "Integration: fwo-schlue" and created.filing_folder == "Allmend 1 - Box"

    # an external id with a slash travels through the path
    r = await client.put("/api/integrations/objects/firegis/a/b%2Fc", json={"name": "Hydrant 7"}, headers=bearer())
    assert r.status_code == 200
    ref = (await db_session.execute(select(ObjectRef).where(ObjectRef.source == "firegis"))).scalar_one()
    assert ref.external_id == "a/b/c"
    assert (
        await client.put("/api/integrations/objects/BAD SOURCE/x", json={"name": "x"}, headers=bearer())
    ).status_code == 422


async def test_integration_objects_stay_off_incident_surfaces(client, editor, on, db_session, admin_login):
    """A key box an organizer created has no plans: the field pickers and the incident's plan
    rail must not be flooded with it. The admin keeps the complete list."""
    await set_key(db_session)
    await client.put(
        "/api/integrations/objects/fwo/box1", json={"name": "Box", "lat": 47.5, "lng": 7.5}, headers=bearer()
    )
    plain = await make_object(db_session, name="Werkhof", address="Werkweg 1", lat=47.5, lng=7.5)
    inc = Incident(title="Brand", status="offen", lat=47.5, lng=7.5, source="test", source_ref="2")
    db_session.add(inc)
    await db_session.commit()
    await login(client, editor)
    names = {o["name"] for o in (await client.get("/api/objects", params={"near": "7.5,47.5"})).json()}
    assert names == {plain.name}
    near = {o["name"] for o in (await client.get(f"/api/incidents/{inc.id}/objects")).json()}
    assert near == {plain.name}
    cat = {o["name"] for o in (await client.get("/api/object-visits/catalogue")).json()["objects"]}
    assert cat == {"Box", "Werkhof"}
    await client.post("/api/auth/logout")
    await admin_login(client)
    assert {o["name"] for o in (await client.get("/api/objects")).json()} == {"Box", "Werkhof"}


async def test_organizer_lists_and_change_feed(client, editor, on, obj, db_session):
    await set_key(db_session)
    db_session.add(ObjectRef(object_id=obj.id, source="fwo", external_id="gv"))
    await db_session.commit()
    ref = "fwo-admin:fu-2026/B4"
    body = {
        "title": "Tour B4",
        "closesAt": "2026-11-30T00:00:00Z",
        "objects": [{"source": "fwo", "id": "gv"}, {"source": "fwo", "id": "später"}],
    }
    r = await client.put(f"/api/integrations/visit-lists/{ref}", json=body, headers=bearer())
    assert r.status_code == 200, r.text
    assert r.json() == {
        "ref": ref,
        "objectIds": [str(obj.id)],
        "unresolved": [{"source": "fwo", "id": "später"}],
        "done": {},
    }

    await login(client, editor)
    lists = (await client.get("/api/object-visits/catalogue")).json()["lists"]
    assert lists[0]["ref"] == ref and lists[0]["objectIds"] == [str(obj.id)]

    a, b = new_id("ov"), new_id("ov")
    await put(client, a, visit_doc(a, obj, workRef=ref), None)
    await put(client, b, visit_doc(b, obj), None)
    await put(
        client,
        a,
        visit_doc(
            a,
            obj,
            workRef=ref,
            lifecycle="completed",
            proposals=[{"id": "ovp1234567", "field": "owner_contact", "proposed": "Hr. Keller"}],
        ),
        1,
    )

    feed = (await client.get("/api/integrations/object-visits/changes", headers=bearer())).json()
    assert [i["id"] for i in feed["items"]] == [b, a]  # one item per visit, latest state, by seq
    item = feed["items"][1]
    assert item["revision"] == 2 and item["lifecycle"] == "completed" and item["workRef"] == ref
    assert item["objectRefs"] == [{"source": "fwo", "id": "gv"}] and item["by"]["name"] == "Cmd"
    assert item["proposals"][0]["proposed"] == "Hr. Keller"
    assert item["seq"] > feed["items"][0]["seq"]
    rest = (
        await client.get(
            "/api/integrations/object-visits/changes", params={"after": feed["nextAfter"]}, headers=bearer()
        )
    ).json()
    assert rest == {"items": [], "nextAfter": feed["nextAfter"]}

    # a ref attached LATER shows up in the feed's objectRefs
    await client.put(
        "/api/integrations/objects/fwo2/folder-x",
        json={"name": obj.name, "folder": "Hauptstrasse 24 - Gemeindeverwaltung"},
        headers=bearer(),
    )
    feed = (await client.get("/api/integrations/object-visits/changes", headers=bearer())).json()
    assert {"source": "fwo2", "id": "folder-x"} in feed["items"][1]["objectRefs"]

    assert (await client.get(f"/api/integrations/object-visits/{a}", headers=bearer())).json()["revision"] == 2
    pdf = await client.get(f"/api/integrations/object-visits/{a}/report.pdf", headers=bearer())
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")

    r = await client.delete(f"/api/integrations/visit-lists/{ref}", headers=bearer())
    assert r.json() == {"ref": ref, "deleted": True}
    assert (await client.get("/api/object-visits/catalogue")).json()["lists"] == []


# --- the report -------------------------------------------------------------------------------


@pytest.mark.parametrize("lifecycle", ["draft", "completed", "discarded"])
async def test_report_renders_with_and_without_photos(client, editor, on, obj, lifecycle):
    await login(client, editor)
    vid, stored, pending = new_id("ov"), new_id("ova"), new_id("ova")
    data = jpeg()
    doc = visit_doc(
        vid,
        obj,
        lifecycle="draft",
        answers={
            "oeffnen": {"v": "defect", "note": "klemmt"},
            "gereinigt": {"v": "yes"},
            "zustand": {"v": "mittel"},
            "anzahl": {"v": 2},
        },
        notes="Deckel <klemmt> & quietscht\nzweite Zeile",
        photos=[{"id": stored, "caption": "Deckel", "item": "oeffnen"}, {"id": pending, "caption": "Schlüssel"}],
        proposals=[{"id": "ovp1234567", "field": "owner_contact", "label": "Kontakt", "current": "A", "proposed": "B"}],
    )
    await put(client, vid, doc, None)
    await upload(client, vid, stored, data)
    if lifecycle != "draft":
        await put(client, vid, {**doc, "lifecycle": lifecycle}, 1)
    r = await client.get(f"/api/object-visits/{vid}/report.pdf")
    assert r.status_code == 200 and r.content.startswith(b"%PDF") and r.headers["content-type"] == "application/pdf"
    first = await client.get(f"/api/object-visits/{vid}/report.pdf", params={"revision": 1})
    assert first.status_code == 200
    assert (await client.get(f"/api/object-visits/{vid}/report.pdf", params={"revision": 9})).status_code == 404


def test_report_text_says_nicht_geprüft_and_stamps():
    import pypdfium2 as pdfium

    from app.object_visit_report import answer_text, render_visit_pdf

    assert answer_text({"input": "check"}, None) == "nicht geprüft"
    assert answer_text({"input": "yesno"}, {"v": "no"}) == "Nein"
    assert answer_text({"input": "choice", "options": [{"id": "g", "label": "Gut"}]}, {"v": "g"}) == "Gut"
    doc = visit_doc(
        "ov1234567-abcd",
        ObjectSite(id=uuid.uuid4(), name="Objekt", address="Weg 1"),
        photos=[{"id": "ova1234567", "caption": "Bild"}],
    )
    pdf = render_visit_pdf(
        doc,
        revision=3,
        stand="2026-10-03T09:41:00Z",
        station="FW Test",
        url="https://x/besuche/ov1",
        created_by="Cmd",
        photos={"ova1234567": None},
    )
    text = "".join(page.get_textpage().get_text_range() for page in pdfium.PdfDocument(pdf))
    for needle in ("ENTWURF", "Revision 3", "nicht geprüft", "Foto ausstehend", "ov1234567-abcd", "Frei Nina"):
        assert needle in text, needle


# --- the template validator ------------------------------------------------------------------


def test_visit_template_validation():
    assert template_problem(TEMPLATE) is None
    bad_input = json.loads(json.dumps(TEMPLATE))
    bad_input["phases"][0]["items"][0]["input"] = "slider"
    assert "input" in (template_problem(bad_input) or "")
    no_options = json.loads(json.dumps(TEMPLATE))
    no_options["phases"][0]["items"][3]["options"] = []
    assert "options" in (template_problem(no_options) or "")
    dup = json.loads(json.dumps(TEMPLATE))
    dup["phases"][0]["items"][1]["id"] = "zugaenglich"
    assert "doppelt" in (template_problem(dup) or "")
    assert template_problem({"id": "x", "kind": "visit", "title": "X", "entries": [{}]}) is not None


async def test_reference_upload_accepts_a_visit_template(client, admin_login):
    await admin_login(client)
    r = await client.put(
        "/api/reference/checklists:schluesselhuelse",
        files={"file": ("t.json", json.dumps(TEMPLATE).encode(), "application/json")},
        data={"title": "Kontrolle"},
    )
    assert r.status_code == 200, r.text
    bad = {**TEMPLATE, "phases": [{"items": [{"id": "a", "text": "A", "input": "choice"}]}]}
    r = await client.put(
        "/api/reference/checklists:schluesselhuelse",
        files={"file": ("t.json", json.dumps(bad).encode(), "application/json")},
    )
    assert r.status_code == 422


# --- config, admin, backup ---------------------------------------------------------------------


async def test_config_section_round_trips_without_secrets(client, put_config, admin_login):
    await admin_login(client)
    section = {
        "enabled": True,
        "destinations": [{**DEST, "root": "/FÜ/Einsatzpläne/"}],
        "proposalFields": [{"id": "zugang", "label": "Zugang"}],
    }
    r = await put_config(client, {"objectVisits": section})
    assert r.status_code == 200, r.text
    got = (await client.get("/api/config")).json()["objectVisits"]
    assert got["enabled"] is True and got["captureRoles"] == ["editor", "el"]
    assert got["destinations"][0]["root"] == "FÜ/Einsatzpläne"
    assert got["destinations"][0]["visitFolder"] == "Objektbesuche/{date} {checklist} ({short})"
    assert "secret" not in json.dumps(got).lower()
    bad = await put_config(client, {"objectVisits": {"destinations": [{**DEST, "siteUrl": "http://x"}]}})
    assert bad.status_code == 422


async def test_credentials_are_listed_in_their_groups(client, admin_login):
    await admin_login(client)
    creds = {c["name"]: c for c in (await client.get("/api/integrations/credentials")).json()}
    assert creds["object_visits_integration_key"]["group"] == "object_visits"
    assert creds["object_visits_integration_key"]["secret"] is True
    assert {
        creds[n]["group"]
        for n in ("sharepoint_export_tenant_id", "sharepoint_export_client_id", "sharepoint_export_client_secret")
    } == {"sharepoint_export"}
    r = await client.put("/api/integrations/credentials/object_visits_integration_key", json={"value": "short"})
    assert r.status_code == 422


async def test_admin_list_retry_and_export(client, editor, on, obj, db_session, admin_login):
    await set_config(db_session, {"destinations": [DEST]})
    await login(client, editor)
    vid, att = new_id("ov"), new_id("ova")
    data = jpeg()
    await put(client, vid, visit_doc(vid, obj, photos=[{"id": att, "caption": "Deckel"}]), None)
    await upload(client, vid, att, data)
    row = (await db_session.execute(select(ObjectVisitDelivery))).scalar_one()
    row.state = "failed"
    row.attempts = 4
    row.last_error = "403"
    await db_session.commit()
    await client.post("/api/auth/logout")
    await admin_login(client)

    assert [v["id"] for v in (await client.get("/api/admin/object-visits")).json()] == [vid]
    deliveries = (await client.get("/api/admin/object-visits/deliveries")).json()
    assert deliveries[0]["state"] == "failed" and deliveries[0]["objectName"] == obj.name
    r = await client.post("/api/admin/object-visits/deliveries/retry", json={"destination": DEST["id"]})
    assert r.json() == {"retried": 1}
    await db_session.refresh(row)
    assert row.state == "pending" and row.attempts == 0

    z = await client.get("/api/admin/object-visits/export.zip")
    assert z.status_code == 200
    import io
    import zipfile

    names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
    assert any(n.endswith("/Objektbesuch.pdf") for n in names)
    assert any("/Fotos/01 Deckel" in n for n in names)
    t = await client.post(f"/api/admin/object-visits/destinations/{DEST['id']}/test")
    assert t.json()["ok"] is False  # no export credentials
    assert (await client.post("/api/admin/object-visits/destinations/nope/test")).status_code == 404


async def test_backup_covers_the_new_tables_and_blobs(client, editor, on, obj, tmp_path):
    """The backup is pg_dump of the whole database plus every blob under the storage root
    (app/backup.py). So: every new table is in the ORM metadata pg_dump sees, and the photo
    original lands under a key `pin_blobs` hard-links."""
    from app import backup

    for table in (
        "object_visits",
        "object_visit_revisions",
        "object_visit_attachments",
        "object_refs",
        "visit_lists",
        "object_visit_deliveries",
        "object_visit_delivery_log",
        "object_visit_seq",
    ):
        assert table in Base.metadata.tables
    assert "filing_folder" in Base.metadata.tables["objects"].columns

    await login(client, editor)
    vid, att = new_id("ov"), new_id("ova")
    data = jpeg()
    await put(client, vid, visit_doc(vid, obj, photos=[{"id": att}]), None)
    await upload(client, vid, att, data)
    pinned = tmp_path / "pinned"
    backup.pin_blobs(pinned)
    copies = [p for p in pinned.rglob("*") if p.is_file()]
    assert any(p.read_bytes() == data and "object-visits" in p.parts for p in copies)


async def test_deployment_config_row_untouched_by_reads(client, editor, on, db_session):
    """Reading the module never writes the config row (the catalogue is a pure read)."""
    await login(client, editor)
    before = (await db_session.execute(select(DeploymentConfig.config_json))).scalar_one()
    await client.get("/api/object-visits/catalogue")
    db_session.expire_all()
    assert (await db_session.execute(select(DeploymentConfig.config_json))).scalar_one() == before


# --- filing folders on the existing object doors ----------------------------------------------


async def test_object_upsert_writes_folder_and_refs_only_when_sent(client, admin_login, db_session):
    await admin_login(client)
    oid = str(uuid.uuid4())
    body = {"name": "Forsthaus", "address": "Allmend 88"}
    r = await client.put(
        f"/api/objects/{oid}",
        json={**body, "filing_folder": "Allmend 88 - Forsthaus", "refs": [{"source": "fwo-schlue", "id": "u-1"}]},
    )
    assert r.status_code == 200 and r.json()["filing_folder"] == "Allmend 88 - Forsthaus"
    # the admin's object mask knows neither field — a save from it must not clear them
    r = await client.put(f"/api/objects/{oid}", json={**body, "name": "Forsthaus Allmend"})
    assert r.json()["filing_folder"] == "Allmend 88 - Forsthaus"
    refs = (await db_session.execute(select(ObjectRef).where(ObjectRef.object_id == uuid.UUID(oid)))).scalars().all()
    assert [(x.source, x.external_id) for x in refs] == [("fwo-schlue", "u-1")]


def test_manifest_entry_accepts_folder_and_refs():
    from app.admin_objects import ObjectEntry

    entry = ObjectEntry(
        key="forsthaus", name="Forsthaus", folder="Allmend 88 - Forsthaus", refs=[{"source": "fwo", "id": "x"}]
    )
    assert entry.folder == "Allmend 88 - Forsthaus" and entry.refs[0].id == "x"
    assert ObjectEntry(key="alt", name="Alt").refs == []  # an old manifest still parses
    with pytest.raises(ValueError):
        ObjectEntry(key="bad", name="Bad", refs=[{"source": "Not Valid", "id": "x"}])


async def test_the_sharepoint_pull_records_the_folder(db_session, monkeypatch):
    from app import sharepoint_sync
    from app.admin_objects import folder_identity

    async def _no_geocode(_address):
        return None

    monkeypatch.setattr(sharepoint_sync, "_coordinates_for", _no_geocode)
    folder = "Hauptstrasse 24 - Gemeindeverwaltung"
    obj = await sharepoint_sync._object_for(db_session, folder_identity(folder), folder)
    assert obj.filing_folder == folder and obj.name == "Gemeindeverwaltung"
    obj.filing_folder = None
    again = await sharepoint_sync._object_for(db_session, folder_identity(folder), folder)
    assert again.filing_folder == folder  # filled in where empty, nothing else touched


def test_folder_derivation():
    from app.object_visits import folder_from_source, object_folder

    assert (
        folder_from_source("OneDrive: Einsatzpläne/Allmend 88 - Forsthaus", "Forsthaus", "Allmend 88")
        == "Allmend 88 - Forsthaus"
    )
    assert folder_from_source("SchlüHü hub: Einsatzplaene/Im Buech 10 - Hof", "Hof", None) == "Im Buech 10 - Hof"
    assert folder_from_source("SharePoint", "Hof", "Im Buech 10") == "Im Buech 10 - Hof"
    assert folder_from_source("SharePoint", "Grosspläne", None) == "Grosspläne"
    assert folder_from_source("von Hand", "X", "Y") is None
    o = ObjectSite(id=uuid.uuid4(), name="Werkhof", address="Werkweg 1")
    assert object_folder(o) == "Werkweg 1 - Werkhof"
    o.filing_folder = "Eigener Ordner"
    assert object_folder(o) == "Eigener Ordner"


# --- review fixes (03.10.2026) ---------------------------------------------------------------------


async def test_a_report_with_page_long_values_renders(client, editor, on, obj):
    """Regression: a checklist/proposal row taller than a page raised ReportLab's LayoutError —
    report.pdf answered 500 and the delivery retried it forever."""
    import copy

    await login(client, editor)
    vid = new_id("ov")
    tpl = copy.deepcopy(TEMPLATE)
    tpl["phases"][0]["title"] = "Abschnitt " * 400
    tpl["phases"][0]["items"][0]["text"] = "Sehr langer Punkt " * 300
    tpl["phases"][0]["items"].append({"id": "frei", "text": "Freitext", "input": "text"})
    doc = visit_doc(
        vid,
        obj,
        checklist=tpl,
        answers={
            "frei": {"v": "Zeile\n" * 333},
            "oeffnen": {"v": "defect", "note": "n" * 2000},
            "zugaenglich": {"v": "ok", "note": "wort " * 400},
        },
        notes="Bemerkung " * 2000,
        proposals=[
            {
                "id": "ovp1234567",
                "field": "owner_contact",
                "label": "L" * 120,
                "current": "alt\n" * 500,
                "proposed": "neu" * 666,
                "reason": "weil " * 400,
            }
        ],
    )
    assert (await put(client, vid, doc, None)).status_code == 200
    r = await client.get(f"/api/object-visits/{vid}/report.pdf")
    assert r.status_code == 200 and r.content.startswith(b"%PDF")


def test_the_plain_fallback_renders_too():
    from app.object_visit_report import _render

    doc = visit_doc(
        "ov1234567-abcd",
        ObjectSite(id=uuid.uuid4(), name="Objekt", address="Weg 1"),
        answers={"oeffnen": {"v": "defect", "note": "klemmt"}},
        proposals=[{"id": "ovp1234567", "field": "f", "proposed": "neu"}],
        photos=[{"id": "ova1234567", "caption": "Bild"}],
    )
    pdf = _render(doc, 1, None, "S", "u", "C", {"ova1234567": jpeg()}, plain=True)
    assert pdf.startswith(b"%PDF")


async def test_export_skips_a_visit_that_cannot_render(client, editor, on, obj, admin_login, monkeypatch):
    import io
    import zipfile

    from app import object_visits as ov_mod

    await login(client, editor)
    good, bad = new_id("ov"), new_id("ov")
    await put(client, good, visit_doc(good, obj), None)
    await put(client, bad, visit_doc(bad, obj), None)
    await client.post("/api/auth/logout")
    await admin_login(client)
    real = ov_mod.render_report

    async def flaky(db, visit, revision=None, **kw):
        if visit.id == bad:
            raise ValueError("kaputt")
        return await real(db, visit, revision, **kw)

    monkeypatch.setattr(ov_mod, "render_report", flaky)
    z = await client.get("/api/admin/object-visits/export.zip")
    assert z.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
    assert any(n.endswith(f"({bad[-4:]})/FEHLER.txt") for n in names)
    assert any(n.endswith(f"({good[-4:]})/Objektbesuch.pdf") for n in names)


async def test_a_visit_whose_object_was_deleted_still_saves(client, editor, on, db_session):
    """Regression: the visit kept pointing at a deleted object id → every later save was an FK
    violation (500) on Postgres."""
    from app.models import ObjectVisit

    gone = await make_object(db_session, name="Abgerissen", address="Weg 9")
    await login(client, editor)
    vid = new_id("ov")
    doc = visit_doc(vid, gone)
    assert (await put(client, vid, doc, None)).status_code == 200
    await db_session.delete(await db_session.get(ObjectSite, gone.id))
    await db_session.commit()
    r = await put(client, vid, {**doc, "notes": "nachgetragen"}, 1)
    assert r.status_code == 200, r.text
    db_session.expire_all()
    row = await db_session.get(ObjectVisit, vid)
    assert row.object_id is None and row.doc["object"]["name"] == "Abgerissen"
    # a NEW visit for a missing object is still refused
    vid2 = new_id("ov")
    assert (await put(client, vid2, visit_doc(vid2, gone), None)).status_code == 422


async def test_a_merge_moves_visits_and_refs_to_the_survivor(
    client, editor, on, db_session, session_factory, monkeypatch
):
    import unicodedata

    from app import admin_objects
    from app.admin_objects import object_id_for_key
    from app.models import ObjectVisit

    monkeypatch.setattr(admin_objects, "async_session_maker", session_factory)
    nfc = "Kindergarten Hüsli"
    nfd = unicodedata.normalize("NFD", nfc)
    survivor = ObjectSite(id=object_id_for_key(nfc), name=nfc)
    loser = ObjectSite(id=object_id_for_key(nfd), name=nfd, filing_folder="Weg 1 - Kindergarten Hüsli")
    db_session.add_all([survivor, loser])
    await db_session.flush()
    db_session.add(ObjectRef(object_id=loser.id, source="fwo", external_id="kg"))
    await db_session.commit()
    await login(client, editor)
    vid = new_id("ov")
    first = visit_doc(vid, loser)
    survivor_id = survivor.id
    await put(client, vid, first, None)

    assert await admin_objects._merge_duplicates(apply=True) == 0
    db_session.expire_all()
    assert (await db_session.get(ObjectVisit, vid)).object_id == survivor_id
    ref = (await db_session.execute(select(ObjectRef).where(ObjectRef.external_id == "kg"))).scalar_one()
    assert ref.object_id == survivor_id
    assert (await db_session.get(ObjectSite, survivor_id)).filing_folder == "Weg 1 - Kindergarten Hüsli"
    # the device still holds the old object id in its document — the save keeps the moved link
    r = await put(client, vid, {**first, "notes": "danach"}, 1)
    assert r.status_code == 200, r.text
    db_session.expire_all()
    assert (await db_session.get(ObjectVisit, vid)).object_id == survivor_id


async def test_removing_an_object_keeps_the_visit_and_drops_the_refs(
    client, editor, on, db_session, session_factory, monkeypatch
):
    from app import admin_objects
    from app.models import ObjectVisit

    monkeypatch.setattr(admin_objects, "async_session_maker", session_factory)
    leer = await make_object(db_session, name="Grosspläne", address=None)
    db_session.add(ObjectRef(object_id=leer.id, source="fwo", external_id="gp"))
    await db_session.commit()
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, visit_doc(vid, leer), None)
    await admin_objects._remove_empty(apply=True, names=["Grosspläne"])
    db_session.expire_all()
    visit = await db_session.get(ObjectVisit, vid)
    assert visit is not None and visit.object_id is None
    assert (await db_session.execute(select(ObjectRef).where(ObjectRef.external_id == "gp"))).first() is None


@pytest.mark.parametrize("bad", ["a\x00b", "\ud800"])
async def test_nul_and_lone_surrogates_are_refused(client, editor, on, obj, db_session, bad):
    """Postgres refuses both in text/jsonb (a 500); SQLite does not — refused with 422 up front."""
    await login(client, editor)
    vid = new_id("ov")
    import json as _json

    for doc in (
        visit_doc(vid, obj, notes=bad),
        visit_doc(vid, obj, answers={"zugaenglich": {"v": "ok", "note": bad}}),
        visit_doc(vid, obj, proposals=[{"id": "ovp1234567", "field": "f", "proposed": bad}]),
        {**visit_doc(vid, obj), "extra": {bad: 1}},
    ):
        body = _json.dumps({"opId": new_id("ovo"), "baseRevision": None, "doc": doc})
        r = await client.put(f"/api/object-visits/{vid}", content=body, headers={"Content-Type": "application/json"})
        assert r.status_code == 422, r.text
    await client.post("/api/auth/logout")
    await set_key(db_session)
    for path, payload in (
        ("/api/integrations/objects/fwo/x1", {"name": bad}),
        ("/api/integrations/objects/fwo/x2", {"name": "ok", "folder": bad}),
        ("/api/integrations/visit-lists/l1", {"title": bad, "objects": []}),
        ("/api/integrations/visit-lists/l2", {"title": "t", "note": bad, "objects": []}),
    ):
        r = await client.put(
            path, content=_json.dumps(payload), headers={**bearer(), "Content-Type": "application/json"}
        )
        assert r.status_code == 422, (path, r.text)
    assert (
        await client.put("/api/integrations/objects/fwo/a%00b", json={"name": "x"}, headers=bearer())
    ).status_code == 422


async def test_the_pull_refreshes_the_folder_of_its_own_objects(db_session, monkeypatch):
    """Regression: the migration backfilled «address - name» from the CURRENT row, which is wrong
    for a renamed object — the pull now restates the folder for every folder it lists."""
    from app import sharepoint_sync
    from app.admin_objects import folder_identity

    async def _no_geocode(_address):
        return None

    monkeypatch.setattr(sharepoint_sync, "_coordinates_for", _no_geocode)
    folder = "Hauptstrasse 24 - Gemeindeverwaltung"
    obj = await sharepoint_sync._object_for(db_session, folder_identity(folder), folder)
    obj.name = "Gemeindehaus (umbenannt)"
    obj.filing_folder = "Hauptstrasse 24 - Gemeindehaus (umbenannt)"  # what the backfill derived
    await db_session.commit()

    from tests.sharepoint_fake import FakeTenant, source
    from tests.test_sharepoint_sync import configure

    tenant = FakeTenant({f"{folder}/Modul 1.pdf": b"%PDF-1.4 plan"}, root_path="kp-data")
    await configure(db_session, sources=[source("plans")])
    await sharepoint_sync.sync_sharepoint(db_session, transport=tenant.transport)
    await sharepoint_sync.sync_sharepoint(db_session, transport=tenant.transport)  # unchanged files too
    await db_session.refresh(obj)
    assert obj.filing_folder == folder


async def test_station_bbox_ignores_plan_less_integration_objects(db_session):
    from app.reference_buildings import station_bbox

    await make_object(db_session, name="A", lat=47.50, lng=7.55)
    await make_object(db_session, name="B", lat=47.52, lng=7.57)
    await make_object(db_session, name="Box", lat=7.55, lng=47.50, source_note="Integration: fwo")  # swapped
    box = await station_bbox(db_session)
    assert box is not None and box[0] > 47 and box[2] < 48 and box[3] < 8


def test_report_composes_decomposed_umlauts_and_counts_in_german():
    """A Mac-named folder arrives decomposed; the PDF must not draw «Mu■hlematt» (staging 03.10.2026)."""
    import unicodedata

    from app.object_visit_report import _esc, _nfc

    decomposed = unicodedata.normalize("NFD", "Mühlemattstrasse 50")
    assert decomposed != "Mühlemattstrasse 50"
    assert _nfc(decomposed) == "Mühlemattstrasse 50"
    assert _esc(decomposed) == "Mühlemattstrasse 50"


# --- round 2 (owner feedback, 03.10.2026) -----------------------------------------------------------


async def test_lists_carry_prior_completions(client, editor, on, obj, db_session):
    await set_key(db_session)
    db_session.add(ObjectRef(object_id=obj.id, source="fwo", external_id="gv"))
    await db_session.commit()
    body = {
        "title": "Tour A1",
        "objects": [
            {
                "source": "fwo",
                "id": "gv",
                "done": {"at": "2025-10-14", "by": "Frei Nina", "source": "SchlüHü", "note": "ok"},
            },
            {"source": "fwo", "id": "später", "done": {"at": "2025-10-15"}},
        ],
    }
    r = await client.put("/api/integrations/visit-lists/fwo-admin:2025/A1", json=body, headers=bearer())
    assert r.status_code == 200, r.text
    done = {"at": "2025-10-14", "by": "Frei Nina", "source": "SchlüHü", "note": "ok"}
    assert r.json()["done"] == {str(obj.id): done}
    await login(client, editor)
    lst = (await client.get("/api/object-visits/catalogue")).json()["lists"][0]
    assert lst["done"] == {str(obj.id): done} and lst["unresolved"] == [{"source": "fwo", "id": "später"}]
    # the unresolved stop's completion appears once its object is known
    await client.post("/api/auth/logout")
    r = await client.put("/api/integrations/objects/fwo/später", json={"name": "Neu"}, headers=bearer())
    later = r.json()["objectId"]
    await login(client, editor)
    lst = (await client.get("/api/object-visits/catalogue")).json()["lists"][0]
    assert lst["done"][later] == {"at": "2025-10-15"}


@pytest.mark.parametrize(
    "done",
    [
        {"at": "14.10.2025"},
        {"at": "2025-02-30"},
        {"by": "x"},
        {"at": "2025-10-14", "note": "n" * 501},
        {"at": "2025-10-14", "by": "a\x00b"},
        {"at": "2025-10-14", "who": "x"},
        "2025-10-14",
    ],
)
async def test_prior_completions_are_validated(client, on, db_session, done):
    import json as _json

    await set_key(db_session)
    body = {"title": "T", "objects": [{"source": "fwo", "id": "x", "done": done}]}
    r = await client.put(
        "/api/integrations/visit-lists/l1",
        content=_json.dumps(body),
        headers={**bearer(), "Content-Type": "application/json"},
    )
    assert r.status_code == 422, r.text


async def test_with_is_the_primary_who(client, editor, on, obj, db_session):
    import pypdfium2 as pdfium

    await set_key(db_session)
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, visit_doc(vid, obj, **{"with": ["Frei Nina", "Muster Hans"]}), None)
    assert (await client.get("/api/object-visits")).json()[0]["with"] == ["Frei Nina", "Muster Hans"]
    feed = (await client.get("/api/integrations/object-visits/changes", headers=bearer())).json()
    assert feed["items"][0]["with"] == ["Frei Nina", "Muster Hans"]
    pdf = (await client.get(f"/api/object-visits/{vid}/report.pdf")).content
    text = "".join(page.get_textpage().get_text_range() for page in pdfium.PdfDocument(pdf))
    assert "Frei Nina, Muster Hans" in text and "Konto" in text and "Cmd" in text
    # nobody named → the account stands in for «Von», and there is no separate «Konto» line
    vid2 = new_id("ov")
    await put(client, vid2, visit_doc(vid2, obj, **{"with": []}), None)
    pdf = (await client.get(f"/api/object-visits/{vid2}/report.pdf")).content
    text = "".join(page.get_textpage().get_text_range() for page in pdfium.PdfDocument(pdf))
    assert "Von" in text and "Cmd" in text and "Konto" not in text


async def test_organizer_removes_a_ref_and_its_own_empty_object(client, editor, on, obj, db_session):
    await set_key(db_session)
    obj_id = obj.id
    r = await client.put("/api/integrations/objects/fwo/box1", json={"name": "Box"}, headers=bearer())
    box = r.json()["objectId"]
    await client.put(
        "/api/integrations/visit-lists/l1",
        json={"title": "T", "objects": [{"source": "fwo", "id": "box1"}]},
        headers=bearer(),
    )
    r = await client.delete("/api/integrations/objects/fwo/box1", headers=bearer())
    assert r.json() == {"removed": "object"}
    db_session.expire_all()
    assert await db_session.get(ObjectSite, uuid.UUID(box)) is None
    assert (await client.delete("/api/integrations/objects/fwo/box1", headers=bearer())).json() == {"removed": "none"}
    cat = (await client.get("/api/integrations/object-visits/catalogue", headers=bearer())).json()
    assert cat["lists"][0]["unresolved"] == [{"source": "fwo", "id": "box1"}]

    # a station object (not the organizer's) keeps its row — only the ref goes
    db_session.add(ObjectRef(object_id=obj_id, source="fwo", external_id="gv"))
    await db_session.commit()
    assert (await client.delete("/api/integrations/objects/fwo/gv", headers=bearer())).json() == {"removed": "ref"}
    assert await db_session.get(ObjectSite, obj_id) is not None

    # the organizer's object stays while a visit stands on it, or another ref names it
    r = await client.put("/api/integrations/objects/fwo/box2", json={"name": "Box 2"}, headers=bearer())
    box2 = uuid.UUID(r.json()["objectId"])
    await client.put("/api/integrations/objects/firegis/g2", json={"name": "Box 2", "folder": None}, headers=bearer())
    db_session.add(ObjectRef(object_id=box2, source="other", external_id="o2"))
    await db_session.commit()
    assert (await client.delete("/api/integrations/objects/fwo/box2", headers=bearer())).json() == {"removed": "ref"}
    r = await client.put("/api/integrations/objects/fwo/box3", json={"name": "Box 3"}, headers=bearer())
    box3 = await db_session.get(ObjectSite, uuid.UUID(r.json()["objectId"]))
    box3_id = box3.id
    first = visit_doc(new_id("ov"), box3)
    await db_session.refresh(editor)
    await login(client, editor)
    await put(client, first["id"], first, None)
    await client.post("/api/auth/logout")
    assert (await client.delete("/api/integrations/objects/fwo/box3", headers=bearer())).json() == {"removed": "ref"}
    db_session.expire_all()
    assert await db_session.get(ObjectSite, box3_id) is not None
    # a slash in the id travels, and the key is required
    assert (await client.delete("/api/integrations/objects/fwo/a%2Fb", headers=bearer())).json() == {"removed": "none"}
    assert (await client.delete("/api/integrations/objects/fwo/a")).status_code == 401


async def test_organizer_reads_an_objects_plans(client, editor, on, db_session):
    from app.models import PlanRevision

    await set_key(db_session)
    obj = await make_object(db_session, name="Schulhaus", address="Schulweg 1")
    storage_mod.put_bytes("plans/s/modul2-v2.pdf", b"%PDF-1.4 v2")
    storage_mod.put_bytes("plans/s/modul2-v1.pdf", b"%PDF-1.4 v1")
    ds_id = f"plan:{obj.id}:modul2"
    db_session.add(
        ReferenceDataset(
            id=ds_id,
            object_id=obj.id,
            module="modul2",
            kind="pdf",
            title="Schulhaus – Umgebung",
            storage_key="plans/s/modul2-v2.pdf",
            content_type="application/pdf",
            size_bytes=11,
            current_version=2,
        )
    )
    await db_session.flush()
    db_session.add(PlanRevision(dataset_id=ds_id, version=1, storage_key="plans/s/modul2-v1.pdf"))
    db_session.add(ObjectRef(object_id=obj.id, source="fwo", external_id="Schulweg 1 - Schulhaus"))
    await db_session.commit()

    base = f"/api/integrations/objects/{obj.id}/plans"
    plans = (await client.get(base, headers=bearer())).json()
    assert plans == [
        {
            "module": "modul2",
            "title": "Schulhaus – Umgebung",
            "revision": 2,
            "contentType": "application/pdf",
            "size": 11,
        }
    ]
    r = await client.get(f"{base}/modul2", headers=bearer())
    assert r.status_code == 200 and r.content == b"%PDF-1.4 v2" and r.headers["x-plan-revision"] == "2"
    assert (await client.get(f"{base}/modul2", params={"revision": 1}, headers=bearer())).content == b"%PDF-1.4 v1"
    assert (await client.get(f"{base}/modul2", params={"revision": 7}, headers=bearer())).status_code == 404
    assert (await client.get(f"{base}/modul9", headers=bearer())).status_code == 404
    assert (await client.get(f"/api/integrations/objects/{uuid.uuid4()}/plans", headers=bearer())).status_code == 404

    found = (await client.get("/api/integrations/objects/by-ref/fwo/Schulweg 1 - Schulhaus", headers=bearer())).json()
    assert found["objectId"] == str(obj.id) and found["hasPlans"] is True
    assert (await client.get("/api/integrations/objects/by-ref/fwo/nope", headers=bearer())).status_code == 404

    # key only: no key, a wrong key, a browser session — all refused
    assert (await client.get(base)).status_code == 401
    assert (await client.get(base, headers={"Authorization": "Bearer x" * 3})).status_code == 401
    await login(client, editor)
    assert (await client.get(f"{base}/modul2")).status_code == 401

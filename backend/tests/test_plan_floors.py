"""Floor packs: one page = one Geschoss, one shared fit per PDF (14.09.2026)."""

from io import BytesIO
from urllib.parse import quote

import pytest
from reportlab.pdfgen.canvas import Canvas
from sqlalchemy import select

from app import storage
from app.models import ObjectSite, PlanAlignment, PlanPageFloor
from app.plan_floors import PlanFloor, default_fit_page, fit_publishable
from app.plans import store_plan


def _pdf(label: str, pages: int) -> bytes:
    buf = BytesIO()
    canvas = Canvas(buf, pagesize=(700, 500))
    for i in range(pages):
        canvas.drawString(50, 50, f"{label} page {i}")
        canvas.showPage()
    canvas.save()
    return buf.getvalue()


PAIRS = [
    {"plan": {"x": 0.2, "y": 0.2}, "lngLat": {"lng": 7.5, "lat": 47.5}, "kind": "gesetzt"},
    {"plan": {"x": 0.8, "y": 0.8}, "lngLat": {"lng": 7.501, "lat": 47.499}, "kind": "gesetzt"},
]
# page 0 = UG, page 1 = EG, page 2 = 1. OG – the fit belongs on page 1
FLOORS = [
    {"page": 0, "index": -1, "name": None, "clip": None, "join": None},
    {"page": 1, "index": 0, "name": "EG / ZWG", "clip": None, "join": None},
    {"page": 2, "index": 1, "name": None, "clip": None, "join": None},
]


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))


async def _seed_pack(db, pages=3):
    obj = ObjectSite(name="Wyss Gartencenter", lat=47.5, lng=7.5)
    db.add(obj)
    await db.flush()
    ds = await store_plan(db, obj, "modul6", _pdf("pack", pages))
    row = (await db.execute(select(PlanAlignment))).scalar_one()
    row.status, row.aspect = "unsupported", 1.4
    await db.commit()
    return obj, ds, row


def test_publishable_only_for_single_page_or_a_floor_page():
    floors = [PlanFloor(0, -1, None), PlanFloor(1, 0, None)]
    assert fit_publishable(1, 0, []) and not fit_publishable(1, 1, [])
    assert not fit_publishable(3, 0, [])  # ordinary multi-page document stays gated
    assert fit_publishable(3, 1, floors) and not fit_publishable(3, 2, floors)
    assert default_fit_page(floors) == 1
    assert default_fit_page([PlanFloor(0, -2, None), PlanFloor(1, -1, None)]) == 1  # no ground → lowest below
    assert default_fit_page([]) is None


async def test_assigning_floors_moves_the_fit_to_ground_and_publishes_one_shared_fit(client, admin_login, db_session):
    obj, ds, row = await _seed_pack(db_session)
    await admin_login(client)
    url = f"/api/admin/plan-alignments/{row.id}"
    assert (await client.get(url)).json()["can_approve"] is False  # multi-page, no floors yet

    response = await client.put(url + "/floors", json={"edit_version": 1, "floors": FLOORS})
    assert response.status_code == 200, response.text
    item = response.json()
    assert item["floors"] == FLOORS and item["page"] == 1 and item["status"] == "pending"
    assert item["can_approve"] is False  # re-queued on the EG page; nothing to approve yet

    # a pending job cannot be hand-approved (the worker may still write it) – let it «finish»
    await db_session.refresh(row)
    row.status, row.aspect = "unsupported", 1.4  # what the worker leaves after rendering the EG page
    await db_session.commit()
    response = await client.post(url + "/approve", json={"edit_version": item["edit_version"], "pairs": PAIRS})
    assert response.status_code == 200, response.text
    published = (await client.get(f"/api/reference/{quote(ds.id, safe='')}/alignments?v=1")).json()
    assert published["page_count"] == 3 and published["floors"] == FLOORS
    assert [a["page"] for a in published["alignments"]] == [1]  # ONE fit, on the floor-0 page

    # an approved fit is never moved under the admin's feet
    moved = [{**f, "index": f["index"] + 1} for f in FLOORS]  # EG is now page 0
    response = await client.put(url + "/floors", json={"edit_version": item["edit_version"] + 1, "floors": moved})
    assert response.status_code == 409


async def test_floor_list_is_validated_against_the_pdf(client, admin_login, db_session):
    _, _, row = await _seed_pack(db_session)
    await admin_login(client)
    url = f"/api/admin/plan-alignments/{row.id}/floors"
    bad_page = [{"page": 3, "index": 0}]
    dup_index = [{"page": 0, "index": 0}, {"page": 1, "index": 0}]
    same_page_twice = [{"page": 0, "index": 0}, {"page": 0, "index": 1}]
    bad_clip = [{"page": 0, "index": 0, "clip": [0.5, 0.1, 0.2, 0.9]}]
    foreign_fit = {"edit_version": 1, "floors": [{"page": 0, "index": 0}], "fit_page": 2}
    assert (await client.put(url, json={"edit_version": 1, "floors": bad_page})).status_code == 422
    assert (await client.put(url, json={"edit_version": 1, "floors": dup_index})).status_code == 422
    assert (await client.put(url, json={"edit_version": 1, "floors": same_page_twice})).status_code == 422
    assert (await client.put(url, json={"edit_version": 1, "floors": bad_clip})).status_code == 422
    assert (await client.put(url, json=foreign_fit)).status_code == 422
    assert (await client.put(url, json={"edit_version": 7, "floors": [{"page": 0, "index": 0}]})).status_code == 409
    assert (await db_session.execute(select(PlanPageFloor))).scalars().all() == []


async def test_a_same_sized_replacement_keeps_its_floors_and_fit_page(client, admin_login, db_session):
    obj, ds, row = await _seed_pack(db_session)
    await admin_login(client)
    assert (
        await client.put(f"/api/admin/plan-alignments/{row.id}/floors", json={"edit_version": 1, "floors": FLOORS})
    ).status_code == 200

    await db_session.refresh(row)  # the PUT ran in the app's own session – see its moved fit page, not the cached row
    await store_plan(db_session, obj, "modul6", _pdf("re-export", 3))
    await db_session.commit()
    new_row = (await db_session.execute(select(PlanAlignment).where(PlanAlignment.plan_version == 2))).scalar_one()
    assert new_row.page == 1 and new_row.status == "pending"
    v2 = (await client.get(f"/api/reference/{quote(ds.id, safe='')}/alignments?v=2")).json()
    assert v2["floors"] == FLOORS

    await store_plan(db_session, obj, "modul6", _pdf("different building", 4))
    await db_session.commit()
    v3 = (await client.get(f"/api/reference/{quote(ds.id, safe='')}/alignments?v=3")).json()
    assert v3["floors"] == [] and v3["page_count"] == 4
    # v1 keeps what an incident may have pinned
    assert (await client.get(f"/api/reference/{quote(ds.id, safe='')}/alignments?v=1")).json()["floors"] == FLOORS


async def test_the_preview_can_show_any_page_of_the_pack(client, admin_login, db_session):
    _, _, row = await _seed_pack(db_session)
    await admin_login(client)
    url = f"/api/admin/plan-alignments/{row.id}/preview?thumbnail=true"
    first, third = await client.get(url), await client.get(url + "&page=2")
    assert first.status_code == 200 and third.status_code == 200
    assert first.content != third.content  # a different page, not the cached fit page
    assert (await client.get(url + "&page=9")).status_code == 422


async def test_regions_of_one_sheet_are_floors_too(client, admin_login, db_session):
    """An A0 with four drawings: four floors on page 0, each a clip rectangle, joined floor to floor."""
    _, ds, row = await _seed_pack(db_session, pages=1)
    await admin_login(client)
    regions = [
        {
            "page": 0,
            "index": 2,
            "clip": [0.02, 0.02, 0.35, 0.45],
            "join": {"to": 1, "at": [0.05, 0.4], "there": [0.05, 0.9]},
        },
        {
            "page": 0,
            "index": 1,
            "clip": [0.02, 0.5, 0.35, 0.95],
            "join": {"to": 0, "at": [0.05, 0.9], "there": [0.41, 0.45]},
        },
        {"page": 0, "index": 0, "name": "EG / ZWG", "clip": [0.38, 0.02, 0.98, 0.5]},
        {
            "page": 0,
            "index": -1,
            "clip": [0.38, 0.55, 0.7, 0.95],
            "join": {"to": 0, "at": [0.41, 0.9], "there": [0.41, 0.45]},
        },
    ]
    response = await client.put(
        f"/api/admin/plan-alignments/{row.id}/floors", json={"edit_version": 1, "floors": regions}
    )
    assert response.status_code == 200, response.text
    assert response.json()["page"] == 0 and len(response.json()["floors"]) == 4
    published = (await client.get(f"/api/reference/{quote(ds.id, safe='')}/alignments?v=1")).json()
    eg = next(f for f in published["floors"] if f["index"] == 0)
    assert eg["clip"] == [0.38, 0.02, 0.98, 0.5] and eg["join"] is None and eg["name"] == "EG / ZWG"
    ug = next(f for f in published["floors"] if f["index"] == -1)
    assert ug["join"] == {"to": 0, "at": [0.41, 0.9], "there": [0.41, 0.45]}
    listed = (await client.get("/api/admin/plan-alignments")).json()["items"]
    listed_item = next(item for item in listed if item["id"] == row.id)
    assert listed_item["floors"] == published["floors"]
    # a join must point at another existing floor
    bad = [
        {"page": 0, "index": 0, "clip": [0.1, 0.1, 0.5, 0.5], "join": {"to": 7, "at": [0.2, 0.2], "there": [0.6, 0.6]}}
    ]
    ev = response.json()["edit_version"]
    assert (
        await client.put(f"/api/admin/plan-alignments/{row.id}/floors", json={"edit_version": ev, "floors": bad})
    ).status_code == 422


async def test_cross_page_join_survives_list_and_detail(client, admin_login, db_session):
    _, _, row = await _seed_pack(db_session)
    await admin_login(client)
    floors = [
        {"page": 0, "index": 0, "clip": [0.1, 0.1, 0.9, 0.9]},
        {"page": 1, "index": 1, "clip": [0.2, 0.2, 0.8, 0.8], "join": {"to": 0, "at": [0.3, 0.3], "there": [0.5, 0.5]}},
    ]
    url = f"/api/admin/plan-alignments/{row.id}"
    response = await client.put(url + "/floors", json={"edit_version": 1, "floors": floors})
    assert response.status_code == 200, response.text
    expected = response.json()["floors"]
    listed = (await client.get("/api/admin/plan-alignments")).json()
    item = next(item for item in listed["items"] if item["id"] == row.id)
    assert item["floors"] == expected
    assert (await client.get(url)).json()["floors"] == expected

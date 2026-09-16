"""Revision identity, publication boundaries and conflict protection for prepared plans."""

from io import BytesIO
from unittest.mock import AsyncMock
from urllib.parse import quote

import pytest
from reportlab.pdfgen.canvas import Canvas
from sqlalchemy import event, select

from app import storage
from app.api.report import resolve_report_assets
from app.models import DeploymentConfig, ObjectSite, PlanAlignment, PlanAlignmentEvent, PlanRevision
from app.plans import store_plan
from app.report_pdf import ReportPayload


def _pdf(label: str, pages: int = 1) -> bytes:
    buf = BytesIO()
    canvas = Canvas(buf, pagesize=(700, 500))
    for i in range(pages):
        canvas.drawString(50, 50, f"{label} page {i}")
        canvas.showPage()
    canvas.save()
    return buf.getvalue()


PDF1 = _pdf("revision one")
PDF2 = _pdf("revision two")
PAIRS = [
    {"plan": {"x": 0.2, "y": 0.2}, "lngLat": {"lng": 7.5, "lat": 47.5}, "kind": "auto"},
    {"plan": {"x": 0.8, "y": 0.8}, "lngLat": {"lng": 7.501, "lat": 47.499}, "kind": "auto"},
]


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))


async def _seed(db):
    obj = ObjectSite(name="Demonstration plan")
    db.add(obj)
    await db.flush()
    ds = await store_plan(db, obj, "modul1", PDF1)
    row = (await db.execute(select(PlanAlignment))).scalar_one()
    row.status, row.pairs, row.aspect = "ready", PAIRS, 1.4
    await db.commit()
    return obj, ds, row


async def test_same_bytes_do_not_create_revision_or_job(db_session):
    obj, ds, row = await _seed(db_session)
    await store_plan(db_session, obj, "modul1", PDF1, title="New metadata")
    await db_session.commit()
    assert ds.current_version == 1
    assert ds.title == "New metadata"
    assert len((await db_session.execute(select(PlanRevision))).scalars().all()) == 1
    assert len((await db_session.execute(select(PlanAlignment))).scalars().all()) == 1
    assert row.status == "ready"


async def test_exact_revision_download_survives_replacement(client, admin_login, db_session):
    obj, ds, _ = await _seed(db_session)
    old_key = ds.storage_key
    await store_plan(db_session, obj, "modul1", PDF2)
    await db_session.commit()
    await admin_login(client)
    url = f"/api/reference/{quote(ds.id, safe='')}"
    assert (await client.get(url, params={"v": 1})).content == PDF1
    assert (await client.get(url, params={"v": 2})).content == PDF2
    assert (await client.get(url, params={"v": 999})).status_code == 404
    assert storage.exists(old_key)
    assert len((await db_session.execute(select(PlanAlignment))).scalars().all()) == 2
    # The report must print the incident's selected original too.
    report = ReportPayload.model_validate(
        {
            "incident": {"title": "T", "id": "i"},
            "generatedAt": "now",
            "planPages": [{"url": url + "?v=1", "label": "M1"}],
        }
    )
    assert (await resolve_report_assets(db_session, report, {}))[url + "?v=1"] == PDF1


async def test_approval_and_undo_are_admin_only_append_history_and_never_write_legacy(
    client, admin_login, db_session, editor
):
    _, ds, row = await _seed(db_session)
    db_session.add(DeploymentConfig(id=1, plan_scales_json={"georefByPlan": {"legacy": {"pairs": PAIRS}}}))
    await db_session.commit()
    url = f"/api/admin/plan-alignments/{row.id}"
    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert (await client.post(url + "/approve", json={"edit_version": 1})).status_code == 401
    await admin_login(client)
    # Publishing a computed fit preserves its automatic provenance.
    adjusted = PAIRS
    response = await client.post(url + "/approve", json={"edit_version": 1, "pairs": adjusted})
    assert response.status_code == 200, response.text
    assert response.json()["edit_version"] == 2
    assert all(p["kind"] == "auto" for p in response.json()["pairs"])
    published = (await client.get(f"/api/reference/{quote(ds.id, safe='')}/alignments?v=1")).json()
    assert published["alignments"][0]["id"] == row.id
    assert (await client.post(url + "/undo", json={"edit_version": 1})).status_code == 409
    response = await client.post(url + "/undo", json={"edit_version": 2})
    assert response.status_code == 200
    assert response.json()["status"] == "needs_review"
    assert (await client.get(f"/api/reference/{quote(ds.id, safe='')}/alignments?v=1")).json()["alignments"] == []
    events = (await db_session.execute(select(PlanAlignmentEvent).order_by(PlanAlignmentEvent.id))).scalars().all()
    assert [e.action for e in events] == ["approve", "withdraw"]
    assert events[0].snapshot["after"]["status"] == "approved"
    legacy = await db_session.get(DeploymentConfig, 1)
    assert legacy.plan_scales_json == {"georefByPlan": {"legacy": {"pairs": PAIRS}}}


async def test_replacement_cannot_inherit_or_publish_old_approval(client, admin_login, db_session):
    obj, ds, row = await _seed(db_session)
    await admin_login(client)
    url = f"/api/admin/plan-alignments/{row.id}/approve"
    await store_plan(db_session, obj, "modul1", PDF2)
    await db_session.commit()
    assert (await client.post(url, json={"edit_version": 1})).status_code == 409
    current = (await client.get(f"/api/reference/{quote(ds.id, safe='')}/alignments")).json()
    assert current["plan_version"] == 2 and current["alignments"] == []


async def test_generic_replacement_uses_revision_path(client, admin_login, db_session):
    _, ds, _ = await _seed(db_session)
    await admin_login(client)
    url = f"/api/reference/{quote(ds.id, safe='')}"
    response = await client.put(url, files={"file": ("module.pdf", PDF2, "application/pdf")})
    assert response.status_code == 200, response.text
    assert response.json()["current_version"] == 2
    assert (await client.get(url + "?v=1")).content == PDF1
    response = await client.put(url, files={"file": ("module.pdf", PDF2, "application/pdf")})
    assert response.json()["current_version"] == 2


async def test_stale_review_cannot_approve_new_computation(client, admin_login, db_session):
    _, _, row = await _seed(db_session)
    row.edit_version = 5
    await db_session.commit()
    await admin_login(client)
    assert (
        await client.post(f"/api/admin/plan-alignments/{row.id}/approve", json={"edit_version": 1})
    ).status_code == 409
    assert not (await db_session.execute(select(PlanAlignmentEvent))).scalars().all()


async def test_legacy_revision_is_pinned_before_first_replacement(db_session):
    from app.models import ReferenceDataset

    obj = ObjectSite(name="Existing installation")
    db_session.add(obj)
    await db_session.flush()
    key = storage.new_key("plans", ".pdf")
    storage.put_bytes(key, PDF1)
    ds = ReferenceDataset(
        id=f"plan:{obj.id}:modul1", object_id=obj.id, module="modul1", kind="pdf", storage_key=key, current_version=8
    )
    db_session.add(ds)
    await db_session.commit()
    await store_plan(db_session, obj, "modul1", PDF2)
    await db_session.commit()
    original = await db_session.get(PlanRevision, (ds.id, 8))
    assert storage.get_bytes(original.storage_key) == PDF1
    assert ds.current_version == 9


async def test_manual_repair_accepts_three_real_pairs_but_not_three_auto(client, admin_login, db_session):
    _, _, row = await _seed(db_session)
    row.status = "no_match"
    await db_session.commit()
    await admin_login(client)
    pairs = [*PAIRS, {"plan": {"x": 0.2, "y": 0.8}, "lngLat": {"lng": 7.5, "lat": 47.499}, "kind": "auto"}]
    url = f"/api/admin/plan-alignments/{row.id}/approve"
    assert (await client.post(url, json={"edit_version": 1, "pairs": pairs})).status_code == 409
    row.status = "ready"
    await db_session.commit()
    assert (await client.post(url, json={"edit_version": 1, "pairs": pairs})).status_code == 422
    row.status = "no_match"
    await db_session.commit()
    manual = [{**p, "kind": "gesetzt"} for p in pairs]
    response = await client.post(url, json={"edit_version": 1, "pairs": manual})
    assert response.status_code == 200, response.text
    assert response.json()["pairs"] == manual


async def test_failed_upload_transaction_keeps_previous_revision_and_discards_job(db_session):
    obj, ds, _ = await _seed(db_session)
    original_key = ds.storage_key
    dataset_id = ds.id
    await store_plan(db_session, obj, "modul1", PDF2)
    unpublished_key = ds.storage_key
    await db_session.rollback()
    assert storage.get_bytes(original_key) == PDF1
    assert not storage.exists(unpublished_key)
    assert await db_session.get(PlanRevision, (dataset_id, 2)) is None
    assert len((await db_session.execute(select(PlanAlignment))).scalars().all()) == 1


async def test_multipage_revision_cannot_publish_or_leak_a_fit(client, admin_login, db_session):
    obj, ds, _ = await _seed(db_session)
    await store_plan(db_session, obj, "modul1", _pdf("multipage", 2))
    row = (await db_session.execute(select(PlanAlignment).where(PlanAlignment.plan_version == 2))).scalar_one()
    row.status, row.pairs, row.aspect = "ready", PAIRS, 1.4
    await db_session.commit()
    await admin_login(client)
    url = f"/api/admin/plan-alignments/{row.id}"
    detail = (await client.get(url)).json()
    assert detail["page_count"] == 2 and detail["can_approve"] is False
    response = await client.post(url + "/approve", json={"edit_version": 1})
    assert response.status_code == 422 and "einseitige" in response.json()["detail"]
    manual = [{**pair, "kind": "gesetzt"} for pair in PAIRS]
    assert (await client.post(url + "/approve", json={"edit_version": 1, "pairs": manual})).status_code == 422
    # Even historical/incorrectly seeded approval rows cannot bypass the PDF geometry gate.
    row.status = "approved"
    await db_session.commit()
    response = await client.get(f"/api/reference/{quote(ds.id, safe='')}/alignments?v=2")
    assert response.status_code == 200 and response.json()["alignments"] == []


async def test_queue_is_a_fixed_number_of_queries_and_opens_no_pdf(db_session, engine, monkeypatch):
    from app.api import plan_alignments

    obj, ds, old = await _seed(db_session)
    await store_plan(db_session, obj, "modul1", _pdf("multipage", 2))
    current = (await db_session.execute(select(PlanAlignment).where(PlanAlignment.plan_version == 2))).scalar_one()
    current.status, current.pairs, current.aspect = "ready", PAIRS, 1.4
    second_page = PlanAlignment(dataset_id=ds.id, plan_version=2, page=1, status="ready", pairs=PAIRS, aspect=1.4)
    db_session.add(second_page)
    await db_session.commit()

    count_pages = AsyncMock(wraps=plan_alignments.revision_page_count)
    monkeypatch.setattr(plan_alignments, "revision_page_count", count_pages)
    monkeypatch.setattr(plan_alignments, "alignment_capability", lambda: {"available": True, "reason": None})
    statements = []

    def record_statement(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record_statement)
    try:
        result = await plan_alignments.list_alignments(None, db_session)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record_statement)

    assert len(statements) == 2  # fixed query count, regardless of queue size: rows + floor packs
    count_pages.assert_not_awaited()  # the list opens no PDF at all – page_count is the detail's job
    items = {item["id"]: item for item in result["items"]}
    assert len(items) == 3
    assert items[old.id]["page_count"] is None and items[old.id]["is_current"] is False
    assert items[current.id]["page_count"] is None and items[current.id]["is_current"] is True
    assert all(item["can_approve"] is False for item in items.values())
    assert all(item["object_name"] == obj.name and item["module"] == "modul1" for item in items.values())
    # Listing and detail have the same contract apart from the two fields the list refuses to grow.
    for row in (old, current, second_page):
        detail = await plan_alignments._item(db_session, row)
        assert "reference_rings" not in items[row.id]
        assert {
            **items[row.id],
            "page_count": detail["page_count"],
            "reference_rings": detail["reference_rings"],
        } == detail


async def test_the_queue_leaves_the_building_outlines_to_the_per_sheet_endpoint(
    client, admin_login, db_session, monkeypatch
):
    """⚠️ The size guard: 453 sheets carrying their `reference_rings` were a 21.5 MB list that the
    Objektpläne page re-polls every 15 s. The rings belong to ONE tile at a time."""
    from app.api import plan_alignments

    _, _, row = await _seed(db_session)
    rings = [[[7.5, 47.5], [7.501, 47.5], [7.501, 47.499], [7.5, 47.5]]]
    row.reference_rings, row.reference_source = rings, "OSM 2026-09-01"
    await db_session.commit()
    await admin_login(client)
    count_pages = AsyncMock(wraps=plan_alignments.revision_page_count)
    monkeypatch.setattr(plan_alignments, "revision_page_count", count_pages)
    monkeypatch.setattr(plan_alignments, "alignment_capability", lambda: {"available": True, "reason": None})

    listed = (await client.get("/api/admin/plan-alignments")).json()["items"][0]
    count_pages.assert_not_awaited()
    assert listed["id"] == row.id and "reference_rings" not in listed
    # the provenance the wall's header reads is small and stays; only the geometry left
    assert listed["reference_source"] == "OSM 2026-09-01"
    assert listed["page_count"] is None and listed["can_approve"] is False

    outline = await client.get(f"/api/admin/plan-alignments/{row.id}/outline")
    assert outline.status_code == 200, outline.text
    assert outline.json() == {
        "reference_rings": rings,
        "reference_source": "OSM 2026-09-01",
        "reference_at": None,
        "pairs": PAIRS,
    }
    count_pages.assert_not_awaited()  # an outline never opens the PDF either

    response = await client.get(f"/api/admin/plan-alignments/{row.id}")
    assert response.status_code == 200, response.text
    detail = response.json()
    assert detail["reference_rings"] == rings  # the detail keeps everything
    assert detail["page_count"] == 1 and detail["can_approve"] is True
    assert {**listed, "page_count": 1, "can_approve": True, "reference_rings": rings} == detail
    count_pages.assert_awaited_once()


async def test_the_marker_diagnosis_rides_along_on_both_the_list_and_the_detail(client, admin_login, db_session):
    """The object table's badge reads it off the LIST row, so it cannot be a detail-only field
    (16.09.2026) – and it must never leak into the approval history, which is about decisions."""
    _, _, row = await _seed(db_session)
    notes = {
        "warnings": [{"code": "corner_missing", "storey": 4, "tag": "§4OG]", "have": "§[4OG", "side": "br", "page": 1}],
        "storeys_found": 5,
        "storeys_written": 0,
        "geo_pairs": 0,
    }
    row.marker_notes = notes
    await db_session.commit()
    await admin_login(client)

    listed = (await client.get("/api/admin/plan-alignments")).json()["items"][0]
    assert listed["marker_notes"] == notes
    assert (await client.get(f"/api/admin/plan-alignments/{row.id}")).json()["marker_notes"] == notes
    # a sheet nobody marked says nothing rather than saying «no problems»
    row.marker_notes = None
    await db_session.commit()
    assert (await client.get(f"/api/admin/plan-alignments/{row.id}")).json()["marker_notes"] is None


async def test_the_outline_of_a_sheet_that_is_not_there_is_a_404(client, admin_login, db_session):
    await _seed(db_session)
    await admin_login(client)
    assert (await client.get("/api/admin/plan-alignments/9999/outline")).status_code == 404


async def test_a_rejection_leaves_the_queue_without_publishing_and_can_be_undone(client, admin_login, db_session):
    obj, ds, row = await _seed(db_session)
    await admin_login(client)
    url = f"/api/admin/plan-alignments/{row.id}"
    response = await client.post(url + "/reject", json={"edit_version": 1})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "rejected"
    assert response.json()["can_approve"] is True  # by hand is still possible
    assert (await client.get(f"/api/reference/{quote(ds.id, safe='')}/alignments?v=1")).json()["alignments"] == []
    assert (await client.post(url + "/reject", json={"edit_version": 2})).status_code == 409
    # the automatic pairs are exactly what was refused; only a manual fit may approve now
    assert (await client.post(url + "/approve", json={"edit_version": 2})).status_code == 409
    response = await client.post(url + "/undo", json={"edit_version": 2})
    assert response.status_code == 200
    assert response.json()["status"] == "needs_review"
    events = (await db_session.execute(select(PlanAlignmentEvent).order_by(PlanAlignmentEvent.id))).scalars().all()
    assert [e.action for e in events] == ["reject", "withdraw"]


async def test_the_preview_thumbnail_is_a_small_jpeg_of_the_same_page(client, admin_login, db_session, monkeypatch):
    from PIL import Image

    obj, ds, row = await _seed(db_session)
    await admin_login(client)
    url = f"/api/admin/plan-alignments/{row.id}/preview"
    full = await client.get(url)
    small = await client.get(url + "?thumbnail=true")
    assert full.headers["content-type"] == "image/png"
    assert small.headers["content-type"] == "image/jpeg"
    with Image.open(BytesIO(small.content)) as image:
        assert max(image.size) == 560
        assert abs(image.width / image.height - 700 / 500) < 0.01
    assert len(small.content) < len(full.content)
    # the second thumbnail comes from storage, not from PDFium
    from app import plan_alignment_compute

    monkeypatch.setattr(
        plan_alignment_compute, "render_page", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("rendered again"))
    )
    again = await client.get(url + "?thumbnail=true")
    assert again.content == small.content


async def test_an_approval_can_be_corrected_by_hand_and_stays_published(client, admin_login, db_session):
    obj, ds, row = await _seed(db_session)
    await admin_login(client)
    url = f"/api/admin/plan-alignments/{row.id}"
    assert (await client.post(url + "/approve", json={"edit_version": 1})).status_code == 200
    # the automatic pairs cannot be re-approved over an approval; corrected manual ones can
    assert (await client.post(url + "/approve", json={"edit_version": 2})).status_code == 409
    manual = [{**p, "kind": "gesetzt"} for p in PAIRS]
    response = await client.post(url + "/approve", json={"edit_version": 2, "pairs": manual})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "approved"
    published = (await client.get(f"/api/reference/{quote(ds.id, safe='')}/alignments?v=1")).json()["alignments"]
    assert [p["kind"] for p in published[0]["pairs"]] == ["gesetzt", "gesetzt"]

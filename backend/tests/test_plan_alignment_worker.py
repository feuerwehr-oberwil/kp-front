"""Exact-page preparation and durable claims, without network or operational plan data."""

import hashlib
import io
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from reportlab.pdfgen import canvas
from sqlalchemy import select, update

from app import plan_alignment_compute as compute
from app import plan_alignment_worker as worker
from app import storage
from app.models import ObjectSite, PlanAlignment, PlanRevision, ReferenceDataset


@pytest.fixture
def pdf_store(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))
    buf = io.BytesIO()
    doc = canvas.Canvas(buf, pagesize=(420, 300))
    doc.drawString(20, 35, "Inset 1:250   Main drawing 1:1000")
    doc.showPage()
    doc.drawString(20, 35, "1:500")
    doc.showPage()
    doc.save()
    raw = buf.getvalue()
    storage.put_bytes("plans/exact.pdf", raw)
    return raw


@pytest.fixture
def single_page_store(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))
    buf = io.BytesIO()
    doc = canvas.Canvas(buf, pagesize=(420, 300))
    doc.drawString(20, 35, "1:1000")
    doc.showPage()
    doc.save()
    raw = buf.getvalue()
    storage.put_bytes("plans/exact.pdf", raw)
    return raw


def test_render_reads_exact_page_scale_and_closes_pdfium(pdf_store):
    digest = hashlib.sha256(pdf_store).hexdigest()
    first = compute.render_page("plans/exact.pdf", 0, digest)
    second = compute.render_page("plans/exact.pdf", 1, digest)
    assert first.page_count == second.page_count == 2
    assert first.aspect == pytest.approx(1.4)
    assert first.printed_scale == pytest.approx(1000 * 300 / 72 * 0.0254)
    assert second.printed_scale == pytest.approx(first.printed_scale / 2)
    assert first.png.startswith(b"\x89PNG")
    assert max(first.width, first.height) == compute.RENDER_SIDE
    assert compute.render_preview("plans/exact.pdf", 1) == second.png
    with pytest.raises(ValueError, match="revision_digest_mismatch"):
        compute.render_page("plans/exact.pdf", 0, "0" * 64)
    with pytest.raises(ValueError, match="page_out_of_range"):
        compute.render_page("plans/exact.pdf", 2)


def test_scale_fallback_cannot_borrow_another_object_module_or_page():
    scale = {"mPerU": 70, "ar": 1.4}
    config = {"default": scale, "byPlan": {"modul2": scale, "object:a:plan:modul2": scale}}
    assert compute.calibrated_scale(config, "a", "modul2", 0, 1.4) == 70
    assert compute.calibrated_scale(config, "b", "modul2", 0, 1.4) is None
    assert compute.calibrated_scale(config, "a", "modul1", 0, 1.4) is None
    assert compute.calibrated_scale(config, "a", "modul2", 1, 1.4) is None
    assert compute.calibrated_scale(config, "a", "modul2", 0, 0.7) is None


@pytest.fixture
def matcher(monkeypatch):
    georef_suggest = pytest.importorskip("app.georef_suggest")
    np = pytest.importorskip("numpy")
    fake = SimpleNamespace(
        **{
            name: getattr(georef_suggest, name)
            for name in (
                "TUNED_M_PER_PX",
                "reference_radius_m",
                "rings_from_overpass",
                "local_to_wgs84",
                "COVERAGE_CONFIDENT",
                "COVERAGE_FLOOR",
                "suggestion_pairs",
            )
        }
    )
    fake.suggest = lambda image, m_per_px, rings, template: georef_suggest.Suggestion(
        np.eye(2) * m_per_px,
        np.array([0.0, 0.0]),
        2.0,
        0.9,
        0.0,
    )
    monkeypatch.setattr(compute, "_load_matcher", lambda: fake)
    monkeypatch.setattr(compute.overpass, "mirrors", lambda: ["test-only"])

    async def osm(lng, lat, radius):
        return {
            "elements": [
                {
                    "type": "way",
                    "geometry": [
                        {"lon": 7.0, "lat": 47.0},
                        {"lon": 7.001, "lat": 47.0},
                        {"lon": 7.001, "lat": 47.001},
                        {"lon": 7.0, "lat": 47.0},
                    ],
                }
            ]
        }

    monkeypatch.setattr(compute, "_osm_around", osm)
    return fake


async def test_match_records_actual_pairs_and_wgs84_reference_without_publishing(single_page_store, matcher):
    suggest = matcher.suggest
    page = compute.render_page("plans/exact.pdf", 0)
    result = await compute.compute_alignment(page, "modul2", 7.0, 47.0, None)
    assert result.status == "ready"
    assert len(result.pairs) == 2
    assert all(p["kind"] == "auto" for p in result.pairs)
    assert result.reference_rings[0][0] == pytest.approx({"lng": 7.0, "lat": 47.0})
    assert result.reference_at is not None
    assert result.scale_m_per_u == page.printed_scale
    m1 = await compute.compute_alignment(page, "modul1", 7.0, 47.0, None)
    assert m1.status == "ready"  # the same coverage bar for every template
    matcher.suggest = lambda *args: replace(suggest(*args), coverage=0.6)
    mid = await compute.compute_alignment(page, "modul2", 7.0, 47.0, None)
    assert mid.status == "needs_review"


async def test_no_match_keeps_reference_for_manual_review(single_page_store, matcher):
    suggest = matcher.suggest
    matcher.suggest = lambda *args: replace(suggest(*args), score=2.0, coverage=0.4)  # a good score does not rescue it
    page = compute.render_page("plans/exact.pdf", 0)
    result = await compute.compute_alignment(page, "modul2", 7.0, 47.0, None)
    assert result.status == "no_match"
    assert result.pairs == []
    assert result.reference_rings and result.aspect == page.aspect
    assert result.reference_rings[0][0] == pytest.approx({"lng": 7.0, "lat": 47.0})
    assert result.reason == "low_coverage"


async def test_missing_dependencies_and_unsupported_modules_are_honest(single_page_store, monkeypatch):
    def missing():
        raise ImportError("not installed")

    monkeypatch.setattr(compute, "_load_matcher", missing)
    page = compute.render_page("plans/exact.pdf", 0)
    result = await compute.compute_alignment(page, "modul2", 7.0, 47.0, None)
    assert result.status == "unavailable" and result.reason == "georef_dependencies_missing"
    unsupported = await compute.compute_alignment(page, "modul6", 7.0, 47.0, None)
    assert unsupported.status == "unsupported"
    missing_scale = await compute.compute_alignment(replace(page, printed_scale=None), "modul2", 7.0, 47.0, None)
    assert missing_scale.reason == "printed_scale_missing"


async def seed(db, raw):
    obj = ObjectSite(name="Synthetic test object", lng=7.0, lat=47.0)
    db.add(obj)
    await db.flush()
    ds = ReferenceDataset(
        id=f"plan:{obj.id}:modul2",
        object_id=obj.id,
        module="modul2",
        kind="pdf",
        storage_key="plans/current-must-not-be-read.pdf",
        current_version=2,
    )
    db.add(ds)
    await db.flush()
    db.add(
        PlanRevision(
            dataset_id=ds.id, version=1, storage_key="plans/exact.pdf", content_digest=hashlib.sha256(raw).hexdigest()
        )
    )
    await db.flush()
    job = PlanAlignment(dataset_id=ds.id, plan_version=1, page=0)
    db.add(job)
    await db.commit()
    return job.id


async def test_claim_lease_recovery_rejects_late_result(db_session, pdf_store):
    job_id = await seed(db_session, pdf_store)
    now = datetime.now(UTC)
    first = await worker.claim_job(db_session, now)
    assert first and first.id == job_id
    assert await worker.claim_job(db_session, now + timedelta(seconds=1)) is None
    second = await worker.claim_job(db_session, now + timedelta(seconds=worker.LEASE_SECONDS + 1))
    assert second and second.attempt == first.attempt + 1
    assert not await worker.finish_job(db_session, first, compute.AlignmentResult("ready"))
    assert await worker.finish_job(db_session, second, compute.AlignmentResult("no_match"))
    assert not await worker.finish_job(db_session, second, compute.AlignmentResult("ready"))
    rows = (await db_session.execute(select(PlanAlignment).order_by(PlanAlignment.page))).scalars().all()
    assert [(r.page, r.status) for r in rows] == [(0, "no_match")]


async def test_repeated_crash_stops_after_retry_limit(db_session, pdf_store):
    await seed(db_session, pdf_store)
    now = datetime.now(UTC)
    for attempt in range(worker.MAX_ATTEMPTS):
        claim = await worker.claim_job(db_session, now)
        assert claim and claim.attempt == attempt + 1
        now += timedelta(seconds=worker.LEASE_SECONDS + 1)
    assert await worker.claim_job(db_session, now) is None
    row = (await db_session.execute(select(PlanAlignment))).scalar_one()
    assert row.status == "failed" and row.reason == "worker_retry_limit"


async def test_explicit_retry_cannot_reuse_a_stale_completion_token(db_session, pdf_store):
    await seed(db_session, pdf_store)
    old = await worker.claim_job(db_session)
    assert old
    # Simulate recovery/failure followed by an administrator's explicit retry. Attempts reset,
    # but edit_version remains monotonic, so the old attempt=1 cannot win an ABA race.
    await db_session.execute(
        update(PlanAlignment).values(
            status="pending",
            attempts=0,
            edit_version=PlanAlignment.edit_version + 1,
        )
    )
    current = await worker.claim_job(db_session)
    assert current and current.attempt == old.attempt
    assert current.edit_version != old.edit_version
    assert not await worker.finish_job(db_session, old, compute.AlignmentResult("ready"))
    assert await worker.finish_job(db_session, current, compute.AlignmentResult("no_match"))


async def test_tick_uses_revision_blob_and_persists_frontend_reference_contract(
    session_factory, single_page_store, matcher
):
    async with session_factory() as db:
        await seed(db, single_page_store)
    assert await worker.run_once(session_factory)
    assert not await worker.run_once(session_factory)
    async with session_factory() as db:
        jobs = (await db.execute(select(PlanAlignment).order_by(PlanAlignment.page))).scalars().all()
        assert len(jobs) == 1
        assert all(j.status == "ready" and j.approved_at is None for j in jobs)
        assert all(j.plan_version == 1 for j in jobs)
        from app.api.plan_alignments import _item

        item = await _item(db, jobs[0])
        assert item["reference_rings"][0][0] == pytest.approx({"lng": 7.0, "lat": 47.0})


async def test_multipage_pack_is_not_published_or_expanded_into_misleading_jobs(session_factory, pdf_store):
    async with session_factory() as db:
        await seed(db, pdf_store)
    assert await worker.run_once(session_factory)
    assert not await worker.run_once(session_factory)
    async with session_factory() as db:
        jobs = (await db.execute(select(PlanAlignment))).scalars().all()
        assert len(jobs) == 1
        assert jobs[0].status == "unsupported" and jobs[0].reason == "multi_page_document"
        assert jobs[0].aspect == pytest.approx(1.4)
        assert jobs[0].pairs == []

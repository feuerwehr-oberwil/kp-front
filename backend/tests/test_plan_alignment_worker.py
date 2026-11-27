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
from app.models import DeploymentConfig, ObjectSite, PlanAlignment, PlanPageFloor, PlanRevision, ReferenceDataset


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
    assert compute.render_preview("plans/exact.pdf", 1) == (second.png, "image/png")
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
            claimed_at=None,  # as `POST …/retry` writes it
            edit_version=PlanAlignment.edit_version + 1,
        )
    )
    current = await worker.claim_job(db_session)
    assert current and current.attempt == old.attempt
    assert current.edit_version != old.edit_version
    assert not await worker.finish_job(db_session, old, compute.AlignmentResult("ready"))
    assert await worker.finish_job(db_session, current, compute.AlignmentResult("no_match"))


async def test_a_job_moved_onto_another_dataset_is_not_finished(db_session, pdf_store):
    """A merge or re-key keeps the alignment's id and moves it onto another dataset (and object)
    while the worker renders. The run locked the OLD object, so it must not write – nor approve –
    the moved row; the next claim takes it under its new owner."""
    await seed(db_session, pdf_store)
    claim = await worker.claim_job(db_session)
    assert claim
    moved = replace(claim, dataset_id="plan:00000000-0000-4000-8000-000000000000:modul1")
    assert not await worker.finish_job(db_session, moved, compute.AlignmentResult("ready"))
    assert (await db_session.execute(select(PlanAlignment.status))).scalar_one() == "processing"


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


async def _store_config(session_factory, document) -> None:
    async with session_factory() as db:
        db.add(DeploymentConfig(id=1, config_json=document))
        await db.commit()


@pytest.mark.parametrize("document", [{"modules": "not a list"}, []])
async def test_an_unreadable_station_config_ends_the_job_at_once_and_writes_nothing(
    session_factory, single_page_store, monkeypatch, document
):
    """The fallback's shipped catalogue is not the station's choice: no floor, no fit, no retry."""
    async with session_factory() as db:
        await seed(db, single_page_store)
    await _store_config(session_factory, document)
    reached = []
    monkeypatch.setattr(worker, "ensure_snapshot", lambda db: reached.append("snapshot"))
    monkeypatch.setattr(worker, "read_plan", lambda key: reached.append("markers"))

    assert await worker.run_once(session_factory)
    assert not await worker.run_once(session_factory)  # ended, not waiting for a retry
    assert reached == []
    async with session_factory() as db:
        job = (await db.execute(select(PlanAlignment))).scalar_one()
        assert (job.status, job.reason, job.attempts) == ("failed", "config_unreadable", 1)
        assert job.claimed_at is None and job.pairs == [] and job.marker_notes is None
        assert (await db.execute(select(PlanPageFloor))).first() is None


async def test_a_well_formed_station_config_still_steers_the_job(session_factory, single_page_store, matcher):
    async with session_factory() as db:
        await seed(db, single_page_store)
    await _store_config(session_factory, {"modules": [{"id": "modul2", "alignment": "manual"}]})
    assert await worker.run_once(session_factory)
    async with session_factory() as db:
        job = (await db.execute(select(PlanAlignment))).scalar_one()
        assert (job.status, job.reason) == ("no_match", "manual_module")


def test_module_alignment_is_the_catalogue_choice_with_the_shipped_defaults():
    assert compute.module_alignment(None, "modul2") == "auto"
    assert compute.module_alignment([], "modul2-3") == "auto"
    assert compute.module_alignment(None, "modul6") == "none"
    catalogue = [
        {"id": "modul2", "alignment": "manual"},
        {"id": "modul5", "family": True, "alignment": "auto"},
        {"id": "modul6", "viewer": True},
    ]
    assert compute.module_alignment(catalogue, "modul2") == "manual"
    assert compute.module_alignment(catalogue, "modul5-wasser1") == "auto"  # inherits its family
    assert compute.module_alignment(catalogue, "modul6") == "none"
    assert compute.module_alignment(catalogue, "modul1") == "auto"  # unset entry → default


async def test_the_catalogue_can_keep_a_module_by_hand_or_off_the_map(single_page_store, matcher):
    page = compute.render_page("plans/exact.pdf", 0)
    by_hand = await compute.compute_alignment(page, "modul2", 7.0, 47.0, None, "manual")
    assert (by_hand.status, by_hand.reason, by_hand.pairs) == ("no_match", "manual_module", [])
    off = await compute.compute_alignment(page, "modul2", 7.0, 47.0, None, "none")
    assert (off.status, off.reason) == ("unsupported", "unsupported_module")
    # `auto` on a module the matcher has no template for stays honest
    floor_plans = await compute.compute_alignment(page, "modul6", 7.0, 47.0, None, "auto")
    assert (floor_plans.status, floor_plans.reason) == ("unsupported", "unsupported_module")


def test_a_sheet_clips_its_box_out_of_the_station_snapshot_like_overpass_would():
    from app import reference_buildings as ref

    inside = {"type": "way", "id": 1, "geometry": [{"lat": 47.5001, "lon": 7.5001}, {"lat": 47.6, "lon": 7.6}]}
    outside = {"type": "way", "id": 2, "geometry": [{"lat": 47.9, "lon": 7.9}]}
    relation = {
        "type": "relation",
        "id": 3,
        "members": [{"type": "way", "role": "outer", "geometry": [{"lat": 47.5002, "lon": 7.5}]}],
    }
    snapshot = {"elements": [inside, outside, relation]}
    kept = ref.clip(snapshot, 7.5, 47.5, 190)["elements"]
    assert [e["id"] for e in kept] == [1, 3]  # one vertex inside is enough; the far way is gone
    box = ref.bbox_of([(7.5, 47.5), (7.52, 47.51)], pad_m=700)
    assert box is not None and ref.covers(box, (47.5, 7.5, 47.51, 7.52))
    assert not ref.covers(box, (47.4, 7.5, 47.51, 7.52))


async def test_the_snapshot_is_fetched_once_and_a_refusing_mirror_keeps_the_stale_one(
    db_session, monkeypatch, tmp_path
):
    from app import reference_buildings as ref

    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))
    monkeypatch.setattr(ref, "_cache", None)
    db_session.add(ObjectSite(name="A", lat=47.5, lng=7.5))
    await db_session.commit()
    calls: list[str] = []

    async def fetch(query, timeout_s=20.0, **_kw):
        calls.append(query)
        return {"elements": [{"type": "way", "id": 1, "geometry": [{"lat": 47.5, "lon": 7.5}]}]}

    monkeypatch.setattr(ref.overpass, "fetch_buildings", fetch)
    first = await ref.ensure_snapshot(db_session)
    assert first and len(first["elements"]) == 1 and len(calls) == 1
    monkeypatch.setattr(ref, "_cache", None)
    assert (await ref.ensure_snapshot(db_session)) == first and len(calls) == 1  # stored, still fresh

    async def refuse(query, timeout_s=20.0):
        raise RuntimeError("429")

    monkeypatch.setattr(ref.overpass, "fetch_buildings", refuse)
    monkeypatch.setattr(ref, "_cache", None)
    monkeypatch.setattr(ref, "SNAPSHOT_TTL", ref.timedelta(seconds=0))  # force a refresh attempt
    assert (await ref.ensure_snapshot(db_session)) == first  # stale beats nothing


async def test_compute_with_a_snapshot_never_asks_overpass(single_page_store, matcher, monkeypatch):
    async def boom(*_a):
        raise RuntimeError("no network")

    monkeypatch.setattr(compute, "_osm_around", boom)
    page = compute.render_page("plans/exact.pdf", 0)
    ring = [
        {"lon": 7.0, "lat": 47.0},
        {"lon": 7.001, "lat": 47.0},
        {"lon": 7.001, "lat": 47.001},
        {"lon": 7.0, "lat": 47.0},
    ]
    snapshot = {"fetched_at": "2026-09-13T10:00:00+00:00", "elements": [{"type": "way", "geometry": ring}]}
    result = await compute.compute_alignment(page, "modul2", 7.0, 47.0, None, "auto", snapshot)
    assert result.status == "ready"
    assert "station snapshot" in (result.reference_source or "")
    assert result.reference_at is not None and result.reference_at.isoformat().startswith("2026-09-13T10:00")
    without = await compute.compute_alignment(page, "modul2", 7.0, 47.0, None, "auto", None)
    assert without.reason == "reference_unreachable"


async def test_a_job_whose_object_a_run_holds_goes_back_and_the_next_one_runs(
    session_factory, db_session, pdf_store, monkeypatch
):
    """A SharePoint run or an S3 pull holds its objects to its commit (`plans` › the lock order). The
    worker gives such a job back – queued, the attempt not counted – and takes the next one, so one
    held object does not stall the queue. PostgreSQL only: SQLite has no row locks."""
    if db_session.bind.dialect.name != "postgresql":
        pytest.skip("requires independent PostgreSQL transactions")
    from app import plans

    monkeypatch.setattr(plans, "WORKER_LOCK_WAIT_MS", 200)

    async def no_snapshot(db):  # a two-page sheet ends «unsupported» before it is compared to one
        return None

    monkeypatch.setattr(worker, "ensure_snapshot", no_snapshot)
    held_job = await seed(db_session, pdf_store)
    free_job = await seed(db_session, pdf_store)
    held_object = (
        await db_session.execute(
            select(ReferenceDataset.object_id)
            .join(PlanAlignment, PlanAlignment.dataset_id == ReferenceDataset.id)
            .where(PlanAlignment.id == held_job)
        )
    ).scalar_one()

    async with session_factory() as run:
        await plans.lock_objects(run, held_object)
        assert await worker.run_once(session_factory)  # the held job: given back
        assert await worker.run_once(session_factory)  # the free one: done
        assert not await worker.run_once(session_factory)  # the held one is not due yet
        await run.commit()

    held = await db_session.get(PlanAlignment, held_job, populate_existing=True)
    assert (held.status, held.attempts, held.reason) == ("pending", 0, None)
    assert (await db_session.get(PlanAlignment, free_job, populate_existing=True)).status == "unsupported"
    # BUSY_RETRY_SECONDS later it is claimed again, as the first attempt
    held.claimed_at -= timedelta(seconds=worker.BUSY_RETRY_SECONDS + 1)
    await db_session.commit()
    assert await worker.run_once(session_factory)
    done = await db_session.get(PlanAlignment, held_job, populate_existing=True)
    assert (done.status, done.attempts) == ("unsupported", 1)


async def test_a_job_whose_row_a_run_holds_too_does_not_stall_the_queue(
    session_factory, db_session, pdf_store, monkeypatch
):
    """A re-key holds the alignment row as well as the object. The worker, which claimed the job
    before, times out on the object; its give-back cannot write the row either and gives up as
    quickly, leaving the job to its lease – and the next job still runs."""
    if db_session.bind.dialect.name != "postgresql":
        pytest.skip("requires independent PostgreSQL transactions")
    import asyncio

    from sqlalchemy.exc import DBAPIError

    from app import plans

    async def no_snapshot(db):
        return None

    monkeypatch.setattr(worker, "ensure_snapshot", no_snapshot)
    monkeypatch.setattr(plans, "WORKER_LOCK_WAIT_MS", 200)
    held_job = await seed(db_session, pdf_store)
    free_job = await seed(db_session, pdf_store)
    held_object = (
        await db_session.execute(
            select(ReferenceDataset.object_id)
            .join(PlanAlignment, PlanAlignment.dataset_id == ReferenceDataset.id)
            .where(PlanAlignment.id == held_job)
        )
    ).scalar_one()
    claim = await worker.claim_job(db_session)
    assert claim and claim.id == held_job
    await db_session.commit()

    async with session_factory() as rekey:
        await plans.lock_objects(rekey, held_object)
        await rekey.execute(select(PlanAlignment.id).where(PlanAlignment.id == held_job).with_for_update())
        async with session_factory() as db:
            await plans.limit_lock_wait(db, plans.WORKER_LOCK_WAIT_MS)
            with pytest.raises(DBAPIError) as waited:
                await plans.lock_objects(db, held_object)
            assert await asyncio.wait_for(worker._given_back(db, claim, waited.value), 5)
        assert await worker.run_once(session_factory)  # the free job
        await rekey.commit()

    held = await db_session.get(PlanAlignment, held_job, populate_existing=True)
    assert (held.status, held.attempts) == ("processing", 1)  # the lease brings it back
    assert (await db_session.get(PlanAlignment, free_job, populate_existing=True)).status == "unsupported"


async def test_the_retry_limit_sweep_skips_a_row_a_run_holds(session_factory, db_session, pdf_store):
    """A job at its last attempt whose lease ran out while a re-key holds its row: the sweep that
    marks such jobs failed skips it (SKIP LOCKED) instead of waiting, and the free job is claimed."""
    if db_session.bind.dialect.name != "postgresql":
        pytest.skip("requires independent PostgreSQL transactions")
    import asyncio

    held_job = await seed(db_session, pdf_store)
    free_job = await seed(db_session, pdf_store)
    held = await db_session.get(PlanAlignment, held_job)
    held.status, held.attempts = "processing", worker.MAX_ATTEMPTS
    held.claimed_at = datetime.now(UTC) - timedelta(seconds=worker.LEASE_SECONDS + 1)
    await db_session.commit()

    async with session_factory() as rekey:
        await rekey.execute(select(PlanAlignment.id).where(PlanAlignment.id == held_job).with_for_update())
        async with session_factory() as db:
            claim = await asyncio.wait_for(worker.claim_job(db), 5)
            assert claim and claim.id == free_job
            await db.commit()
        await rekey.commit()
    assert (await db_session.get(PlanAlignment, held_job, populate_existing=True)).status == "processing"

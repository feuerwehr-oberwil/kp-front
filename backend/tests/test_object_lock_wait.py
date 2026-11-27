"""Who waits for a run that holds an object's plans (`plans` › the lock order).

A SharePoint run or an S3 pull holds «the plans of» every object it stored a plan for until its
one commit, minutes later. A plain object write (the mask, «Lage korrigieren», the organizer's
object PUT) never meets that lock and goes through at once; a desk request about the PLANS gives
up after `plans.LOCK_WAIT_MS` with a sentence, writes nothing, and works again after the commit.
PostgreSQL only: SQLite has no row or advisory locks.
"""

import asyncio
import time
from io import BytesIO

import pytest
from reportlab.pdfgen.canvas import Canvas
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app import plans, storage
from app.i18n import DETAIL_TRANSLATIONS
from app.models import ObjectRef, ObjectSite, PlanAlignment
from app.plans import limit_lock_wait, store_plan
from tests.ov_support import bearer, set_config, set_key

PAIRS = [
    {"plan": {"x": 0.2, "y": 0.2}, "lngLat": {"lng": 7.5, "lat": 47.5}, "kind": "auto"},
    {"plan": {"x": 0.8, "y": 0.8}, "lngLat": {"lng": 7.501, "lat": 47.499}, "kind": "auto"},
]


def _pdf(label: str = "one sheet") -> bytes:
    buf = BytesIO()
    canvas = Canvas(buf, pagesize=(700, 500))
    canvas.drawString(50, 50, label)
    canvas.showPage()
    canvas.save()
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _postgres_and_a_short_wait(db_session, tmp_path, monkeypatch):
    if db_session.bind.dialect.name != "postgresql":
        pytest.skip("requires independent PostgreSQL transactions")
    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))
    monkeypatch.setattr(plans, "LOCK_WAIT_MS", 300)


async def _object_with_a_proposal(db) -> tuple[ObjectSite, PlanAlignment]:
    obj = ObjectSite(name="Musterhaus")
    db.add(obj)
    await db.flush()
    db.add(ObjectRef(object_id=obj.id, source="fwo", external_id="haus-1"))
    db.add(ObjectRef(object_id=obj.id, source="fwo", external_id="haus-2"))
    await store_plan(db, obj, "modul1", _pdf())
    row = (await db.execute(select(PlanAlignment))).scalar_one()
    row.status, row.pairs, row.aspect = "ready", PAIRS, 1.4
    await db.commit()
    return obj, row


async def _a_run_on(run: AsyncSession, obj: ObjectSite) -> None:
    """What a SharePoint run does to the object, uncommitted: replace one plan, import a new one."""
    mine = await run.get(ObjectSite, obj.id)
    await store_plan(run, mine, "modul1", _pdf("replacement"))
    await store_plan(run, mine, "modul2", _pdf("first import"))


async def test_plain_object_writes_go_through_while_a_run_holds_the_plans(
    client, admin_login, db_session, session_factory
):
    obj, _ = await _object_with_a_proposal(db_session)
    await set_config(db_session)
    await set_key(db_session)
    await admin_login(client)

    async with session_factory() as run:
        await _a_run_on(run, obj)
        # none of them has a wait limit: a request that met the run's lock would hang here
        at_once = lambda request: asyncio.wait_for(request, 5)  # noqa: E731
        mask = await at_once(client.put(f"/api/objects/{obj.id}", json={"name": "Musterhaus Nord"}))
        position = await at_once(
            client.put(f"/api/objects/{obj.id}/position", json={"lat": 47.5, "lng": 7.5, "outline": "auto"})
        )
        organizer = await at_once(
            client.put("/api/integrations/objects/fwo/haus-1", json={"name": "Musterhaus Nord"}, headers=bearer())
        )
        removed = await at_once(client.delete("/api/integrations/objects/fwo/haus-2", headers=bearer()))
        assert (mask.status_code, position.status_code, organizer.status_code) == (200, 200, 200)
        assert removed.json() == {"removed": "ref"}
        await run.commit()

    written = await db_session.get(ObjectSite, obj.id, populate_existing=True)
    assert (written.name, float(written.lat), written.position_source) == ("Musterhaus Nord", 47.5, "station")


async def test_an_approval_gives_up_while_a_run_holds_the_plans(client, admin_login, db_session, session_factory):
    obj, row = await _object_with_a_proposal(db_session)
    await admin_login(client)
    url = f"/api/admin/plan-alignments/{row.id}/approve"

    async with session_factory() as run:
        await _a_run_on(run, obj)
        started = time.monotonic()
        refused = await client.post(url, json={"edit_version": 1})
        assert time.monotonic() - started < 3
        assert (refused.status_code, refused.json()["detail"]) == (409, plans.PLANS_BUSY)
        assert refused.headers["Retry-After"] == str(plans.BUSY_RETRY_AFTER_S)
        # «Ablehnen» too: a merge deletes the history it appends to
        rejected = await client.post(f"/api/admin/plan-alignments/{row.id}/reject", json={"edit_version": 1})
        assert (rejected.status_code, rejected.json()["detail"]) == (409, plans.PLANS_BUSY)
        await run.rollback()

    held = await db_session.get(PlanAlignment, row.id, populate_existing=True)
    assert (held.status, held.edit_version) == ("ready", 1)
    assert (await client.post(url, json={"edit_version": 1})).status_code == 200


async def test_a_first_plan_upload_gives_up_while_a_run_imports_the_same_plan(
    client, admin_login, db_session, session_factory
):
    """The run's INSERT of a new plan row is invisible to the request, which then takes the generic
    path and would wait on the row's key – it is bounded the same way."""
    obj = ObjectSite(name="Neubau")
    db_session.add(obj)
    await db_session.commit()
    await admin_login(client)
    url = f"/api/reference/plan:{obj.id}:modul1"

    async with session_factory() as run:
        await store_plan(run, await run.get(ObjectSite, obj.id), "modul1", _pdf())
        refused = await client.put(url, files={"file": ("m1.pdf", _pdf(), "application/pdf")})
        assert (refused.status_code, refused.json()["detail"]) == (409, plans.PLANS_BUSY)
        await run.rollback()


async def test_a_rejection_gives_up_while_a_run_holds_the_alignment(client, admin_login, db_session, session_factory):
    """A re-key moves the alignment rows; «Ablehnen» and «Zurücknehmen» wait for one at most as long."""
    _, row = await _object_with_a_proposal(db_session)
    await admin_login(client)

    async with session_factory() as run:
        await run.execute(select(PlanAlignment.id).where(PlanAlignment.id == row.id).with_for_update())
        refused = await client.post(f"/api/admin/plan-alignments/{row.id}/reject", json={"edit_version": 1})
        assert (refused.status_code, refused.json()["detail"]) == (409, plans.PLANS_BUSY)
        await run.commit()

    assert (await db_session.get(PlanAlignment, row.id, populate_existing=True)).status == "ready"


async def test_the_wait_limit_ends_with_its_transaction(engine):
    """`SET LOCAL`: the next transaction on the SAME connection – a pooled one's next request – has
    the server default again, after a commit and after a rollback alike."""
    async with engine.connect() as conn:
        db = AsyncSession(bind=conn)
        for end in (db.commit, db.rollback):
            await limit_lock_wait(db, 300)
            assert (await db.execute(text("SHOW lock_timeout"))).scalar_one() == "300ms"
            await end()
            assert (await db.execute(text("SHOW lock_timeout"))).scalar_one() == "0"
            await db.rollback()


def test_the_refusals_are_translated():
    for sentence in (plans.PLANS_BUSY, plans.RUN_BUSY):
        assert set(DETAIL_TRANSLATIONS[sentence]) == {"en", "fr", "it"}

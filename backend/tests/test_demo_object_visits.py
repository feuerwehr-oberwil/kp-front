"""The demo's Objektbesuche: seeded on both reset paths, onto the Schloss the manifest names."""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import func, select

import app.demo_object_visits as dov
import app.demo_reset as dr
from app import object_visits as ov
from app.checklist_templates import template_problem, visit_items
from app.models import ObjectSite, ObjectVisit, ObjectVisitRevision, VisitList, VisitProgramme
from app.schemas import load_stored_config

DEMO_DIR = Path(__file__).resolve().parents[2] / "examples" / "demo-data"


async def _schloss(session_factory) -> None:
    async with session_factory() as db:
        db.add(ObjectSite(id=dov.SCHLOSS_ID, name="Schloss Musterdorf", address="Schlossgasse 9, 9999 Musterdorf"))
        await db.commit()


async def _count(db, model) -> int:
    return int((await db.execute(select(func.count()).select_from(model))).scalar_one())


def test_the_seed_names_the_object_the_manifest_loads():
    """The seed is keyed to a fixed id it does not create — the manifest does. Renumber one and
    the other has to follow, or the seed skips on every reset and nobody notices."""
    objects = json.loads((DEMO_DIR / "objects.manifest.json").read_text())["objects"]
    assert str(dov.SCHLOSS_ID) in {o["id"] for o in objects}


def test_the_demo_checklist_is_a_visit_template_the_seed_answers_fully():
    manifest = json.loads((DEMO_DIR / "checklists.manifest.json").read_text())["checklists"]
    entry = next(c for c in manifest if c["kind"] == "visit")
    tpl = json.loads((DEMO_DIR / entry["file"]).read_text())
    assert template_problem(tpl) is None
    assert tpl["id"] == entry["id"] and tpl["kind"] == "visit"
    # every seeded answer names an item of the checklist (an edit to one without the other
    # would print answers the report cannot place)
    doc = dov.build_visit_doc(tpl, {"id": str(dov.SCHLOSS_ID), "name": "Schloss"}, "w", datetime.now(UTC))
    items = {i["id"] for i in visit_items(tpl)}
    assert set(doc["answers"]) <= items


def test_the_demo_config_switches_the_module_on_without_a_destination():
    cfg = load_stored_config(json.loads((DEMO_DIR / "config.json").read_text())).objectVisits
    assert cfg.enabled and cfg.destinations == []
    # the seeded Korrekturvorschlag uses a field the station offers
    assert "owner_contact" in {f.id for f in cfg.proposalFields}


@pytest.mark.asyncio
async def test_the_in_process_reset_seeds_a_finished_visit_on_a_round(session_factory, monkeypatch):
    """The cron path keeps the Schloss (wipe_objects=False), so reset() seeds — twice in a row
    without doubling anything."""
    monkeypatch.setenv("KP_DEMO_RESET", "1")  # this is the throwaway test database
    monkeypatch.setattr(dr, "async_session_maker", session_factory)
    await _schloss(session_factory)

    await dr.reset(wipe_objects=False)
    await dr.reset(wipe_objects=False)

    async with session_factory() as db:
        visit = (await db.execute(select(ObjectVisit))).scalar_one()
        assert (visit.lifecycle, visit.revision, visit.ready, visit.findings) == ("completed", 1, True, 1)
        assert visit.object_id == dov.SCHLOSS_ID
        assert visit.created_by_name == "Führungsunterstützung"
        assert await _count(db, ObjectVisitRevision) == 1
        assert await _count(db, VisitProgramme) == 1
        cat = await ov.catalogue(db, can_capture=True)
    # the overview has a round of two stops, the Schloss one done by the seeded visit …
    (round_,) = cat["lists"]
    assert visit.work_ref == round_["ref"] and not round_["archived"] and round_["scheduledOn"]
    assert round_["objectIds"][0] == str(dov.SCHLOSS_ID) and len(round_["objectIds"]) == 2
    assert round_["unresolved"] == []
    # … and the Schloss reads «zuletzt besucht»; the key-box stop is the plan-less one
    by_id = {o["id"]: o for o in cat["objects"]}
    assert by_id[str(dov.SCHLOSS_ID)]["lastVisit"]["id"] == dov.VISIT_ID
    assert [o["hasPlans"] for o in cat["objects"] if o["id"] != str(dov.SCHLOSS_ID)] == [False]
    assert [t["id"] for t in cat["templates"]] == []  # the template is pushed by its own step


@pytest.mark.asyncio
async def test_the_script_reset_skips_until_the_object_push_then_seeds(session_factory, monkeypatch):
    """⚠️ scripts/demo-reset.sh wipes the Schloss in step 2. A visit seeded there would lose its
    object (ON DELETE SET NULL), so step 2 skips and step 4b seeds after the push."""
    monkeypatch.setenv("KP_DEMO_RESET", "1")  # this is the throwaway test database
    monkeypatch.setattr(dr, "async_session_maker", session_factory)
    await _schloss(session_factory)

    await dr.reset()  # step 2: the Schloss goes, nothing is seeded onto it
    async with session_factory() as db:
        assert await _count(db, ObjectVisit) == 0
        assert await _count(db, VisitList) == 0

    await _schloss(session_factory)  # step 4: the object push
    async with session_factory() as db:  # step 4b
        assert await dov.seed_object_visits(db) is True
        await db.commit()
    async with session_factory() as db:
        visit = (await db.execute(select(ObjectVisit))).scalar_one()
        assert visit.object_id == dov.SCHLOSS_ID and visit.lifecycle == "completed"


@pytest.mark.asyncio
async def test_the_seed_refuses_without_the_demo_flag(session_factory, monkeypatch):
    monkeypatch.delenv("KP_DEMO_RESET", raising=False)
    async with session_factory() as db:
        with pytest.raises(dr.NotADemoDatabaseError):
            await dov.seed_object_visits(db)

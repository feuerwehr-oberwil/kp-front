"""What a merge carries over (`admin_objects_repair merge <loser> --into <survivor>`) — and that it
may not lose a single plan, landmark pair or picked object, nor rewrite the history.

The planning and apply here (`_plan_merge` / `_apply_pair`) were written for the NFD/NFC twins an
import minted from a Mac-run folder listing (11.09.2026), so the fixtures are still two spellings
of one name; the one-off fold that found them by name is gone (15.11.2026), a person now names
the pair. These tests pin the parts that are dangerous — that everything pointing at the loser
follows it, that a plan slot already on the survivor is never overwritten, and that the history
stays as it was.
"""

import unicodedata
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from app import admin_objects_repair
from app.admin_objects import object_id_for_key
from app.models import (
    DeploymentConfig,
    Incident,
    IncidentEvent,
    JournalEntry,
    ObjectSite,
    PlanAlignment,
    PlanAlignmentEvent,
    PlanPageFloor,
    PlanRevision,
    ReferenceDataset,
)

NFC_NAME = "Kindergarten Hüsli"  # ü = U+00FC
NFD_NAME = unicodedata.normalize("NFD", NFC_NAME)  # ü = u + U+0308


@pytest.fixture(autouse=True)
def _cli_session(monkeypatch, session_factory):
    """The CLI opens its own session; point it at the test database."""
    monkeypatch.setattr(admin_objects_repair, "async_session_maker", session_factory)


async def _object(
    db,
    name: str,
    *,
    oid: uuid.UUID | None = None,
    plans: dict[str, str | None] | None = None,
    source_key: str | None = None,
    updated_at: datetime | None = None,
    **fields: object,
) -> uuid.UUID:
    """One stored Einsatzobjekt + its plan rows ({module: source_digest})."""
    oid = oid or object_id_for_key(name)
    db.add(ObjectSite(id=oid, name=name, source_key=source_key, updated_at=updated_at or datetime.now(UTC), **fields))
    for module, digest in (plans or {}).items():
        db.add(
            ReferenceDataset(
                id=f"plan:{oid}:{module}",
                object_id=oid,
                module=module,
                kind="pdf",
                title=f"{name} – {module}",
                storage_key=f"plans/{oid}/{module}.pdf",
                source_digest=digest,
            )
        )
    await db.commit()
    return oid


async def _scales(db, doc: dict[str, object]) -> None:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1)
        db.add(row)
    row.plan_scales_json = doc
    await db.commit()


async def _incident(db, *, picked: uuid.UUID | None = None) -> uuid.UUID:
    row = Incident(
        title="Brand Kindergarten",
        source="manual",
        status="offen",
        map_workspace_json={"pickedObjectId": str(picked), "entities": []} if picked else {"entities": []},
    )
    db.add(row)
    await db.commit()
    return row.id


async def _count(db, model) -> int:
    return int((await db.execute(select(func.count()).select_from(model))).scalar_one())


async def test_the_loser_hands_everything_over(db_session, capsys):
    """The twin's plans, calibration, source_key and picked-object references all have to arrive
    on the survivor."""
    survivor = await _object(db_session, NFC_NAME, plans={"modul1": "a" * 64})
    loser = await _object(
        db_session,
        NFD_NAME,
        oid=object_id_for_key(NFD_NAME),
        plans={"modul2": "b" * 64, "modul3": "c" * 64},
        source_key="Kindergarten Hüsli",
    )
    assert survivor != loser, "the two spellings must start out as two different ids"
    await _scales(
        db_session,
        {
            "byPlan": {f"object:{loser}:plan:modul2": {"mPerU": 1.0, "refM": 10.0, "ar": 1.4}},
            "georefByPlan": {f"object:{loser}:plan:modul2": {"pairs": []}},
        },
    )
    incident = await _incident(db_session, picked=loser)

    assert await admin_objects_repair._merge_into(loser, survivor, apply=True) == 0

    objects = list((await db_session.execute(select(ObjectSite))).scalars())
    assert [o.id for o in objects] == [survivor]
    assert objects[0].source_key == "Kindergarten Hüsli", "the pull key died with the loser"

    moved = list((await db_session.execute(select(ReferenceDataset).order_by(ReferenceDataset.id))).scalars())
    assert {d.id for d in moved} == {f"plan:{survivor}:modul{n}" for n in (1, 2, 3)}
    assert {d.object_id for d in moved} == {survivor}
    # Re-keyed, not just re-pointed: a row left under `plan:<loser>:modul2` is a row the next
    # `load` would mint a second time.
    assert all(str(loser) not in d.id for d in moved)

    scales = (await db_session.execute(select(DeploymentConfig))).scalar_one().plan_scales_json or {}
    assert list(scales["byPlan"]) == [f"object:{survivor}:plan:modul2"]
    assert list(scales["georefByPlan"]) == [f"object:{survivor}:plan:modul2"]

    workspace = (await db_session.execute(select(Incident).where(Incident.id == incident))).scalar_one()
    assert (workspace.map_workspace_json or {})["pickedObjectId"] == str(survivor)

    out = capsys.readouterr().out
    assert "U+0308" in out and "U+00FC" in out, "the diff has to show the spellings apart"


async def test_a_merge_is_a_new_workspace_revision_so_a_stale_save_gets_its_409(db_session, session_factory):
    """⚠️ The retarget used to leave ``workspace_rev`` alone (23.09.2026): a tablet still holding the
    pre-merge rev saved straight over it and put the dead object id back. The rev is the whole
    optimistic-concurrency contract of ``PUT …/workspace`` — a merge has to move it."""
    from fastapi import HTTPException

    from app.incident_service import apply_workspace_put
    from app.schemas import WorkspacePut

    survivor = await _object(db_session, NFC_NAME, plans={"modul1": "a" * 64})
    loser = await _object(db_session, NFD_NAME, oid=object_id_for_key(NFD_NAME), plans={"modul2": "b" * 64})
    incident = await _incident(db_session, picked=loser)
    before = (await db_session.execute(select(Incident).where(Incident.id == incident))).scalar_one()
    base_rev, updated_at = before.workspace_rev, before.updated_at

    assert await admin_objects_repair._merge_into(loser, survivor, apply=True) == 0

    async with session_factory() as db:
        row = (await db.execute(select(Incident).where(Incident.id == incident))).scalar_one()
        assert row.workspace_rev == base_rev + 1
        assert row.map_workspace_json["pickedObjectId"] == str(survivor)
        # a maintenance fold is not a change to the Einsatz («geändert nach Abschluss» reads this)
        assert row.updated_at == updated_at
        stale = WorkspacePut(base_rev=base_rev, workspace={"pickedObjectId": str(loser), "entities": []})
        with pytest.raises(HTTPException) as refused:
            await apply_workspace_put(db, incident, stale, user_id=None)
        assert refused.value.status_code == 409
        assert refused.value.detail["server_rev"] == base_rev + 1


async def test_a_slot_the_survivor_already_holds_is_reported_not_overwritten(db_session, capsys):
    """Two different sheets under one module is the one case a merge must NOT decide. Nothing is
    written: the survivor's plan stays, the loser keeps its own — and its row survives with it."""
    survivor = await _object(db_session, NFC_NAME, plans={"modul1": "a" * 64})
    loser = await _object(
        db_session,
        NFD_NAME,
        oid=object_id_for_key(NFD_NAME),
        plans={"modul1": "b" * 64},
        source_key="Kindergarten Hüsli",
    )

    assert await admin_objects_repair._merge_into(loser, survivor, apply=True) == 1, (
        "an unfinished merge exits non-zero"
    )

    assert await _count(db_session, ObjectSite) == 2, "a row still holding a plan was deleted"
    surviving_row = (await db_session.execute(select(ObjectSite).where(ObjectSite.id == loser))).scalar_one()
    assert surviving_row.source_key == "Kindergarten Hüsli", "a row that stays keeps the key the pull matches on"
    kept = (
        await db_session.execute(select(ReferenceDataset).where(ReferenceDataset.id == f"plan:{survivor}:modul1"))
    ).scalar_one()
    assert kept.source_digest == "a" * 64, "the survivor's sheet was overwritten by the twin's"
    still_there = (
        await db_session.execute(select(ReferenceDataset).where(ReferenceDataset.object_id == loser))
    ).scalar_one()
    assert still_there.id == f"plan:{loser}:modul1"
    assert "CONFLICT" in capsys.readouterr().out


async def test_an_identical_duplicate_plan_row_is_dropped(db_session, monkeypatch):
    """The same PDF imported twice under two spellings: one row is redundant, and only then may
    the twin row go. Bytes are compared — the plans a hand upload wrote carry no digest."""
    survivor = await _object(db_session, NFC_NAME, plans={"modul1": None})
    loser = await _object(db_session, NFD_NAME, oid=object_id_for_key(NFD_NAME), plans={"modul1": None})
    monkeypatch.setattr(admin_objects_repair.storage, "get_bytes", lambda key: b"%PDF-1.4 same sheet")

    assert await admin_objects_repair._merge_into(loser, survivor, apply=True) == 0

    assert [o.id for o in (await db_session.execute(select(ObjectSite))).scalars()] == [survivor]
    rows = list((await db_session.execute(select(ReferenceDataset))).scalars())
    assert [r.id for r in rows] == [f"plan:{survivor}:modul1"]
    assert str(loser) not in (rows[0].storage_key or ""), "the survivor's own blob must be the one kept"


async def test_the_history_is_counted_and_left_alone(db_session, capsys):
    """The audit chain is the record of what was true that night. Rewriting it to tidy the object
    table would break the hash chain and lie about the Einsatz."""
    survivor = await _object(db_session, NFC_NAME)
    loser = await _object(db_session, NFD_NAME, oid=object_id_for_key(NFD_NAME))
    incident = await _incident(db_session)
    db_session.add(
        IncidentEvent(
            incident_id=incident,
            seq=1,
            occurred_at=datetime.now(UTC),
            source="client",
            op_type="object.picked",
            payload_json={"objectId": str(loser)},
            hash="deadbeef",
        )
    )
    db_session.add(
        JournalEntry(incident_id=incident, client_id="t1", seq=1, row_json={"text": f"Objekt {loser} gewählt"})
    )
    await db_session.commit()

    assert await admin_objects_repair._merge_into(loser, survivor, apply=True) == 0

    event = (await db_session.execute(select(IncidentEvent))).scalar_one()
    assert (event.payload_json or {})["objectId"] == str(loser), "the audit trail was rewritten"
    journal = (await db_session.execute(select(JournalEntry))).scalar_one()
    assert str(loser) in (journal.row_json or {})["text"]
    assert "left untouched" in capsys.readouterr().out


async def _revision(db, dataset_id: str, *, version: int = 1, approved: bool = False) -> int:
    """A plan sheet the way `store_plan` leaves it: an immutable revision, its alignment (plus one
    decision in that alignment's history) and a floor of the building drawn on it."""
    db.add(
        PlanRevision(
            dataset_id=dataset_id,
            version=version,
            storage_key=f"{dataset_id}-v{version}.pdf",
            content_type="application/pdf",
        )
    )
    await db.flush()
    alignment = PlanAlignment(
        dataset_id=dataset_id,
        plan_version=version,
        page=0,
        status="approved" if approved else "pending",
        edit_version=1,
        pairs=[],
        reference_rings=[],
    )
    db.add(alignment)
    db.add(PlanPageFloor(dataset_id=dataset_id, plan_version=version, floor_index=0, page=0))
    await db.flush()
    db.add(PlanAlignmentEvent(alignment_id=alignment.id, action="approve", edit_version=1, snapshot={}))
    await db.commit()
    return alignment.id


async def test_a_folded_sheet_takes_its_revisions_and_alignments_with_it(db_session):
    """⚠️ The FWO case, 16.09.2026: a plan row is no longer alone. `plan_revisions.dataset_id` is
    ON DELETE RESTRICT and carries no ON UPDATE CASCADE, so a merge that deletes or re-keys a
    dataset row without moving its revisions first aborts the WHOLE run on postgres — which is
    exactly what the one duplicate object on that deployment did. A dropped sheet's rows must be
    gone, a moved sheet's rows must have followed it onto the new key."""
    survivor = await _object(db_session, NFC_NAME, plans={"modul1": "a" * 64})
    loser = await _object(
        db_session,
        NFD_NAME,
        oid=object_id_for_key(NFD_NAME),
        plans={"modul1": "a" * 64, "modul2": "b" * 64},  # same bytes → dropped; unheld slot → moved
    )
    await _revision(db_session, f"plan:{survivor}:modul1")
    await _revision(db_session, f"plan:{loser}:modul1")
    moved_alignment = await _revision(db_session, f"plan:{loser}:modul2", approved=True)

    assert await admin_objects_repair._merge_into(loser, survivor, apply=True) == 0

    revisions = {r.dataset_id for r in (await db_session.execute(select(PlanRevision))).scalars()}
    assert revisions == {f"plan:{survivor}:modul1", f"plan:{survivor}:modul2"}
    floors = {f.dataset_id for f in (await db_session.execute(select(PlanPageFloor))).scalars()}
    assert floors == revisions, "a floor pack stayed behind on a dataset id that no longer exists"

    alignments = list((await db_session.execute(select(PlanAlignment).order_by(PlanAlignment.id))).scalars())
    assert {a.dataset_id for a in alignments} == revisions
    survived = next(a for a in alignments if a.id == moved_alignment)
    assert survived.dataset_id == f"plan:{survivor}:modul2"
    assert survived.status == "approved", "the admin's freigegebene Passung was rewritten"
    # The dropped sheet's alignment history goes with it; the moved one keeps its own.
    events = list((await db_session.execute(select(PlanAlignmentEvent))).scalars())
    assert {e.alignment_id for e in events} == {a.id for a in alignments}

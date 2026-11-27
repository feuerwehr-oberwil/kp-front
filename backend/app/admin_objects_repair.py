"""Admin CLI: repairs of a station's Einsatzobjekte table (moved out of admin_objects, sweep A.19,
23.10.2026 – that module keeps the load/push pipeline every station runs weekly). Run from
``backend/`` via ``uv run python -m app.admin_objects_repair <cmd>``, against whatever
``DATABASE_URL`` points at (docs/AGENT-RUNBOOK.md › Census and repair).

    merge <loser> --into <survivor>
                           fold one twin under ANOTHER name into an object (report only)
    twins                  list likely twins: a plan-less object whose buildings are another's
    geocode-missing        look up a position for every object that carries plans and has none —
                           by its address, or by its name when the row has no address (report only)

`merge` and `geocode-missing` REPORT by default and write only with ``--apply`` — see
:func:`_merge_into` and :func:`_geocode_missing`. The latter ends with a census, which is the
read-only way to CHECK a deployment: every Einsatzobjekt that carries plans but no coordinates,
and so surfaces at no incident whatever its plans say.

The re-key helpers (:func:`_plan_rekey`, :func:`_apply_rekey`, :func:`_retarget_scales`) are
also the SharePoint pull's, which follows a renamed plans folder with them
(sharepoint_sync · _follow_renames). The one-off folds of the twins minted before 11.09.2026
(`merge-duplicates`, `repair-sharepoint-keys`, `remove-empty`) were removed on 15.11.2026 once
the deployments had run them; they are in the git history.
"""

import argparse
import asyncio
import hashlib
import sys
import unicodedata
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import Text, cast, delete, func, insert, literal, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from . import storage
from .admin_cli import fail
from .admin_objects import _plan_counts, objects_without_coordinates
from .database import async_session_maker, execute_dml
from .deployment_config import config_row
from .geocode import locate_coordinates
from .models import (
    Incident,
    IncidentEvent,
    JournalEntry,
    ObjectPositionEvent,
    ObjectRef,
    ObjectSite,
    ObjectVisit,
    PlanAlignment,
    PlanAlignmentEvent,
    PlanPageFloor,
    PlanRevision,
    ReferenceDataset,
)
from .plans import lock_object_plans, lock_object_rows, lock_plan_maintenance

# --- maintenance: what a merge or re-key touches -----------------------------------------
#
# Every place a deployment writes an Einsatzobjekt's id down — what a merge has to re-point,
# and what it deliberately does not:
#
#   reference_datasets.object_id   the plans (FK). Their PRIMARY KEY encodes the object too
#                                  (``plan:<object>:<module>``), so a moved plan is re-keyed,
#                                  not just re-pointed: leaving the old key would make the next
#                                  `load`/pull mint a second row for the same sheet.
#   objects.source_key             UNIQUE — the key the scheduled pull matches on. Inherited by
#                                  the survivor when it has none and the loser goes away.
#   deployment_config
#     .plan_scales_json            the STATION calibration + georeference, keyed per sheet as
#                                  ``object:<object>:plan:<module>`` (api/plan_scales). Losing
#                                  this is losing every landmark pair an FU ever tapped.
#   incidents.map_workspace_json   ``pickedObjectId`` — the Einsatzobjekt an editor picked by
#                                  hand, which also decides what a forwarded Rapport link may
#                                  read (auth/incident_link._surfaced_object_ids).
#   incident_events.payload_json   hash-chained AUDIT records; journal_entries.row_json is the
#   journal_entries.row_json       append-only Verlauf. Both are HISTORY: they are counted and
#                                  named, never rewritten — a merge that edits the audit trail
#                                  breaks the chain it exists to protect, and «this plan hung
#                                  off the other spelling that night» is a true statement.
#   object storage                 plan blobs are addressed by ``storage_key``, which carries no
#                                  object id, so a re-pointed plan keeps its bytes. Nothing here
#                                  ever deletes a blob: an orphan costs disk, a deleted PDF costs
#                                  a crew its plan.


def _spelling(name: str) -> str:
    """A name as the diff prints it: with its Unicode form and non-ASCII codepoints when it has
    any — two spellings that differ only in Unicode form look the same."""
    marks = " ".join(f"U+{ord(c):04X}" for c in name if ord(c) > 127)
    if not marks:
        return repr(name)
    # `ascii()`, not `repr()`: printed as themselves the two spellings are the same picture, and
    # the operator is being asked to delete one of them.
    if name == unicodedata.normalize("NFC", name):
        form = "NFC"
    elif name == unicodedata.normalize("NFD", name):
        form = "NFD"
    else:
        form = "mixed"
    return f"{name!a} {form} [{marks}]"


def _retarget_json(value: object, loser: uuid.UUID, survivor: uuid.UUID) -> tuple[object, int]:
    """Rewrite every string in a JSON document that ADDRESSES the loser, keys included.

    One rule, because every id-shaped string a deployment stores is the object's uuid verbatim or
    a key built around it (``plan:<id>:<module>``, ``object:<id>:plan:<module>``,
    ``/api/objects/<id>``): a string containing the loser's uuid means the loser. Where a rewrite
    would collide with a key the document already has, the EXISTING entry wins — the survivor's
    own calibration is never overwritten by the twin's.
    """
    if isinstance(value, str):
        new = value.replace(str(loser), str(survivor))
        return new, int(new != value)
    if isinstance(value, list):
        hits = 0
        out_list: list[object] = []
        for item in value:
            new_item, n = _retarget_json(item, loser, survivor)
            out_list.append(new_item)
            hits += n
        return out_list, hits
    if isinstance(value, dict):
        hits = 0
        out_dict: dict[str, object] = {}
        for key, item in value.items():
            new_key = str(key).replace(str(loser), str(survivor))
            new_item, n = _retarget_json(item, loser, survivor)
            hits += n + int(new_key != key)
            if new_key != key and new_key in value:
                continue  # the survivor already has this key; its entry stays
            out_dict[new_key] = new_item
        return out_dict, hits
    return value, 0


def _same_bytes(a: ReferenceDataset, b: ReferenceDataset) -> Literal["same", "differs", "unknown"]:
    """Whether two plan rows hold the same PDF — the question that decides «drop the duplicate»
    from «two sheets, ask a human». Unknown (an unreadable blob) counts as a conflict upstream."""
    if a.storage_key and a.storage_key == b.storage_key:
        return "same"
    if a.source_digest and b.source_digest:
        return "same" if a.source_digest == b.source_digest else "differs"
    if not a.storage_key or not b.storage_key:
        return "unknown"
    try:
        digests = [hashlib.sha256(storage.get_bytes(k)).hexdigest() for k in (a.storage_key, b.storage_key)]
    except OSError:
        return "unknown"
    return "same" if digests[0] == digests[1] else "differs"


@dataclass
class SlotDecision:
    """What happens to one of the loser's plan rows."""

    module: str
    dataset_id: str
    target_id: str  # the key it moves to — decided here, so the apply invents nothing
    action: Literal["move", "drop", "conflict"]
    why: str


@dataclass
class MergePair:
    """One survivor ← loser merge, fully decided before anything is written."""

    survivor: ObjectSite
    loser: ObjectSite
    survivor_plans: int
    loser_plans: int
    slots: list[SlotDecision] = field(default_factory=list)
    scales_moved: list[str] = field(default_factory=list)
    scales_kept: list[str] = field(default_factory=list)  # the survivor already had that sheet
    incidents: list[uuid.UUID] = field(default_factory=list)
    events: int = 0  # audit rows naming the loser — reported, never rewritten
    journal: int = 0
    source_key: str | None = None  # the loser's, inherited when the row goes away

    @property
    def conflicts(self) -> list[SlotDecision]:
        return [s for s in self.slots if s.action == "conflict"]

    @property
    def deletable(self) -> bool:
        """The loser row goes only once nothing of its own is left on it."""
        return not self.conflicts


async def _incidents_naming(db: AsyncSession, oid: uuid.UUID) -> list[uuid.UUID]:
    """Incidents whose stored workspace names this object (``pickedObjectId``, and whatever else a
    later workspace shape keys by object). Matched as text: the document is the client's shape and
    the id can sit at any depth in it."""
    stmt = select(Incident.id).where(cast(Incident.map_workspace_json, Text).contains(str(oid)))
    return list((await db.execute(stmt)).scalars())


async def _history_naming(db: AsyncSession, oid: uuid.UUID) -> tuple[int, int]:
    """(audit events, journal rows) that name this object — counted so the report can say so, and
    never rewritten: both are records of what was true at the time, one of them hash-chained."""
    events = (
        select(func.count()).select_from(IncidentEvent).where(cast(IncidentEvent.payload_json, Text).contains(str(oid)))
    )
    journal = select(func.count()).select_from(JournalEntry).where(cast(JournalEntry.row_json, Text).contains(str(oid)))
    return int((await db.execute(events)).scalar_one()), int((await db.execute(journal)).scalar_one())


async def _plan_merge(
    db: AsyncSession,
    survivor: ObjectSite,
    loser: ObjectSite,
    *,
    counts: dict[uuid.UUID | None, int],
    slots: dict[str, ReferenceDataset],
    scales: dict[str, object],
) -> MergePair:
    """Decide (and only decide) how the loser folds into the survivor.

    ``slots`` is the survivor's module → plan map, updated as moves are decided. A slot BOTH rows
    hold with different bytes is a conflict: two sheets somebody drew, and picking one is a
    decision a person makes.
    """
    pair = MergePair(
        survivor=survivor,
        loser=loser,
        survivor_plans=counts.get(survivor.id, 0),
        loser_plans=counts.get(loser.id, 0),
        source_key=loser.source_key if survivor.source_key is None else None,
    )
    taken_ids = set(
        (await db.execute(select(ReferenceDataset.id).where(ReferenceDataset.object_id == survivor.id))).scalars()
    )
    mine = list(
        (
            await db.execute(
                select(ReferenceDataset).where(ReferenceDataset.object_id == loser.id).order_by(ReferenceDataset.id)
            )
        ).scalars()
    )
    for ds in mine:
        module = ds.module or ""
        shown = module or "(no module)"
        # The dataset key is re-derived by swapping the id inside it, never rebuilt from parts:
        # a row whose key is not the usual `plan:<object>:<module>` still ends up addressed to
        # the survivor instead of to a string this function invented.
        target_id = ds.id.replace(str(loser.id), str(survivor.id))
        held = slots.get(module) if module else None
        if held is None and target_id not in taken_ids:
            pair.slots.append(SlotDecision(shown, ds.id, target_id, "move", target_id))
            if module:
                slots[module] = ds
            taken_ids.add(target_id)
            continue
        if held is None:
            pair.slots.append(
                SlotDecision(shown, ds.id, target_id, "conflict", f"{target_id} already exists on the survivor")
            )
            continue
        verdict = _same_bytes(held, ds)
        if verdict == "same":
            pair.slots.append(SlotDecision(shown, ds.id, target_id, "drop", "identical bytes on the survivor"))
        else:
            why = (
                "the survivor's sheet holds different bytes"
                if verdict == "differs"
                else "the two sheets could not be compared (blob unreadable)"
            )
            pair.slots.append(SlotDecision(shown, ds.id, target_id, "conflict", why))

    _, pair.scales_moved, pair.scales_kept = _retarget_scales(scales, loser.id, survivor.id)
    pair.incidents = await _incidents_naming(db, loser.id)
    pair.events, pair.journal = await _history_naming(db, loser.id)
    return pair


#: The sections of ``plan_scales_json`` that are keyed per SHEET (``object:<id>:plan:<module>``).
#: Mirrors api/plan_scales.PlanScales — a section added there and forgotten here is a station
#: calibration that survives the merge pointing at a deleted object.
SHEET_SECTIONS = ("byPlan", "georefByPlan", "measuredArByPlan")


def _retarget_scales(
    doc: dict[str, object], loser: uuid.UUID, survivor: uuid.UUID
) -> tuple[dict[str, object], list[str], list[str]]:
    """Move the station's per-sheet calibration and georeference onto the survivor's ids.

    Returns the new document plus the keys moved and the keys kept (the survivor already had that
    sheet — its own pairs stay, the twin's are reported and dropped rather than guessed at).
    """
    old_prefix, new_prefix = f"object:{loser}:plan:", f"object:{survivor}:plan:"
    moved: list[str] = []
    kept: list[str] = []
    out = dict(doc)
    for section_name in SHEET_SECTIONS:
        section = doc.get(section_name)
        if not isinstance(section, dict):
            continue  # a malformed document is served entry-wise too (api/plan_scales)
        rebuilt: dict[str, object] = {}
        for key, value in section.items():
            if not str(key).startswith(old_prefix):
                rebuilt[str(key)] = value
                continue
            target = new_prefix + str(key)[len(old_prefix) :]
            if target in section:
                kept.append(f"{section_name}/{target}")
                continue
            rebuilt[target] = value
            moved.append(f"{section_name}/{target}")
        out[section_name] = rebuilt
    return out, moved, kept


def _print_pair(pair: MergePair) -> None:
    """The diff for one survivor ← loser. Everything that moves, everything that does not."""
    print(f"  keep   {pair.survivor.id}  {_spelling(pair.survivor.name)}  ({pair.survivor_plans} plan(s))")
    print(f"  merge  {pair.loser.id}  {_spelling(pair.loser.name)}  ({pair.loser_plans} plan(s))")
    for slot in pair.slots:
        mark = {"move": "→", "drop": "·", "conflict": "!"}[slot.action]
        label = {"move": "moves", "drop": "dropped", "conflict": "CONFLICT"}[slot.action]
        print(f"       {mark} plan {slot.module}: {label} — {slot.why}")
    if pair.scales_moved or pair.scales_kept:
        print(
            f"       → plan-scales: {len(pair.scales_moved)} sheet calibration/georeference key(s) move"
            + (f", {len(pair.scales_kept)} kept (the survivor already has that sheet)" if pair.scales_kept else "")
        )
    if pair.incidents:
        print(f"       → incidents: {len(pair.incidents)} workspace(s) re-pointed (pickedObjectId)")
    if pair.events or pair.journal:
        print(
            f"       · history: {pair.events} audit event(s), {pair.journal} journal row(s) name the old id "
            "— left untouched (the audit chain is the record of what was true then)"
        )
    if pair.deletable:
        if pair.source_key:
            print(f"       → source_key {pair.source_key!r} passes to the survivor")
        print(f"       → object row {pair.loser.id} deleted")
    else:
        print(f"       ! object row {pair.loser.id} KEPT — {len(pair.conflicts)} conflict(s) still hang off it")


@dataclass
class Rekey:
    """One object's move onto another id, decided before anything is written."""

    row: ObjectSite
    target: uuid.UUID
    name: str  # the NFC-composed spelling the re-keyed row carries
    address: str | None = None  # the address the re-keyed row carries
    datasets: list[tuple[str, str]] = field(default_factory=list)  # (old key, new key)
    incidents: list[uuid.UUID] = field(default_factory=list)
    blocked: str | None = None  # set when something already sits on the target id


async def _plan_rekey(
    db: AsyncSession,
    row: ObjectSite,
    target: uuid.UUID,
    *,
    scales: dict[str, object],
    name: str | None = None,
    address: str | None = None,
) -> Rekey:
    """Decide an object's re-key onto ``target`` — the same move a merge loser makes, one row
    over. Used by the SharePoint pull to follow a renamed plans folder (sharepoint_sync ·
    _follow_renames), carried out by :func:`_apply_rekey`.

    Anything already sitting on the target id blocks the re-key rather than being merged into
    blind: that is a row keyed by a different name, and folding it is `merge`'s, by hand.
    """
    plan = Rekey(
        row=row,
        target=target,
        name=name if name is not None else unicodedata.normalize("NFC", row.name),
        address=address if address is not None else row.address,
    )
    if (await db.execute(select(ObjectSite.id).where(ObjectSite.id == target))).scalar_one_or_none() is not None:
        plan.blocked = f"an object already carries {target} — merge that one first"
        return plan
    own = set((await db.execute(select(ReferenceDataset.id).where(ReferenceDataset.object_id == row.id))).scalars())
    plan.datasets = sorted((did, did.replace(str(row.id), str(target))) for did in own)
    taken = (
        set(
            (
                await db.execute(
                    select(ReferenceDataset.id).where(ReferenceDataset.id.in_([n for _, n in plan.datasets]))
                )
            ).scalars()
        )
        - own
    )
    if taken:
        plan.blocked = f"{len(taken)} plan key(s) already exist under {target}, e.g. {sorted(taken)[0]}"
        return plan
    _, _, kept = _retarget_scales(scales, row.id, target)
    if kept:
        plan.blocked = f"{len(kept)} calibration key(s) already exist under {target}"
        return plan
    plan.incidents = await _incidents_naming(db, row.id)
    return plan


#: Everything that hangs off ONE plan dataset row, in the order a delete has to walk it. A plan
#: sheet is no longer a single row: `plan_revisions` keeps the exact bytes an Einsatz may have
#: pinned, and an alignment (plus its decision history) and a floor pack hang off a revision.
#: ⚠️ `plan_revisions.dataset_id` is ON DELETE RESTRICT and carries no ON UPDATE CASCADE, so a
#: dataset row that still has a revision can be neither deleted NOR re-keyed — without the two
#: helpers below, every merge that folds a REAL sheet aborts its whole transaction. That is not
#: theoretical: on the FWO deployment (16.09.2026) all 574 plan rows had a revision, and a
#: duplicate merge could not fold the one duplicate object on it.


async def _drop_plan_rows(db: AsyncSession, dataset_id: str) -> None:
    """Delete a plan dataset's revisions, alignments and floors — children before parents.

    The stored blobs stay, exactly like the dataset rows this module retires: a row that is
    redundant does not make its bytes redundant, and a plan the crew can still open is worth
    more than a clean bucket.
    """
    alignments = select(PlanAlignment.id).where(PlanAlignment.dataset_id == dataset_id)
    await db.execute(
        delete(PlanAlignmentEvent)
        .where(PlanAlignmentEvent.alignment_id.in_(alignments))
        .execution_options(synchronize_session=False)
    )
    for model in (PlanAlignment, PlanPageFloor, PlanRevision):
        await db.execute(
            delete(model).where(model.dataset_id == dataset_id).execution_options(synchronize_session=False)
        )


async def _rekey_dataset(db: AsyncSession, old_id: str, new_id: str, object_id: uuid.UUID) -> None:
    """Move a plan dataset — row, revisions, alignments, floors — onto a new dataset id. A job the
    alignment worker is running on it goes back to the queue, its attempt uncounted.

    ⚠️ Copied and dropped, never updated in place. `plan_revisions` is a CHILD of
    ``reference_datasets`` and the PARENT of ``plan_alignments`` / ``plan_page_floors``, and
    neither foreign key cascades an update, so there is no order in which a plain
    ``UPDATE … SET dataset_id`` satisfies both sides at once. The same reasoning
    :func:`_apply_rekey` gives for re-creating the object row, one level down.

    The column lists are read off the tables rather than spelled out: a column added to either
    model later follows the move on its own instead of being silently dropped here.
    """
    await _copy_row(db, ReferenceDataset, ReferenceDataset.id == old_id, {"id": new_id, "object_id": object_id})
    await _copy_row(db, PlanRevision, PlanRevision.dataset_id == old_id, {"dataset_id": new_id})
    for model in (PlanAlignment, PlanPageFloor):
        await db.execute(
            update(model)
            .where(model.dataset_id == old_id)
            .values(dataset_id=new_id)
            .execution_options(synchronize_session=False)
        )
    # A job the worker is running now can never be finished: its claim names the old dataset id
    # (plan_alignment_worker · finish_job). Back to the queue, and the attempt is not its fault.
    await db.execute(
        update(PlanAlignment)
        .where(PlanAlignment.dataset_id == new_id, PlanAlignment.status == "processing")
        .values(
            status="pending",
            claimed_at=None,
            attempts=PlanAlignment.attempts - 1,
            edit_version=PlanAlignment.edit_version + 1,
        )
        .execution_options(synchronize_session=False)
    )
    await db.execute(
        delete(PlanRevision).where(PlanRevision.dataset_id == old_id).execution_options(synchronize_session=False)
    )
    await db.execute(
        delete(ReferenceDataset).where(ReferenceDataset.id == old_id).execution_options(synchronize_session=False)
    )


async def _retarget_incident(db: AsyncSession, incident_id: uuid.UUID, old_id: uuid.UUID, new_id: uuid.UUID) -> None:
    """Point one incident's workspace blob from ``old_id`` at ``new_id`` — as a new REVISION.

    ⚠️ The blob used to be reassigned without touching ``workspace_rev`` (23.09.2026). The rev is
    the whole optimistic-concurrency contract of ``PUT …/workspace`` (``apply_workspace_put``: the
    save wins only while the rev still equals the client's ``base_rev``), so a tablet holding the
    pre-merge rev saved straight over the retargeted blob and put the dead object id back — and
    no follower ever re-read it, because nothing said it had changed. Bumping it turns that save
    into the ordinary 409, whose three-way merge keeps the retarget.

    Conditional on the rev it read, like the PUT: a save committing in between is re-read and
    retargeted, never overwritten. ``updated_at`` is left alone on purpose — «geändert nach
    Abschluss» is derived from it, and a maintenance fold is not a change to the Einsatz.
    """
    for _ in range(5):
        current = (
            await db.execute(
                select(Incident.map_workspace_json, Incident.workspace_rev).where(Incident.id == incident_id)
            )
        ).one_or_none()
        if current is None or not isinstance(current.map_workspace_json, dict):
            return
        new_doc, hits = _retarget_json(current.map_workspace_json, old_id, new_id)
        if not hits or not isinstance(new_doc, dict):
            return
        result = await execute_dml(
            db,
            update(Incident)
            .where(Incident.id == incident_id, Incident.workspace_rev == current.workspace_rev)
            .values(
                map_workspace_json=new_doc,
                workspace_rev=Incident.workspace_rev + 1,
                updated_at=Incident.updated_at,
            )
            .execution_options(synchronize_session=False),
        )
        if result.rowcount:
            return
    raise RuntimeError(f"incident {incident_id}: workspace kept changing under the merge — run it again")


async def _copy_row(db: AsyncSession, model: Any, where: Any, overrides: dict[str, Any]) -> None:
    """``INSERT … SELECT`` the matching rows back into their own table with some columns replaced."""
    table = model.__table__
    columns = [c.name for c in table.c]
    picked = [literal(overrides[name], table.c[name].type) if name in overrides else table.c[name] for name in columns]
    await db.execute(insert(table).from_select(columns, select(*picked).where(where)))


async def _move_object_links(db: AsyncSession, old_id: uuid.UUID, new_id: uuid.UUID) -> None:
    """Objektbesuche and outside ids follow an object that is re-keyed or merged away. Without
    this a visit's ``object_id`` would be nulled by the FK and its refs deleted with the row."""
    await db.execute(
        update(ObjectVisit)
        .where(ObjectVisit.object_id == old_id)
        .values(object_id=new_id)
        .execution_options(synchronize_session=False)
    )
    await db.execute(
        update(ObjectRef)
        .where(ObjectRef.object_id == old_id)
        .values(object_id=new_id)
        .execution_options(synchronize_session=False)
    )
    # the station's position history goes with the object (the FK would cascade it away)
    await db.execute(
        update(ObjectPositionEvent)
        .where(ObjectPositionEvent.object_id == old_id)
        .values(object_id=new_id)
        .execution_options(synchronize_session=False)
    )


def _carry_notes(survivor: ObjectSite, loser: ObjectSite) -> None:
    """A merge keeps the Gebäude card's Modul-1 notes (``measures``/``remarks`` + their source).

    The survivor's own win where it has them; an empty survivor takes the loser's. The pair is
    carried TOGETHER with its source, so a text never ends up labelled with the other row's
    «Quelle»: when neither note came over, the survivor's source stays as it was.
    """
    took = False
    for note in ("measures", "remarks"):
        if not getattr(survivor, note) and getattr(loser, note):
            setattr(survivor, note, getattr(loser, note))
            took = True
    if took and not survivor.measures_source and loser.measures_source:
        survivor.measures_source = loser.measures_source


async def _apply_rekey(db: AsyncSession, plan: Rekey) -> None:
    """Move an object onto the id a :func:`_plan_rekey` decided, in the caller's transaction.

    The row is re-created rather than updated in place: the plans reference ``objects.id`` and the
    FK has no ON UPDATE CASCADE, so a parent key cannot change while children point at it. Same
    order as a loser fold — new row, everything moved onto it, old row last.
    """
    old = plan.row
    source_key = old.source_key
    fresh = ObjectSite(
        id=plan.target,
        name=plan.name,
        address=plan.address,
        lat=old.lat,
        lng=old.lng,
        source_note=old.source_note,
        filing_folder=old.filing_folder,
        # the Gebäude card's Modul-1 notes are the object's, not the id's — a re-key keeps them
        measures=old.measures,
        remarks=old.remarks,
        measures_source=old.measures_source,
        # …and so are the station's «Lage korrigieren» answers and the town (review round 3: a
        # renamed SharePoint folder re-keys its object, and must not reset what the station set)
        locality=old.locality,
        position_source=old.position_source,
        position_set_at=old.position_set_at,
        outline=old.outline,
    )
    db.add(fresh)
    await db.flush()
    await _move_object_links(db, old.id, plan.target)
    for old_id, new_id in plan.datasets:
        await _rekey_dataset(db, old_id, new_id, plan.target)
    for incident_id in plan.incidents:
        await _retarget_incident(db, incident_id, old.id, plan.target)
    if source_key is not None:
        old.source_key = None  # UNIQUE — free it before the re-keyed row takes it
        await db.flush()
        fresh.source_key = source_key
    await db.execute(delete(ObjectSite).where(ObjectSite.id == old.id).execution_options(synchronize_session=False))


async def _apply_pair(db: AsyncSession, pair: MergePair) -> None:
    """Carry out one decided merge. Called only under ``--apply``, inside the one transaction."""
    for slot in pair.slots:
        if slot.action == "move":
            # Re-KEYED, not just re-pointed: the primary key encodes the object, and a row left
            # under the old key is a row the next `load` or pull would mint a second time.
            await _rekey_dataset(db, slot.dataset_id, slot.target_id, pair.survivor.id)
        elif slot.action == "drop":
            # The bytes stay in the store: the row is redundant, the blob may not be.
            await _drop_plan_rows(db, slot.dataset_id)
            await db.execute(
                delete(ReferenceDataset)
                .where(ReferenceDataset.id == slot.dataset_id)
                .execution_options(synchronize_session=False)
            )
    for incident_id in pair.incidents:
        await _retarget_incident(db, incident_id, pair.loser.id, pair.survivor.id)
    if pair.deletable:
        await _move_object_links(db, pair.loser.id, pair.survivor.id)
        if not pair.survivor.filing_folder and pair.loser.filing_folder:
            pair.survivor.filing_folder = pair.loser.filing_folder
        _carry_notes(pair.survivor, pair.loser)
        if pair.source_key:
            pair.loser.source_key = None  # source_key is UNIQUE — free it before the survivor takes it
            await db.flush()
            pair.survivor.source_key = pair.source_key
        await db.execute(
            delete(ObjectSite).where(ObjectSite.id == pair.loser.id).execution_options(synchronize_session=False)
        )


# --- maintenance: one named twin onto another --------------------------------------------
#
# A twin under ANOTHER name needs a person to say which two rows are one object (review round 3,
# 17.10.2026: «Stallenmattstrasse 2-14, Kaibmattweg 1-5 (EH)», a plan-less row, is the plan
# library's «Stallenmattstrasse 1-14 …» — owner: «merge number 2 onto 1 and drop 2»).
# `merge <loser> --into <survivor>` is that: plans, calibration, incidents, visits, outside ids,
# notes and folder move over (:func:`_plan_merge` / :func:`_apply_pair`), plus what a hand-picked
# twin also carries:
#
#   object_position_events         the station's «Lage korrigieren» history of the loser — moved
#                                  onto the survivor as history; the survivor's own position and
#                                  outline choice are never changed by a merge.
#   the loser's name and folder    kept on the survivor as aliases (object_visits · ALIAS_SOURCE):
#                                  the viewer's search still finds the old name, and an organizer
#                                  push under that folder/name resolves to the survivor instead of
#                                  minting the twin again.
#
# `twins` lists likely candidates — a plan-less object whose derived buildings (or whose point)
# lie in another object's — and writes nothing.


async def _merge_into(loser_id: uuid.UUID, survivor_id: uuid.UUID, *, apply: bool) -> int:
    """Fold one object into another — REPORT ONLY unless ``apply`` (one transaction)."""
    from .object_visits import ALIAS_SOURCE, aliases_by_object

    if loser_id == survivor_id:
        fail("merge: the two ids are the same object")
    async with async_session_maker() as db:
        if apply:
            # lock 1 of `plans` › the lock order: a SharePoint run holds plan rows and waits for the
            # config row, this holds the config row and needs plan rows – one waits for the other
            await lock_plan_maintenance(db)
            # locks 3 and 3b before the rows are read, so the fold copies what is there now; the
            # loser's row FOR UPDATE because the fold deletes it
            await lock_object_plans(db, loser_id, survivor_id)
            await lock_object_rows(db, loser_id)
        loser = await db.get(ObjectSite, loser_id)
        survivor = await db.get(ObjectSite, survivor_id)
        if loser is None or survivor is None:
            fail(f"merge: no object {loser_id if loser is None else survivor_id}")
            return 1
        counts = await _plan_counts(db)
        # `--apply` read-modify-writes `plan_scales_json`, so it holds the row FOR UPDATE from here
        # to its commit. A dry run writes nothing and takes no lock.
        station = await config_row(db, lock=apply)
        scales: dict[str, object] = dict(station.plan_scales_json or {})
        slots: dict[str, ReferenceDataset] = {
            ds.module: ds
            for ds in (
                await db.execute(select(ReferenceDataset).where(ReferenceDataset.object_id == survivor.id))
            ).scalars()
            if ds.module
        }
        refs = list((await db.execute(select(ObjectRef).where(ObjectRef.object_id == loser.id))).scalars())
        visits = int(
            (
                await db.execute(select(func.count()).select_from(ObjectVisit).where(ObjectVisit.object_id == loser.id))
            ).scalar_one()
        )
        moves = int(
            (
                await db.execute(
                    select(func.count())
                    .select_from(ObjectPositionEvent)
                    .where(ObjectPositionEvent.object_id == loser.id)
                )
            ).scalar_one()
        )
        have = {a.casefold() for a in (await aliases_by_object(db)).get(survivor.id, [])}
        have |= {(survivor.name or "").casefold(), (survivor.filing_folder or "").strip().casefold()}
        aliases: list[str] = []
        for alias in (loser.name, (loser.filing_folder or "").strip()):
            if alias and alias.casefold() not in have and alias.casefold() not in {a.casefold() for a in aliases}:
                aliases.append(alias)

        print(f"\nmerge {loser.id} → {survivor.id}")
        print(f"  the loser:    {_spelling(loser.name)}")
        print(f"                created by: {loser.source_note or '(no source note)'}")
        print(
            f"                address {loser.address!r} · folder {loser.filing_folder!r} · source_key {loser.source_key!r}"
        )
        print(f"                outside ids: {', '.join(f'{r.source}:{r.external_id}' for r in refs) or 'none'}")
        print(f"  the survivor: {_spelling(survivor.name)} (keeps its name, position and outline choice)")
        pair = await _plan_merge(db, survivor, loser, counts=counts, slots=slots, scales=scales)
        _print_pair(pair)
        if pair.deletable:
            print(f"       → {visits} Objektbesuch(e) and {len(refs)} outside id(s) move to the survivor")
            print(f"       → {moves} position correction(s) move to the survivor's history")
            for alias in aliases:
                print(f"       → alias {alias!r} on the survivor (search; an organizer push under it resolves there)")
        if not apply:
            print("\nOK (dry-run): nothing written. Repeat with --apply to perform it.")
            return 0
        if not pair.deletable:
            print("\nINCOMPLETE: conflicting sheets keep the loser — decide those by hand, nothing written.")
            await db.rollback()
            return 1
        await _apply_pair(db, pair)  # position history included (_move_object_links)
        for alias in aliases:
            taken = (
                await db.execute(
                    select(ObjectRef).where(ObjectRef.source == ALIAS_SOURCE, ObjectRef.external_id == alias)
                )
            ).scalar_one_or_none()
            if taken is None:
                db.add(ObjectRef(object_id=survivor.id, source=ALIAS_SOURCE, external_id=alias))
            elif taken.object_id != survivor.id:
                taken.object_id = survivor.id
        scales, _, _ = _retarget_scales(scales, loser.id, survivor.id)
        if scales != (station.plan_scales_json or {}):
            station.plan_scales_json = scales
        await db.commit()
        print(f"\nOK: {loser.id} merged into {survivor.id} and deleted.")
        return 0


def _ring_keys(footprint: dict | None) -> set[tuple[tuple[float, float], ...]]:
    """A stored footprint's buildings as comparable keys (the survey's own vertices, rounded)."""
    out: set[tuple[tuple[float, float], ...]] = set()
    for poly in (footprint or {}).get("coordinates") or []:
        if poly and poly[0]:
            out.add(tuple(sorted((round(p[0], 6), round(p[1], 6)) for p in poly[0])))
    return out


async def _report_twins() -> int:
    """Likely twins — REPORT ONLY: a plan-less object whose derived buildings mostly coincide
    with another object's (or whose point lies in one of them). Prints the `merge` dry-run
    command for each; deciding which row survives stays a person's call."""
    from . import object_footprints
    from .object_footprints import _in_ring

    async with async_session_maker() as db:
        rows = list((await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars())
        counts = await _plan_counts(db)
    stored = object_footprints.stored()
    fp: dict[uuid.UUID, dict | None] = {}
    for o in rows:
        lat = float(o.lat) if o.lat is not None else None
        lng = float(o.lng) if o.lng is not None else None
        fp[o.id] = object_footprints.footprint_for(str(o.id), lat, lng) if str(o.id) in stored else None
    found = 0
    for a in rows:
        if counts.get(a.id, 0):
            continue  # only a plan-less row is a candidate loser
        mine = _ring_keys(fp[a.id])
        for b in rows:
            if b.id == a.id:
                continue
            theirs = _ring_keys(fp[b.id])
            share = len(mine & theirs) / len(mine) if mine else 0.0
            inside = (
                not mine
                and a.lat is not None
                and a.lng is not None
                and any(
                    _in_ring([(p[0], p[1]) for p in poly[0]], (float(a.lng), float(a.lat)))
                    for poly in (fp[b.id] or {}).get("coordinates") or []
                )
            )
            if share < 0.5 and not inside:
                continue
            found += 1
            why = (
                f"{share:.0%} of its {len(mine)} building(s) are the other's"
                if mine
                else "its point is in the other's building"
            )
            print(f"\n{_spelling(a.name)} (no plans) ↔ {_spelling(b.name)} ({counts.get(b.id, 0)} plan(s)) — {why}")
            print(f"  dry run: uv run python -m app.admin_objects_repair merge {a.id} --into {b.id}")
    print(
        f"\n{found} likely twin(s) among {len(rows)} object(s). Nothing written — `merge` decides one pair at a time."
    )
    return 0


# --- maintenance: objects without coordinates --------------------------------------------


async def _lookup_coordinates(address: str) -> tuple[float, float] | None:
    """Best-effort position for `geocode-missing`. Never raises: an object swisstopo cannot be
    reached for stays on the census at the end, like one it found nothing for.

    ⚠️ `locate`, not `geocode`: only an EXACT street + number in the brigade's area, home town
    first — never the fuzzy neighbour `geocode` would answer with (ARA Birsig, 17.10.2026: an
    «Erlenstrasse 60» without its town landed on «Vorderbergstrasse 60» in the home town). An
    address found in several towns stays without a position, for the station to set."""
    try:
        return await locate_coordinates(address)
    except Exception as e:  # noqa: BLE001 — best-effort by contract
        print(f"  ? geocoding {address!r} failed ({type(e).__name__}: {e}) — left without coordinates", file=sys.stderr)
        return None


async def _coordinate_census(db: AsyncSession, resolved: set[uuid.UUID]) -> int:
    """Print the Einsatzobjekte that carry plans and no coordinates, and count them.

    An object without coordinates is surfaced at no incident (:func:`objects_without_coordinates`).
    ``resolved`` are the ids a dry run WOULD take off this list; under ``--apply`` it is empty,
    because by then the list is read back from what was actually written — which is what makes a
    second ``geocode-missing`` (dry-run, read-only) the way to verify the first.
    """
    blind = [o for o in await objects_without_coordinates(db) if o.id not in resolved]
    total = int((await db.execute(select(func.count()).select_from(ObjectSite))).scalar_one())
    if not blind:
        print(f"\n{total} Einsatzobjekt(e) stored; every one that carries plans has coordinates.")
        return 0
    print(f"\n{total} Einsatzobjekt(e) stored, {len(blind)} of them carry plans and NO coordinates —")
    print("their plans surface at no incident until somebody geocodes them (/admin › Objektpläne):")
    for o in blind:
        print(f"  · {o.id}  «{unicodedata.normalize('NFC', o.name)}» — address {o.address or '(none)'}")
    return len(blind)


async def _geocode_missing(*, apply: bool) -> int:
    """Give every plan-carrying Einsatzobjekt without a position one — REPORT ONLY unless ``apply``.

    Still needed today: the SharePoint pull geocodes a new object best-effort and leaves it without
    a position when the lookup fails or is ambiguous. On 11.09.2026 the FWO deployment carried 52
    objects the ORIGINAL importer had written without coordinates, and an object without them is
    offered at no incident (:func:`objects_without_coordinates`) — its plans are reachable by
    nobody, however correct its key is.

    What is geocoded is the ``address`` where the row has one, and otherwise the ``name``. That
    is not a fallback for its own sake: those 52 rows ARE addresses — «Benkenstrasse 66a» stands
    in the name column because the import that wrote them never split the folder — and
    `geocode.locate` takes only an EXACT street + number inside the brigade's area, home town
    first, so a bare street number resolves in the brigade's own villages and never onto a fuzzy
    neighbour; one several towns of the area share is left for the station. An object whose name is not an address simply finds nothing and stays on the
    list; nothing is invented for it.

    Never overwrites a position the station already has: the query only ever returns rows that
    have none.
    """
    async with async_session_maker() as db:
        blind = await objects_without_coordinates(db)
        if not blind:
            print("Every Einsatzobjekt that carries plans already has coordinates. Nothing to geocode.")
            await _coordinate_census(db, set())
            return 0

        print(f"{len(blind)} Einsatzobjekt(e) carry plans and no coordinates:")
        found: dict[uuid.UUID, tuple[float, float]] = {}
        for obj in blind:
            name = unicodedata.normalize("NFC", obj.name)
            query = (obj.address or "").strip() or name.strip()
            # Said out loud, because it is the one judgement call in here: a row with no address
            # is being looked up under its NAME, and the operator has to be able to see that.
            source = "address" if (obj.address or "").strip() else "name"
            coords = await _lookup_coordinates(query)
            if coords is None:
                print(f"  ? {obj.id}  «{name}» — nothing found for {query!r} (its {source})")
                continue
            print(f"  → {obj.id}  «{name}» — {query!r} (its {source}) → {coords[0]:.5f}, {coords[1]:.5f}")
            found[obj.id] = coords
            if apply:
                obj.lat, obj.lng = coords

        summary = f"{len(found)} of {len(blind)} object(s) geocoded, {len(blind) - len(found)} still without a position"
        if not apply:
            print(f"\nOK (dry-run): would be {summary}. Nothing written. Repeat with --apply to perform it.")
            await _coordinate_census(db, set(found))
            return 0
        await db.commit()
        print(f"\nOK: {summary}.")
        # Read back from what was WRITTEN, so a second (read-only) run is the verification.
        await _coordinate_census(db, set())
        return 0


# --- CLI --------------------------------------------------------------------------------


async def _amain(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.admin_objects_repair",
        description="Repair a deployment's Einsatzobjekte: merge a twin, list likely twins, geocode.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_into = sub.add_parser(
        "merge",
        help="fold ONE object into another (a twin under another name): plans, visits, outside ids, "
        "position history; the loser's name stays as an alias on the survivor",
    )
    p_into.add_argument("loser", type=uuid.UUID, help="the object that goes away")
    p_into.add_argument("--into", dest="survivor", type=uuid.UUID, required=True, help="the object that stays")
    p_into.add_argument("--apply", action="store_true", help="perform the merge (default: report only, no writes)")
    sub.add_parser(
        "twins",
        help="list likely twins: a plan-less object whose derived buildings are another's (report only)",
    )
    p_geo = sub.add_parser(
        "geocode-missing",
        help="geocode every object that carries plans and has no coordinates (by its address, or "
        "by its name when it has none) — without them an object surfaces at no incident",
    )
    p_geo.add_argument("--apply", action="store_true", help="write the coordinates (default: report only, no writes)")

    args = parser.parse_args(argv)

    if args.cmd == "merge":
        return await _merge_into(args.loser, args.survivor, apply=args.apply)
    if args.cmd == "twins":
        return await _report_twins()
    # geocode-missing
    return await _geocode_missing(apply=args.apply)


def main() -> None:
    sys.exit(asyncio.run(_amain(sys.argv[1:])))


if __name__ == "__main__":
    main()

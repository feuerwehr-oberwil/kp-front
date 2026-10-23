"""Admin CLI: one-off repairs of a station's Einsatzobjekte table (moved out of admin_objects,
sweep A.19, 23.10.2026 – that module keeps the load/push pipeline every station runs weekly).

Most of this was written on 11.09.2026 for twins minted before that date (a Mac-run import's
NFD names, the SharePoint pull's whole-folder keys); once a station's census is clean it is not
needed again. Run from ``backend/`` via ``uv run python -m app.admin_objects_repair <cmd>``, against
whatever ``DATABASE_URL`` points at (docs/AGENT-RUNBOOK.md › Einsatzobjekte).

    merge-duplicates       fold objects whose names differ only in Unicode form into one, onto the
                           id every future import mints for that name (report only)
    merge <loser> --into <survivor>
                           fold one twin under ANOTHER name into an object (report only)
    twins                  list likely twins: a plan-less object whose buildings are another's
    repair-sharepoint-keys fold what the SharePoint pull minted under the WHOLE folder name onto
                           the «Adresse - Name» convention, geocoding what it splits out, and list
                           every object that still has no coordinates (report only)
    geocode-missing        look up a position for every object that carries plans and has none —
                           by its address, or by its name when the row has no address (report only)
    remove-empty           delete objects that carry no plans and nothing points at (report only)

`merge-duplicates`, `merge`, `repair-sharepoint-keys`, `geocode-missing` and `remove-empty` REPORT by
default and write only with ``--apply`` — see :func:`_merge_duplicates`,
:func:`_repair_sharepoint_keys` and :func:`_geocode_missing`. The last two end with the same
census, which is the read-only way to CHECK a deployment: every Einsatzobjekt that carries plans
but no coordinates, and so surfaces at no incident whatever its plans say.
"""

import argparse
import asyncio
import hashlib
import sys
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import UTC
from typing import Any, Literal

from sqlalchemy import Text, cast, delete, func, insert, literal, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from . import storage
from .admin_cli import fail
from .admin_objects import FolderIdentity, _plan_counts, folder_identity, object_id_for_key, objects_without_coordinates
from .database import async_session_maker, execute_dml
from .geocode import locate_coordinates
from .models import (
    DeploymentConfig,
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

# --- maintenance: duplicate merge + junk removal -----------------------------------------
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


def _name_key(name: str) -> str:
    """The string :func:`object_id_for_key` would hash for this name — NFC-composed first.

    Two folder names that look identical on screen hash to two different ids when one spells «ü»
    as ``u`` + U+0308 and the other as U+00FC: that is the 195-objects-for-157 split on the FWO
    deployment, minted by an import that read the names off a Mac filesystem. Composing before
    normalising is what puts both spellings in one group here.
    """
    return " ".join(unicodedata.normalize("NFC", name).split()).casefold()


def _spelling(name: str) -> str:
    """A name as the diff prints it: with its Unicode form and non-ASCII codepoints when it has
    any — the whole difficulty of this merge is that the two spellings look the same."""
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


def _when(ds: ReferenceDataset) -> str:
    """A plan row's write date as the report prints it — the operator's way of telling the two
    copies of a sheet apart at a glance."""
    return ds.updated_at.strftime("%d.%m.%Y %H:%M") if ds.updated_at else "undated"


def _stamp(ds: ReferenceDataset) -> tuple[float, int]:
    """How recent a plan row is: when it was last written, then its version counter.

    ⚠️ A naive `updated_at` is read as UTC rather than compared raw — SQLite hands back naive
    datetimes where Postgres hands back aware ones, and comparing the two raises.
    """
    at = ds.updated_at
    if at is None:
        return (0.0, ds.current_version or 0)
    return ((at if at.tzinfo else at.replace(tzinfo=UTC)).timestamp(), ds.current_version or 0)


@dataclass
class SlotDecision:
    """What happens to one of the loser's plan rows."""

    module: str
    dataset_id: str
    target_id: str  # the key it moves to — decided here, so the apply invents nothing
    #: `replace` only exists where the two rows are the same sheet under two conventions
    #: (`repair-sharepoint-keys`): the survivor's row goes and the loser's takes its key.
    action: Literal["move", "drop", "conflict", "replace"]
    why: str
    #: The survivor row `replace` deletes — carried so the apply re-reads nothing.
    replaces: str | None = None


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
    newest_wins: bool = False,
) -> MergePair:
    """Decide (and only decide) how the loser folds into the survivor.

    ``slots`` is the survivor's module → plan map, carried across the whole group and updated as
    moves are decided, so a third twin sees what the second one already handed over — in a dry
    run exactly as in a real one.

    ``newest_wins`` decides the one case the two callers disagree on: a slot BOTH rows hold with
    different bytes. For a duplicate name that is a genuine conflict — two sheets somebody drew,
    and picking one is a decision a person makes. For the two-conventions repair it is the same
    sheet pulled twice, so the more recently written row is simply the current one and the other
    is a superseded copy (that is the whole defect: the pull kept updating the copy nobody could
    see, so the SharePoint side is normally the newer).
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
        elif not newest_wins:
            why = (
                "the survivor's sheet holds different bytes"
                if verdict == "differs"
                else "the two sheets could not be compared (blob unreadable)"
            )
            pair.slots.append(SlotDecision(shown, ds.id, target_id, "conflict", why))
        elif _stamp(ds) > _stamp(held):
            pair.slots.append(
                SlotDecision(
                    shown,
                    ds.id,
                    held.id,
                    "replace",
                    f"v{ds.current_version} ({_when(ds)}, {ds.source_type}) is newer than the survivor's "
                    f"v{held.current_version} ({_when(held)}, {held.source_type})",
                    replaces=held.id,
                )
            )
            slots[module] = ds
        else:
            pair.slots.append(
                SlotDecision(
                    shown,
                    ds.id,
                    target_id,
                    "drop",
                    f"the survivor's v{held.current_version} ({_when(held)}) is the newer sheet",
                )
            )

    _, pair.scales_moved, pair.scales_kept = _retarget_scales(scales, loser.id, survivor.id)
    pair.incidents = await _incidents_naming(db, loser.id)
    pair.events, pair.journal = await _history_naming(db, loser.id)
    return pair


#: The sections of ``plan_scales_json`` that are keyed per SHEET (``object:<id>:plan:<module>``).
#: Mirrors api/plan_scales.PlanScales — a section added there and forgotten here is a station
#: calibration that survives the merge pointing at a deleted object.
SHEET_SECTIONS = ("byPlan", "georefByPlan", "measuredArByPlan")


def _scale_keys_for(doc: dict[str, object], oid: uuid.UUID) -> list[str]:
    """The station calibration/georeference keys that belong to one object."""
    prefix = f"object:{oid}:plan:"
    found: list[str] = []
    for section_name in SHEET_SECTIONS:
        section = doc.get(section_name)
        if isinstance(section, dict):
            found += [f"{section_name}/{k}" for k in section if str(k).startswith(prefix)]
    return found


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
        mark = {"move": "→", "drop": "·", "conflict": "!", "replace": "→"}[slot.action]
        label = {
            "move": "moves",
            "drop": "dropped",
            "conflict": "CONFLICT",
            "replace": "replaces the survivor's sheet",
        }[slot.action]
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


def _pick_survivor(group: list[ObjectSite], counts: dict[uuid.UUID | None, int]) -> tuple[ObjectSite, uuid.UUID | None]:
    """The row the others fold into, and the NFC-key id it still has to be re-keyed to (or None).

    The uuid5 of the NFC-composed name is the id every future import mints — the SharePoint pull
    matches and creates objects with exactly it (``sharepoint_sync._object_for``). A row carrying
    it is the obvious survivor. When NO row carries it (both spellings were keyed by something
    other than the bare name — 27 of 79 groups on the FWO deployment) the richest row wins (most
    plans, then most recently updated, then lowest id, so two runs agree) and the caller re-keys
    it afterwards: leaving it under its own id would let the next sync mint a THIRD row.
    """
    try:
        canonical = object_id_for_key(_name_key(group[0].name))
    except ValueError:  # a blank name hashes to nothing; the richest row still wins, un-re-keyed
        canonical = None
    for o in group:
        if o.id == canonical:
            return o, None
    richest = sorted(
        group,
        key=lambda o: (-counts.get(o.id, 0), -(o.updated_at.timestamp() if o.updated_at else 0.0), str(o.id)),
    )[0]
    return richest, canonical


@dataclass
class Rekey:
    """The survivor's own move onto the NFC-key id, decided before anything is written."""

    row: ObjectSite
    target: uuid.UUID
    name: str  # the NFC-composed spelling the re-keyed row carries
    #: The address the re-keyed row carries. The repair splits one out of «Adresse - Name»; the
    #: duplicate merge keeps whatever the row had.
    address: str | None = None
    #: Coordinates geocoded for a row that had none — set by the repair, never overwriting a
    #: pair the station already has.
    coords: tuple[float, float] | None = None
    datasets: list[tuple[str, str]] = field(default_factory=list)  # (old key, new key)
    scales_moved: list[str] = field(default_factory=list)
    incidents: list[uuid.UUID] = field(default_factory=list)
    events: int = 0
    journal: int = 0
    blocked: str | None = None  # set when something already sits on the target id


async def _plan_rekey(
    db: AsyncSession,
    row: ObjectSite,
    target: uuid.UUID,
    *,
    also: list[uuid.UUID],
    moved_datasets: list[str],
    scales: dict[str, object],
    name: str | None = None,
    address: str | None = None,
    coords: tuple[float, float] | None = None,
) -> Rekey:
    """Decide the survivor's re-key onto ``target`` — the same move a loser makes, one row over.

    ``also`` are the ids folded into this survivor a moment ago: in a dry run their workspaces
    still name the loser, so the incidents that need rewriting are the union. ``moved_datasets``
    are the plan keys that same fold hands over, which a dry run cannot yet read back from the DB.

    Anything already sitting on the target id blocks the re-key rather than being merged into
    blind: the group scan is one transaction, so this can only be a row keyed by a different name.
    """
    plan = Rekey(
        row=row,
        target=target,
        name=name if name is not None else unicodedata.normalize("NFC", row.name),
        address=address if address is not None else row.address,
        coords=coords,
    )
    if (await db.execute(select(ObjectSite.id).where(ObjectSite.id == target))).scalar_one_or_none() is not None:
        plan.blocked = f"an object already carries {target} — merge that one first"
        return plan
    own = set(
        (await db.execute(select(ReferenceDataset.id).where(ReferenceDataset.object_id == row.id))).scalars()
    ) | set(moved_datasets)
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
    _, plan.scales_moved, kept = _retarget_scales(scales, row.id, target)
    if kept:
        plan.blocked = f"{len(kept)} calibration key(s) already exist under {target}"
        return plan
    for oid in [row.id, *also]:
        plan.incidents += [i for i in await _incidents_naming(db, oid) if i not in plan.incidents]
    plan.events, plan.journal = await _history_naming(db, row.id)
    return plan


def _print_rekey(plan: Rekey) -> None:
    if plan.blocked:
        print(f"  ! rekey {plan.row.id} → {plan.target} REFUSED: {plan.blocked}")
        return
    bits = [f"{len(plan.datasets)} plan(s)"]
    if plan.name != plan.row.name or plan.address != plan.row.address:
        bits.append(f"name «{plan.name}», address «{plan.address or '—'}»")
    if plan.coords:
        bits.append(f"geocoded to {plan.coords[0]:.5f}, {plan.coords[1]:.5f}")
    if plan.scales_moved:
        bits.append(f"{len(plan.scales_moved)} calibration key(s)")
    if plan.incidents:
        bits.append(f"{len(plan.incidents)} workspace(s)")
    if plan.events or plan.journal:
        bits.append(f"{plan.events + plan.journal} history row(s) named, left untouched")
    print(f"  rekey  {plan.row.id} → {plan.target}  ({', '.join(bits)})")


#: Everything that hangs off ONE plan dataset row, in the order a delete has to walk it. A plan
#: sheet is no longer a single row: `plan_revisions` keeps the exact bytes an Einsatz may have
#: pinned, and an alignment (plus its decision history) and a floor pack hang off a revision.
#: ⚠️ `plan_revisions.dataset_id` is ON DELETE RESTRICT and carries no ON UPDATE CASCADE, so a
#: dataset row that still has a revision can be neither deleted NOR re-keyed — without the two
#: helpers below, every merge that folds a REAL sheet aborts its whole transaction. That is not
#: theoretical: on the FWO deployment (16.09.2026) all 574 plan rows had a revision, and
#: `merge-duplicates --apply` could not fold the one duplicate object on it.


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
    """Move a plan dataset — row, revisions, alignments, floors — onto a new dataset id.

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
    """Move the survivor itself onto the NFC-key id. Only under ``--apply``, same transaction.

    The row is re-created rather than updated in place: the plans reference ``objects.id`` and the
    FK has no ON UPDATE CASCADE, so a parent key cannot change while children point at it. Same
    order as a loser fold — new row, everything moved onto it, old row last.
    """
    old = plan.row
    source_key = old.source_key
    lat, lng = (old.lat, old.lng) if old.lat is not None and old.lng is not None else (plan.coords or (None, None))
    fresh = ObjectSite(
        id=plan.target,
        name=plan.name,
        address=plan.address,
        lat=lat,
        lng=lng,
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
        if slot.action == "replace":
            # The superseded row goes FIRST — its id is the key the newer row is about to take.
            # Its blob stays in the store, like every other row this module retires.
            assert slot.replaces is not None  # noqa: S101 — a "replace" decision always names the row it takes over
            await _drop_plan_rows(db, slot.replaces)
            await db.execute(
                delete(ReferenceDataset)
                .where(ReferenceDataset.id == slot.replaces)
                .execution_options(synchronize_session=False)
            )
            await _rekey_dataset(db, slot.dataset_id, slot.target_id, pair.survivor.id)
        elif slot.action == "move":
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


async def _merge_duplicates(*, apply: bool) -> int:
    """Fold objects whose names are the same name into one row — REPORT ONLY unless ``apply``.

    Duplicates are grouped by the string :func:`object_id_for_key` hashes (NFC-composed, whitespace
    collapsed, case folded), so an NFD/NFC twin pair and a byte-identical pair are the same case
    here. A plan slot the survivor already holds is never overwritten: identical bytes let the
    duplicate row go, anything else is reported as a conflict and the loser row stays whole.

    A group that folds completely also ends up ON the NFC-key id: where no row carried it, the
    survivor is re-keyed onto it once the losers are in (:func:`_apply_rekey`). That id is what
    the SharePoint pull and every future import mint for this name, so a merge that skipped it
    would be undone by the next sync — a third row under the same name. A group kept back by a
    conflict is NOT re-keyed: half a merge on a new id is worse than none.

    Under ``--apply`` the whole run is ONE transaction: either every group folds or none does. A
    sheet that moves or goes takes its revisions, alignments and floor packs with it — see the
    note above :func:`_drop_plan_rows` for why nothing here may touch a dataset row on its own.

    ⚠️ Writes ``plan_scales_json`` directly, outside the If-Match guard a human write gets
    (api/plan_scales). Run it in a maintenance window, not while an Einsatz is being drawn on.
    """
    async with async_session_maker() as db:
        rows = list((await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars())
        counts = await _plan_counts(db)
        groups: dict[str, list[ObjectSite]] = {}
        for row in rows:
            groups.setdefault(_name_key(row.name), []).append(row)
        duplicates = {k: v for k, v in sorted(groups.items()) if len(v) > 1}
        if not duplicates:
            print(f"No duplicate object names among {len(rows)} object(s). Nothing to merge.")
            return 0

        station = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        scales: dict[str, object] = dict(station.plan_scales_json) if station and station.plan_scales_json else {}
        pairs: list[MergePair] = []
        rekeys: list[Rekey] = []
        unfinished = 0  # groups whose conflicts keep the survivor on its old, non-NFC id
        for group in duplicates.values():
            survivor, rekey_to = _pick_survivor(group, counts)
            note = (
                "the survivor carries the NFC-key id"
                if rekey_to is None
                else f"no row carries the NFC-key id — the richest is re-keyed to {rekey_to}"
            )
            print(f"\n«{unicodedata.normalize('NFC', survivor.name)}» — {len(group)} rows ({note})")
            slots: dict[str, ReferenceDataset] = {
                ds.module: ds
                for ds in (
                    await db.execute(select(ReferenceDataset).where(ReferenceDataset.object_id == survivor.id))
                ).scalars()
                if ds.module
            }
            folded: list[MergePair] = []
            for loser in [o for o in group if o.id != survivor.id]:
                pair = await _plan_merge(db, survivor, loser, counts=counts, slots=slots, scales=scales)
                _print_pair(pair)
                scales, _, _ = _retarget_scales(scales, loser.id, survivor.id)
                folded.append(pair)
                pairs.append(pair)
                if apply:
                    await _apply_pair(db, pair)
            if rekey_to is None:
                continue
            if not all(p.deletable for p in folded):
                # Half a merge re-keyed is worse than none: the conflicting twin would stay behind
                # under a spelling the pull no longer resolves to anything.
                print(
                    f"       ! rekey {survivor.id} → {rekey_to} NOT done — this group did not fold; "
                    "a later import under the NFC spelling would mint a THIRD row"
                )
                unfinished += 1
                continue
            if apply:
                await db.flush()  # the folds above must be readable by the scan below
            rekey = await _plan_rekey(
                db,
                survivor,
                rekey_to,
                also=[p.loser.id for p in folded],
                moved_datasets=[s.target_id for p in folded for s in p.slots if s.action == "move"],
                scales=scales,
            )
            _print_rekey(rekey)
            rekeys.append(rekey)
            if rekey.blocked is None:
                scales, _, _ = _retarget_scales(scales, survivor.id, rekey_to)
                if apply:
                    await _apply_rekey(db, rekey)

        moved = sum(1 for p in pairs for s in p.slots if s.action == "move")
        dropped = sum(1 for p in pairs for s in p.slots if s.action == "drop")
        conflicts = sum(len(p.conflicts) for p in pairs)
        deletions = sum(1 for p in pairs if p.deletable)
        rekeyed = sum(1 for r in rekeys if r.blocked is None)
        refused = len(rekeys) - rekeyed
        summary = (
            f"{len(pairs)} merge(s) in {len(duplicates)} name group(s): {deletions} object row(s) deleted, "
            f"{len(pairs) - deletions} kept for conflicts, {moved} plan(s) re-pointed, "
            f"{dropped} duplicate plan row(s) dropped, {conflicts} conflict(s), "
            f"{rekeyed} survivor(s) re-keyed to the NFC id"
            + (f", {refused} re-key(s) refused" if refused else "")
            + (f", {unfinished} re-key(s) left undone by conflicts" if unfinished else "")
        )
        if not apply:
            print(f"\nOK (dry-run): would be {summary}. Nothing written. Repeat with --apply to perform it.")
            return 0
        if station is not None and scales != (station.plan_scales_json or {}):
            station.plan_scales_json = scales
        await db.commit()
        incomplete = bool(conflicts or refused)
        print(f"\n{'INCOMPLETE' if incomplete else 'OK'}: {summary}.")
        if conflicts:
            print("       The conflicting sheets are still on their old object — decide those by hand.")
        if refused:
            print("       A refused re-key leaves that survivor on its old id — the next sync would mint a third.")
        return 1 if incomplete else 0


# --- maintenance: one named twin onto another --------------------------------------------
#
# `merge-duplicates` folds rows whose NAMES are the same name. A twin under ANOTHER name needs a
# person to say which two rows are one object (review round 3, 17.10.2026: «Stallenmattstrasse
# 2-14, Kaibmattweg 1-5 (EH)», a plan-less row, is the plan library's «Stallenmattstrasse 1-14 …»
# — owner: «merge number 2 onto 1 and drop 2»). `merge <loser> --into <survivor>` is that, with
# the same planning and apply as the name merge (plans, calibration, incidents, visits, outside
# ids, notes, folder), plus what a hand-picked twin also carries:
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
        loser = await db.get(ObjectSite, loser_id)
        survivor = await db.get(ObjectSite, survivor_id)
        if loser is None or survivor is None:
            fail(f"merge: no object {loser_id if loser is None else survivor_id}")
            return 1
        counts = await _plan_counts(db)
        station = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        scales: dict[str, object] = dict(station.plan_scales_json) if station and station.plan_scales_json else {}
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
        if station is not None and scales != (station.plan_scales_json or {}):
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


# --- maintenance: the two object-key conventions -----------------------------------------


def _whole_folder_keyed(row: ObjectSite) -> FolderIdentity | None:
    """The folder identity of an object keyed on the WHOLE «Adresse - Name» string, or None.

    Exact rather than heuristic, because it decides what gets merged: the row's id IS the uuid5
    of its own entire name, and that name carries the address separator. An object the importer
    wrote is keyed on the NAME half and never matches; one typed in the browser is keyed on
    whatever the operator typed, which is not a folder name with an address in front of it.
    """
    identity = folder_identity(row.name)
    if identity.address is None:
        return None
    try:
        return identity if row.id == object_id_for_key(_name_key(row.name)) else None
    except ValueError:  # a blank name hashes to nothing
        return None


@dataclass
class Repair:
    """One bare SharePoint object's repair, fully decided before anything is written."""

    row: ObjectSite
    identity: FolderIdentity
    target: uuid.UUID
    twin: ObjectSite | None = None  # the older, richer object under the corrected key
    pair: MergePair | None = None
    rekey: Rekey | None = None
    address_filled: str | None = None  # an empty survivor address taken from the folder name
    coords: tuple[float, float] | None = None  # geocoded for a survivor that had none

    @property
    def survivor(self) -> ObjectSite:
        return self.twin or self.row

    @property
    def done(self) -> bool:
        """Whether this repair ends with the object reachable under the corrected key."""
        if self.pair is not None and not self.pair.deletable:
            return False
        return self.rekey is None or self.rekey.blocked is None


async def _lookup_coordinates(address: str) -> tuple[float, float] | None:
    """Best-effort position for the repair. Never raises: a repair that cannot reach swisstopo
    still merges and re-keys, and the census at the end says which objects still have none.

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

    ⚠️ This is the point of the whole repair, not a footnote to it: an object without
    coordinates is surfaced at no incident (:func:`objects_without_coordinates`), so a run that
    merged everything perfectly and geocoded nothing has fixed half the defect. ``resolved`` are
    the ids a dry run WOULD take off this list; under ``--apply`` it is empty, because by then
    the list is read back from what was actually written — which is what makes a second
    ``repair-sharepoint-keys`` (dry-run, read-only) the way to verify the first.
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

    The other half of the same defect, and the older half: after the two conventions were folded
    back together (:func:`_repair_sharepoint_keys`), the FWO deployment still carried 52 objects
    the ORIGINAL importer had written without coordinates, and an object without coordinates is
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


async def _repair_sharepoint_keys(*, apply: bool, do_geocode: bool) -> int:
    """Fold the SharePoint pull's whole-folder-name objects onto the address-split convention.

    THE DEFECT (production, 11.09.2026). A plans folder is named «Adresse - Name». The importer
    has always keyed an Einsatzobjekt on the NAME half and stored the address separately; the
    SharePoint connector hashed the WHOLE folder string instead. So every folder minted a
    SECOND, address-less, coordinate-less object beside the one the station already had, the
    pull kept updating that copy — «Im Buech 15» was at v2 on one object while the Einsatz
    showed v1 on the other — and because an object with no coordinates is surfaced at no
    incident at all, ~334 freshly synced plans were reachable by nobody.

    WHAT THIS DOES, per object the connector minted under the old convention
    (:func:`_whole_folder_keyed`, an exact id test — nothing typed by hand is touched):

    * **With an older twin** — found under the corrected key, or by the twin's own
      ``address + ' - ' + name`` — the bare object folds INTO it, because the older row is the
      one carrying the address, the coordinates, the station's georeference and whatever an FU
      picked in an Einsatz. Plans move slot by slot and the NEWER sheet wins each slot
      (``newest_wins``): the pull's v2 replaces the v1 nobody could open, an identical copy is
      dropped, and the survivor's own newer sheet stays. The bare row's empty address and
      coordinates never overwrite the survivor's real ones — but an EMPTY survivor address is
      filled from the folder name, because that address is the other way an object surfaces
      (api/objects · objects_near_incident matches it against the incident's).
    * **Without one** — 68 of the 150 on this deployment — the object is re-keyed onto the
      corrected id and its name is split into address + name, so the next sync finds it.
    * **Either way**, a survivor that ends up with an address and no coordinates is geocoded
      (best-effort, ``--no-geocode`` to skip), and everything still without any is listed.

    Its own subcommand rather than a flag on ``merge-duplicates``: that one folds rows whose
    NAMES are the same name, this one folds rows whose names deliberately differ because two
    conventions read one folder — and at 3am «merge the duplicates» and «repair what SharePoint
    keyed wrongly» are two different questions with two different answers.

    REPORT ONLY unless ``apply``, and under ``--apply`` the whole run is ONE transaction.

    ⚠️ Writes ``plan_scales_json`` directly, outside the If-Match guard a human write gets
    (api/plan_scales). Run it in a maintenance window, not while an Einsatz is being drawn on.
    """
    async with async_session_maker() as db:
        rows = list((await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars())
        counts = await _plan_counts(db)
        station = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        scales: dict[str, object] = dict(station.plan_scales_json) if station and station.plan_scales_json else {}
        by_id = {r.id: r for r in rows}
        # The twin an id lookup misses: the older row was keyed by something else (a decomposed
        # spelling, a hand-typed key), but it IS this building — it says so in its own two fields.
        by_fields: dict[tuple[str, str], ObjectSite] = {}
        for stored in rows:
            if stored.address and stored.name:
                by_fields.setdefault((_name_key(stored.address), _name_key(stored.name)), stored)

        bare = [(r, i) for r in rows if (i := _whole_folder_keyed(r)) is not None]
        if not bare:
            print(f"No object is keyed on a whole «Adresse - Name» folder name among {len(rows)} object(s).")
            await _coordinate_census(db, set())
            return 0

        repairs: list[Repair] = []
        resolved: set[uuid.UUID] = set()
        for row, identity in bare:
            twin = by_id.get(identity.object_id)
            if twin is None:
                twin = by_fields.get((_name_key(identity.address or ""), _name_key(identity.name)))
            if twin is not None and twin.id == row.id:
                twin = None  # itself is not a twin
            rep = Repair(row=row, identity=identity, target=identity.object_id, twin=twin)
            repairs.append(rep)
            found = (
                "the object the importer created is below"  # `_print_pair` names it as `keep`
                if twin is not None
                else "no older twin — this one is re-keyed alone"
            )
            print(f"\n«{unicodedata.normalize('NFC', row.name)}» — keyed on the whole folder name ({found})")

            if twin is not None:
                slots: dict[str, ReferenceDataset] = {
                    ds.module: ds
                    for ds in (
                        await db.execute(select(ReferenceDataset).where(ReferenceDataset.object_id == twin.id))
                    ).scalars()
                    if ds.module
                }
                pair = await _plan_merge(db, twin, row, counts=counts, slots=slots, scales=scales, newest_wins=True)
                rep.pair = pair
                _print_pair(pair)
                scales, _, _ = _retarget_scales(scales, row.id, twin.id)
                if apply:
                    await _apply_pair(db, pair)
                if not pair.deletable:
                    print("       ! left as it is — the bare object still holds a sheet the survivor also has")
                    continue
                resolved.add(row.id)  # its plans are the survivor's now

            survivor = rep.survivor
            address = (survivor.address or "").strip() or identity.address
            if not (survivor.address or "").strip() and identity.address:
                rep.address_filled = identity.address
            if do_geocode and address and (survivor.lat is None or survivor.lng is None):
                rep.coords = await _lookup_coordinates(address)
                if rep.coords:
                    resolved.add(survivor.id)
            if survivor.id != rep.target:
                if apply:
                    await db.flush()  # the fold above must be readable by the scan below
                rep.rekey = await _plan_rekey(
                    db,
                    survivor,
                    rep.target,
                    also=[row.id] if rep.pair else [],
                    moved_datasets=[
                        s.target_id for s in (rep.pair.slots if rep.pair else []) if s.action in ("move", "replace")
                    ],
                    scales=scales,
                    name=identity.name if survivor is row else unicodedata.normalize("NFC", survivor.name),
                    address=address,
                    coords=rep.coords,
                )
                _print_rekey(rep.rekey)
                if rep.rekey.blocked is None:
                    scales, _, _ = _retarget_scales(scales, survivor.id, rep.target)
                    resolved.add(survivor.id)
                    if apply:
                        await _apply_rekey(db, rep.rekey)
                continue
            # Already on the corrected id: only the two fields can still be wrong.
            if rep.address_filled:
                print(f"       → address «{rep.address_filled}» filled in from the folder name")
            if rep.coords:
                print(f"       → geocoded to {rep.coords[0]:.5f}, {rep.coords[1]:.5f}")
            if apply:
                if rep.address_filled:
                    survivor.address = rep.address_filled
                if rep.coords:
                    survivor.lat, survivor.lng = rep.coords
            print("       · the survivor already carries the key the corrected sync derives — no re-key")

        merged = sum(1 for r in repairs if r.pair is not None and r.pair.deletable)
        rekeyed = sum(1 for r in repairs if r.rekey is not None and r.rekey.blocked is None)
        replaced = sum(1 for r in repairs if r.pair for s in r.pair.slots if s.action == "replace")
        moved = sum(1 for r in repairs if r.pair for s in r.pair.slots if s.action == "move")
        geocoded = sum(1 for r in repairs if r.coords)
        stuck = [r for r in repairs if not r.done]
        summary = (
            f"{len(repairs)} object(s) keyed on a whole folder name: {merged} merged into an older twin "
            f"({moved} plan(s) moved, {replaced} superseded sheet(s) replaced), {rekeyed} re-keyed onto the "
            f"corrected key, {geocoded} geocoded" + (f", {len(stuck)} left untouched" if stuck else "")
        )
        if not apply:
            print(f"\nOK (dry-run): would be {summary}. Nothing written. Repeat with --apply to perform it.")
            await _coordinate_census(db, resolved)
            return 1 if stuck else 0
        if station is not None and scales != (station.plan_scales_json or {}):
            station.plan_scales_json = scales
        await db.commit()
        print(f"\n{'INCOMPLETE' if stuck else 'OK'}: {summary}.")
        for unfinished in stuck:
            print(f"       ! {unfinished.row.id} «{unfinished.row.name}» — decide this one by hand")
        # Read back from what was WRITTEN: the same census a second, read-only dry run prints.
        # It does not decide the exit code — a coordinate nobody can geocode is a person's job,
        # not an unfinished repair.
        await _coordinate_census(db, set())
        return 1 if stuck else 0


async def _remove_empty(*, apply: bool, names: list[str]) -> int:
    """Delete objects that carry no plans and that nothing points at — REPORT ONLY unless ``apply``.

    The «Grosspläne» case: a category folder that an import read as an Einsatzobjekt. With no plans
    under it, it falls out here on its own; if it did pick up plans, name it with ``--name`` and it
    goes with them — sheets, revisions, alignments and floor packs alike (:func:`_drop_plan_rows`).
    Either way an object that an incident, a calibration or the audit trail names is REFUSED — a
    station that used the thing is not a station that can lose it silently.
    """
    wanted = {_name_key(n) for n in names}
    async with async_session_maker() as db:
        rows = list((await db.execute(select(ObjectSite).order_by(ObjectSite.name))).scalars())
        counts = await _plan_counts(db)
        station = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        scales: dict[str, object] = dict(station.plan_scales_json) if station and station.plan_scales_json else {}
        named = {_name_key(r.name) for r in rows}
        for missing in sorted(wanted - named):
            print(f"  ? --name {missing!r}: no object stored under that name")

        removed: list[ObjectSite] = []
        refused: list[tuple[ObjectSite, str]] = []
        for row in rows:
            explicit = _name_key(row.name) in wanted
            plans = counts.get(row.id, 0)
            if plans and not explicit:
                continue
            holds = len(_scale_keys_for(scales, row.id))
            incidents = len(await _incidents_naming(db, row.id))
            events, journal = await _history_naming(db, row.id)
            if holds or incidents or events or journal:
                refused.append(
                    (
                        row,
                        f"{holds} calibration key(s), {incidents} incident(s), "
                        f"{events + journal} history row(s) name it",
                    )
                )
                continue
            removed.append(row)
            print(f"  - {row.id}  {_spelling(row.name)}  ({plans} plan(s){', named explicitly' if explicit else ''})")
            if apply:
                doomed = list(
                    (
                        await db.execute(select(ReferenceDataset.id).where(ReferenceDataset.object_id == row.id))
                    ).scalars()
                )
                for dataset_id in doomed:
                    await _drop_plan_rows(db, dataset_id)
                await db.execute(
                    delete(ReferenceDataset)
                    .where(ReferenceDataset.object_id == row.id)
                    .execution_options(synchronize_session=False)
                )
                await db.execute(
                    delete(ObjectSite).where(ObjectSite.id == row.id).execution_options(synchronize_session=False)
                )
        for row, why in refused:
            print(f"  ! {row.id}  {_spelling(row.name)} — NOT removed: {why}", file=sys.stderr)

        if not removed and not refused:
            print(f"No empty objects among {len(rows)} object(s). Nothing to remove.")
            return 0
        plans_gone = sum(counts.get(r.id, 0) for r in removed)
        summary = f"{len(removed)} object(s) with {plans_gone} plan(s) deleted, {len(refused)} refused"
        if not apply:
            print(f"\nOK (dry-run): would be {summary}. Nothing written. Repeat with --apply to perform it.")
            return 0
        await db.commit()
        print(f"\nOK: {summary}.")
        return 0


# --- CLI --------------------------------------------------------------------------------


async def _amain(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.admin_objects_repair",
        description="Repair a deployment's Einsatzobjekte: merge twins, re-key, geocode, remove empty rows.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_merge = sub.add_parser(
        "merge-duplicates",
        help="fold objects whose names are the same name (NFD/NFC twins, exact duplicates) into one",
    )
    p_merge.add_argument("--apply", action="store_true", help="perform the merge (default: report only, no writes)")
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
    p_repair = sub.add_parser(
        "repair-sharepoint-keys",
        help="fold objects the SharePoint pull keyed on a whole «Adresse - Name» folder name onto the "
        "convention the importer uses, and report every object without coordinates",
    )
    p_repair.add_argument("--apply", action="store_true", help="perform the repair (default: report only, no writes)")
    p_repair.add_argument(
        "--no-geocode",
        action="store_true",
        help="do not look addresses up at swisstopo (the dry run geocodes too, so its report says "
        "which coordinates the objects would get)",
    )
    p_geo = sub.add_parser(
        "geocode-missing",
        help="geocode every object that carries plans and has no coordinates (by its address, or "
        "by its name when it has none) — without them an object surfaces at no incident",
    )
    p_geo.add_argument("--apply", action="store_true", help="write the coordinates (default: report only, no writes)")
    p_empty = sub.add_parser("remove-empty", help="delete objects with no plans and no references")
    p_empty.add_argument("--apply", action="store_true", help="perform the deletion (default: report only, no writes)")
    p_empty.add_argument(
        "--name",
        action="append",
        default=[],
        metavar="NAME",
        help="also remove the object stored under this name, plans and all (repeatable) — for a "
        "category folder an import read as an Einsatzobjekt, e.g. 'Grosspläne'",
    )

    args = parser.parse_args(argv)

    if args.cmd == "merge-duplicates":
        return await _merge_duplicates(apply=args.apply)
    if args.cmd == "merge":
        return await _merge_into(args.loser, args.survivor, apply=args.apply)
    if args.cmd == "twins":
        return await _report_twins()
    if args.cmd == "repair-sharepoint-keys":
        return await _repair_sharepoint_keys(apply=args.apply, do_geocode=not args.no_geocode)
    if args.cmd == "geocode-missing":
        return await _geocode_missing(apply=args.apply)
    # remove-empty
    return await _remove_empty(apply=args.apply, names=args.name)


def main() -> None:
    sys.exit(asyncio.run(_amain(sys.argv[1:])))


if __name__ == "__main__":
    main()

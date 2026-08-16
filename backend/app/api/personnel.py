"""Personnel (Mannschaft) endpoints: roster list + manual CRUD + CSV import +
editor-only Divera member sync."""

import json
import uuid

import httpx
from fastapi import APIRouter, Cookie, Depends, File, Form, HTTPException, UploadFile
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import personnel as personnel_svc
from ..auth.dependencies import EditorOrAdmin, OptionalUser, UserOrAdmin, _admin_session_valid
from ..config import settings
from ..credentials import get as credential
from ..credentials import load as load_credentials
from ..database import get_db
from ..divera import DiveraApiError
from ..models import Personnel, PersonnelExternalIdentity
from ..schemas import (
    PersonnelCreate,
    PersonnelOut,
    PersonnelSyncExecuteBody,
    PersonnelSyncPreview,
    PersonnelSyncResult,
    PersonnelUpdate,
    RosterImportPreview,
    RosterImportResult,
    RosterRankDecision,
    RosterRankOption,
    RosterUnknownRank,
)

router = APIRouter(prefix="/personnel", tags=["personnel"])


class RosterImportPreviewOut(RosterImportPreview):
    """:class:`RosterImportPreview` plus the two numbers the confirmation step is built on.

    Both are counted with the very planner the write uses (app/personnel.plan_roster_rows), so
    what the operator confirms is what happens — a preview that guessed differently would be
    worse than none."""

    #: people in this file the station does not have yet
    creates: int = 0
    #: people the file will update in place instead of adding a second time
    updates: int = 0


class RosterImportResultOut(RosterImportResult):
    """:class:`RosterImportResult` split the way the confirmation promised it."""

    created: int = 0
    updated: int = 0


async def _identity_map(
    db: AsyncSession, person_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[PersonnelExternalIdentity]]:
    if not person_ids:
        return {}
    rows = list(
        (
            await db.execute(
                select(PersonnelExternalIdentity).where(PersonnelExternalIdentity.personnel_id.in_(person_ids))
            )
        ).scalars()
    )
    out: dict[uuid.UUID, list[PersonnelExternalIdentity]] = {}
    for identity in rows:
        out.setdefault(identity.personnel_id, []).append(identity)
    return out


def _personnel_out(
    person: Personnel,
    identities: list[PersonnelExternalIdentity],
    order: personnel_svc.NameOrder = personnel_svc.DEFAULT_NAME_ORDER,
) -> dict:
    divera = next((i.external_id for i in identities if i.provider == "divera"), None)
    try:
        legacy_divera_id = int(divera) if divera is not None else person.divera_id
    except ValueError:
        legacy_divera_id = person.divera_id
    return {
        "id": person.id,
        "divera_id": legacy_divera_id,
        "external_identities": [
            {"provider": i.provider, "external_id": i.external_id, "synced_at": i.synced_at} for i in identities
        ],
        # Served in the station's roster.nameOrder; the stored column is never rewritten, so
        # flipping the setting changes what the app reads on the very next request.
        "display_name": personnel_svc.person_display_name(person, order),
        "first_name": person.first_name,
        "last_name": person.last_name,
        "rank": person.rank,
        "is_active": person.is_active,
        "updated_at": person.updated_at,
    }


@router.get("", response_model=list[PersonnelOut])
async def list_personnel(
    _user: UserOrAdmin,
    include_inactive: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """The crew roster, ordered by name. Active-only unless ``include_inactive=true``."""
    stmt = select(Personnel)
    if not include_inactive:
        stmt = stmt.where(Personnel.is_active.is_(True))
    people = list((await db.execute(stmt)).scalars())
    identities = await _identity_map(db, [p.id for p in people])
    order = await personnel_svc.load_roster_name_order(db)
    out = [_personnel_out(p, identities.get(p.id, []), order) for p in people]
    # Sorted on the SERVED name, not the stored one: under "first-last" an ORDER BY
    # display_name would hand back a list alphabetised by a surname the operator can't see.
    # ~100 rows, so Python sorts it (and gets accent-insensitive ordering for free).
    out.sort(key=lambda row: personnel_svc.name_sort_key(row["display_name"]))
    return out


@router.post("", response_model=PersonnelOut, status_code=201)
async def create_person(
    body: PersonnelCreate,
    _user: EditorOrAdmin,
    db: AsyncSession = Depends(get_db),
):
    """Manually add a crew member (hand entry; ``divera_id`` normally null)."""
    person = Personnel(display_name=body.display_name.strip(), rank=body.rank, is_active=True)
    db.add(person)
    await db.flush()
    if body.divera_id is not None:
        await personnel_svc.attach_external_identity(
            db, person=person, provider="divera", external_id=str(body.divera_id)
        )
    await db.refresh(person)
    identities = await _identity_map(db, [person.id])
    order = await personnel_svc.load_roster_name_order(db)
    return _personnel_out(person, identities.get(person.id, []), order)


@router.patch("/{person_id}", response_model=PersonnelOut)
async def update_person(
    person_id: uuid.UUID,
    body: PersonnelUpdate,
    _user: EditorOrAdmin,
    db: AsyncSession = Depends(get_db),
):
    """Edit name / active flag."""
    person = await db.get(Personnel, person_id)
    if person is None:
        raise HTTPException(status_code=404, detail="Person nicht gefunden")
    fields = body.model_dump(exclude_unset=True)
    if "display_name" in fields and fields["display_name"] is not None:
        fields["display_name"] = fields["display_name"].strip()
    for key, value in fields.items():
        setattr(person, key, value)
    await db.flush()
    await db.refresh(person)
    identities = await _identity_map(db, [person.id])
    order = await personnel_svc.load_roster_name_order(db)
    return _personnel_out(person, identities.get(person.id, []), order)


@router.delete("/{person_id}")
async def deactivate_person(
    person_id: uuid.UUID,
    _user: EditorOrAdmin,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Deactivate (never hard-delete) — old incidents/reports keep resolving names."""
    person = await db.get(Personnel, person_id)
    if person is None:
        raise HTTPException(status_code=404, detail="Person nicht gefunden")
    person.is_active = False
    await db.flush()
    return {"ok": True}


async def _csv_text(file: UploadFile) -> str:
    """The uploaded file as text, or the HTTP error that says why it isn't."""
    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Datei zu gross (max. {settings.max_upload_mb} MB)")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise HTTPException(status_code=400, detail="Datei ist nicht UTF-8 kodiert") from e


def _parse(text: str) -> personnel_svc.ParsedRoster:
    try:
        return personnel_svc.parse_roster_csv(text)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


_DECISIONS = TypeAdapter(list[RosterRankDecision])


def _decisions(raw: str | None) -> dict[str, RosterRankDecision]:
    """The submitted decisions, keyed by NORMALIZED value so «Sdt» and «sdt» resolve to the
    same one — exactly as :func:`personnel.group_unknown_ranks` grouped them."""
    if not raw or not raw.strip():
        return {}
    try:
        parsed = _DECISIONS.validate_python(json.loads(raw))
    except (json.JSONDecodeError, ValidationError) as e:
        raise HTTPException(status_code=422, detail=f"Zuordnung nicht lesbar: {e}") from e
    return {personnel_svc.normalize_name(d.value): d for d in parsed}


def _duplicate_notes(plan: personnel_svc.RosterPlan) -> list[str]:
    """The file naming one person twice is not an error, but it IS the difference between the
    row count and the people count — so it is said out loud rather than left as a mismatch."""
    return [f"«{name}» steht mehrfach in der Datei – wird als eine Person importiert." for name in plan.duplicate_names]


@router.post("/import-csv/preview", response_model=RosterImportPreviewOut)
async def import_csv_preview(
    _user: EditorOrAdmin,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> RosterImportPreviewOut:
    """What this file would do — read-only. **Writes nothing**, by construction: nothing here
    touches the session.

    Two questions are answered here, and EVERY import asks both before anything is written:

    * how many people are new and how many the file updates in place (:func:`plan_roster_rows`),
      because the answer «14 neu» to a file that was already imported is the one thing that
      would have stopped a station from duplicating its whole Wehr;
    * which rank values the station's list does not know, grouped BY VALUE with the people they
      affect and a spelling proposal.

    The old import wrote first and explained afterwards, under a green «14 importiert» badge.
    """
    parsed = _parse(await _csv_text(file))
    ranks, has_own = await personnel_svc.load_roster_ranks_info(db)
    groups = personnel_svc.group_unknown_ranks(parsed.rows, ranks)
    plan = personnel_svc.plan_roster_rows(parsed.rows, await personnel_svc.load_roster_index(db))
    return RosterImportPreviewOut(
        total=len(parsed.rows),
        creates=plan.creates,
        updates=plan.updates,
        skipped=parsed.skipped,
        errors=parsed.errors + _duplicate_notes(plan),
        unknown_ranks=[
            RosterUnknownRank(value=g.value, count=g.count, people=g.people, suggestion=g.suggestion) for g in groups
        ],
        known_ranks=[
            RosterRankOption(key=str(r.get("key")), label=str(r.get("label") or r.get("key")), abbr=r.get("abbr"))
            for r in ranks
        ],
        has_own_ranks=has_own,
    )


@router.post("/import-csv", response_model=RosterImportResultOut)
async def import_csv(
    _user: EditorOrAdmin,
    actor: OptionalUser,
    file: UploadFile = File(...),
    decisions: str | None = Form(default=None),
    admin_session: str | None = Cookie(default=None),
    db: AsyncSession = Depends(get_db),
) -> RosterImportResultOut:
    """Import a UTF-8 CSV. ``name`` is required; ``rank`` is optional. Provider-neutral
    ``provider`` + ``external_id`` columns may upsert an externally managed record. The legacy
    ``divera_id`` column remains accepted during the compatibility window.

    ⚠️ **Idempotent.** A row that resolves to somebody the station already has UPDATES that
    person — it never adds a second one. See app/personnel «who a CSV row is» for the key and
    for the one case it gets wrong (two different people spelled identically).

    ``decisions`` is the JSON array from the mapping step (:class:`RosterRankDecision` per
    unknown VALUE, not per row); ``/import-csv/preview`` produces the list of values to decide.

    ⚠️ **All or nothing.** Every rank value the station does not know must carry a decision, or
    the request is refused with 409 and NOTHING is written — not the people, not the ranks. The
    file is fully parsed and every decision validated before the first row is inserted, so an
    abort cannot leave half a crew behind. (The old contract imported those people rankless and
    listed the fact afterwards; a station that misses the list has silently lost data.)

    ``adopt`` writes the station's ``roster.ranks`` (app/personnel.adopt_ranks) and therefore
    needs an admin session — a config write is admin-only everywhere else in this app, and the
    Verwaltung that offers this is an admin surface. An incident editor can still import, map
    and skip.
    """
    text = await _csv_text(file)
    parsed = _parse(text)
    ranks, _has_own = await personnel_svc.load_roster_ranks_info(db)
    groups = personnel_svc.group_unknown_ranks(parsed.rows, ranks)
    decided = _decisions(decisions)

    # ── decide everything BEFORE writing anything ──────────────────────────────────────
    undecided = [g for g in groups if personnel_svc.normalize_name(g.value) not in decided]
    if undecided:
        listed = ", ".join(f"«{g.value}» ({g.count})" for g in undecided)
        raise HTTPException(
            status_code=409,
            detail=(
                f"Unbekannte Grade in der Datei: {listed}. "
                "Es wurde nichts importiert — bitte jeden Wert zuordnen, übernehmen oder weglassen."
            ),
        )
    known_keys = {str(r.get("key")) for r in ranks}
    resolved: dict[str, str | None] = {}  # normalized unknown value → rank key (or None)
    adopt_values: list[str] = []
    for group in groups:
        norm = personnel_svc.normalize_name(group.value)
        decision = decided[norm]
        if decision.action == "map":
            if decision.rank not in known_keys:
                raise HTTPException(
                    status_code=422,
                    detail=f"«{group.value}» soll auf den Grad «{decision.rank}» gelegt werden, den es nicht gibt.",
                )
            resolved[norm] = decision.rank
        elif decision.action == "adopt":
            adopt_values.append(group.value)
        else:
            resolved[norm] = None

    adopted_keys: list[str] = []
    if adopt_values:
        if not await _admin_session_valid(admin_session):
            raise HTTPException(
                status_code=403,
                detail="Neue Grade kann nur die Verwaltung übernehmen (Admin-Anmeldung erforderlich).",
            )
        updated = await personnel_svc.adopt_ranks(db, adopt_values, actor.id if actor else None)
        # append_ranks appends in the order it was given, so the tail lines up with adopt_values
        adopted_keys = [str(r.get("key")) for r in updated[-len(adopt_values) :]]
        for value, key in zip(adopt_values, adopted_keys, strict=True):
            resolved[personnel_svc.normalize_name(value)] = key

    # ── write ───────────────────────────────────────────────────────────────────────────
    # The SAME plan the preview showed: every row already knows whether it is a person the
    # station has (→ update) or one it does not (→ insert), so a re-import cannot double a Wehr.
    index = await personnel_svc.load_roster_index(db)
    plan = personnel_svc.plan_roster_rows(parsed.rows, index)
    by_person = {p.id: p for p in (await db.execute(select(Personnel))).scalars()}
    made: dict[int, Personnel] = {}  # owner index → the row this pass inserted

    for i, target in enumerate(plan.targets):
        row = target.row
        rank = personnel_svc.match_rank(row.rank_text, ranks) if row.rank_text else None
        if rank is None and row.rank_text:
            rank = resolved.get(personnel_svc.normalize_name(row.rank_text))

        person = by_person[target.person_id] if target.person_id is not None else made.get(target.owner)
        if person is None:
            person = Personnel(display_name=row.name, rank=rank, is_active=True)
            db.add(person)
            await db.flush()
            made[i] = person
            by_person[person.id] = person
        else:
            person.display_name = row.name
            # ⚠️ Only a rank the row actually names is written. An empty cell — or a value the
            # station decided to drop — means «not stated», and a re-import of a file without a
            # rank column must not strip the Dienstgrad off the whole Wehr.
            if rank is not None:
                person.rank = rank
            person.is_active = True
        if row.provider and row.external_id and (person.id, row.provider) not in index.providers:
            # A person may hold only ONE identity per provider (uq_personnel_external_person_provider);
            # a name-matched row that would contradict an existing one is left alone.
            await personnel_svc.attach_external_identity(
                db, person=person, provider=row.provider, external_id=row.external_id
            )
            index.providers.add((person.id, row.provider))
            index.by_external[(row.provider, row.external_id)] = person.id

    await db.flush()
    # What was deliberately dropped is still worth reading back — but now it is a consequence of
    # a decision somebody made, not a surprise underneath a success badge.
    errors = list(parsed.errors) + _duplicate_notes(plan)
    for group in groups:
        if decided[personnel_svc.normalize_name(group.value)].action == "skip":
            people = "1 Person" if group.count == 1 else f"{group.count} Personen"
            errors.append(f"«{group.value}» weggelassen: {people} ohne Grad importiert")
    return RosterImportResultOut(
        imported=plan.creates + plan.updates,
        created=plan.creates,
        updated=plan.updates,
        skipped=parsed.skipped,
        errors=errors,
        adopted_ranks=adopted_keys,
    )


async def _require_divera(db: AsyncSession) -> None:
    """503 unless a Divera access key is configured — read live, so a key pasted into
    /admin makes «Mannschaft synchronisieren» work on the next tap, not the next restart."""
    await load_credentials(db)
    if not credential("divera_access_key"):
        raise HTTPException(status_code=503, detail="Divera nicht konfiguriert (kein Access Key)")


def _divera_unreachable(e: Exception) -> str:
    """The 502 detail for a failed Divera call — never the exception's own text.

    ⚠️ This used to be `f"Divera nicht erreichbar: {e}"`, and both endpoints below are
    `EditorOrAdmin`. An `httpx.HTTPStatusError` stringifies to «… for url '…?accesskey=<the
    key>'», so any incident editor who could make Divera answer non-2xx (a 429 will do) read
    back a credential that `/api/integrations/credentials` refuses even to an admin. The
    source is fixed too — `divera.check_response` no longer builds such a message — and this
    is the second lock on the same door: only `DiveraApiError`, which is URL-free by
    construction, is ever quoted. Everything else leaves as its type name, the way
    `audio.transcribe` reports an unreachable STT server.
    """
    return f"Divera nicht erreichbar: {e if isinstance(e, DiveraApiError) else type(e).__name__}"


@router.post("/sync/preview", response_model=PersonnelSyncPreview)
async def sync_preview(_user: EditorOrAdmin, db: AsyncSession = Depends(get_db)):
    await _require_divera(db)
    try:
        return await personnel_svc.build_sync_preview(db)
    except (DiveraApiError, httpx.HTTPError, ValueError) as e:
        raise HTTPException(status_code=502, detail=_divera_unreachable(e)) from None


@router.post("/sync/execute", response_model=PersonnelSyncResult)
async def sync_execute(
    _user: EditorOrAdmin,
    body: PersonnelSyncExecuteBody | None = None,
    db: AsyncSession = Depends(get_db),
):
    await _require_divera(db)
    try:
        return await personnel_svc.execute_sync(
            db, deactivate_stale=(body or PersonnelSyncExecuteBody()).deactivate_stale
        )
    except (DiveraApiError, httpx.HTTPError, ValueError) as e:
        raise HTTPException(status_code=502, detail=_divera_unreachable(e)) from None

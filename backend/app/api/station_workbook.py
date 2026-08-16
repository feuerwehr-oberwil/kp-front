"""Station-data workbook: download the station's list-shaped data as one ``.xlsx``, edit it in
Excel/Numbers/LibreOffice, upload it back.

Three endpoints and one rule between them: **nothing is written until the operator has seen,
per sheet, what the file would do.** ``/preview`` writes nothing by construction — it never
touches the session — and ``/import`` re-runs the very same planner over the very same bytes,
so the numbers that were confirmed are the numbers that happen. Cancelling is simply not
calling ``/import``; there is no server-side draft to abandon.

Two guarantees this endpoint owes the rest of the app, both structural rather than checked:

* **The file is parsed HERE, server-side.** It never accepts a client-parsed document. If it
  did, an "import" would be an ordinary full-document PUT wearing a spreadsheet's clothes and
  every guard in app/config_history would be bypassed — which is how this project lost its
  config four times.
* **It is a read-modify-write of specific key paths**, in the shape ``adopt_ranks`` already
  uses (app/personnel): the document is read from the DATABASE, only the paths the workbook
  has sheets for are replaced, ``keep_previous`` runs first in the same session, and the
  config write and the roster write land in ONE transaction. Because no client draft exists,
  this legitimately needs no ``If-Match`` — the 428/409 on ``PUT /api/config`` guards a stale
  browser draft, and there is none here.

⚠️ There is no ``replace`` mode and there must never be one. See app/services/station_workbook.
"""

import hashlib
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import personnel as personnel_svc
from ..auth.dependencies import CurrentAdmin, OptionalUser
from ..config import settings
from ..config_history import keep_previous
from ..database import get_db
from ..models import DeploymentConfig, Personnel, PersonnelExternalIdentity
from ..schemas import load_stored_config
from ..services.station_workbook import (
    ImportPlan,
    WorkbookFileError,
    WorkbookImportResult,
    WorkbookPreview,
    build_workbook,
    known_keys,
    parse_workbook,
    plan_import,
)

router = APIRouter(prefix="/station-workbook", tags=["station-workbook"])

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


async def _stored_config(db: AsyncSession) -> tuple[DeploymentConfig | None, dict]:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    return row, dict((row.config_json if row else None) or {})


async def _identity_pairs(db: AsyncSession) -> dict[uuid.UUID, tuple[str, str]]:
    """Person → the ``(provider, external_id)`` the workbook round-trips.

    A person may legitimately hold one identity per provider. The sheet has room for exactly
    one, so the alphabetically first provider wins and the others are left untouched by the
    import (a row only ever ATTACHES the identity it names). Writing a second row for the same
    person would split them in two on the next upload.
    """
    rows = list(
        (await db.execute(select(PersonnelExternalIdentity).order_by(PersonnelExternalIdentity.provider))).scalars()
    )
    out: dict[uuid.UUID, tuple[str, str]] = {}
    for identity in rows:
        out.setdefault(identity.personnel_id, (identity.provider, identity.external_id))
    return out


async def _people(db: AsyncSession) -> list[Personnel]:
    return list((await db.execute(select(Personnel).order_by(Personnel.created_at, Personnel.id))).scalars())


async def _upload_bytes(file: UploadFile) -> bytes:
    """The uploaded workbook, or the HTTP error that says why it is not one."""
    name = (file.filename or "").lower()
    if not name.endswith(".xlsx"):
        raise HTTPException(
            status_code=400,
            detail="Bitte eine .xlsx-Datei hochladen (nicht .xls, nicht .csv, nicht .numbers).",
        )
    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Datei zu gross (max. {settings.max_upload_mb} MB)")
    if not data:
        raise HTTPException(status_code=400, detail="Die Datei ist leer.")
    return data


async def _plan(db: AsyncSession, data: bytes) -> ImportPlan:
    """Parse + project — the shared half of preview and import. Touches no session state."""
    _row, raw = await _stored_config(db)
    stored = load_stored_config(raw).model_dump(mode="json")
    try:
        parsed = parse_workbook(data, known=known_keys(stored))
    except WorkbookFileError as exc:
        # ⚠️ openpyxl's own exception text is logged, never forwarded: it is a parser's words
        # about a zip member, and the operator gets a sentence they can act on instead.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    people = await _people(db)
    return plan_import(
        parsed,
        raw,
        list(people),
        await personnel_svc.load_roster_index(db),
        await _identity_pairs(db),
        await personnel_svc.load_roster_name_order(db),
        digest=hashlib.sha256(data).hexdigest(),
    )


@router.get("/export")
async def export_workbook(
    _admin: CurrentAdmin,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """The station's current data as a workbook — the template AND the undo.

    ⚠️ Not a backup. It carries six of a dozen config sections; ``identity`` (logos included),
    ``map``, ``doctrine``, ``referenceLayers``, ``modules``, ``alarms``, ``alarmKeywords``,
    ``report.links`` and ``journal`` are outside it entirely, and re-importing this file
    restores none of them. The backup is Sicherung's JSON export plus ``admin_config
    history/restore``, and the admin page says so in as many words.
    """
    _row, raw = await _stored_config(db)
    stored = load_stored_config(raw).model_dump(mode="json")
    data = build_workbook(
        stored,
        list(await _people(db)),
        await _identity_pairs(db),
        await personnel_svc.load_roster_name_order(db),
    )
    name = f"stationsdaten-{datetime.now(UTC).date().isoformat()}.xlsx"
    return Response(
        content=data,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@router.post("/preview", response_model=WorkbookPreview)
async def preview_workbook(
    _admin: CurrentAdmin,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> WorkbookPreview:
    """What this file would do, per sheet — read-only. **Writes nothing**, by construction:
    nothing on this path touches the session.

    The response is the confirmation screen. Per sheet: how many rows are new, how many change,
    what would be deactivated or removed BY NAME, plus every refused row with its sheet and its
    row number so the operator can find it in their own file, plus the config sections the
    write would leave empty.

    ⚠️ kp-rueck computes the destructive figures and its settings page never renders them; its
    own troubleshooting guide now carries a row titled «An Excel import deleted the whole
    roster». The numbers being available is not the point — the operator seeing them is.
    """
    return (await _plan(db, await _upload_bytes(file))).preview


@router.post("/import", response_model=WorkbookImportResult)
async def import_workbook(
    _admin: CurrentAdmin,
    actor: OptionalUser,
    file: UploadFile = File(...),
    digest: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
) -> WorkbookImportResult:
    """Apply the workbook. Upsert only — a row's absence from a sheet that is PRESENT is the
    only way anything goes away, and it was named in the preview before it happened.

    ``digest`` is the sha256 the preview reported for the file it read. Sent back here, it is
    what makes "confirm" mean *this* file: an operator who saves a further edit in Excel between
    the preview and the confirmation gets a 409 and a fresh preview, not a silent apply of
    something nobody looked at. A caller that skips the preview (a script) may omit it.

    ⚠️ Refused as a WHOLE. One bad cell and nothing is written — not the people, not the config.
    The alternative is a half-imported station whose two halves disagree about which Dienstgrade
    exist.
    """
    data = await _upload_bytes(file)
    if digest and digest != hashlib.sha256(data).hexdigest():
        raise HTTPException(
            status_code=409,
            detail="Die Datei hat sich seit der Vorschau geändert. Bitte die Vorschau neu erstellen.",
        )
    plan = await _plan(db, data)
    if not plan.preview.ok:
        raise HTTPException(
            status_code=400,
            detail="Die Arbeitsmappe wurde nicht übernommen: " + " · ".join(plan.preview.errors),
        )

    actor_id = actor.id if actor else None
    row, _raw = await _stored_config(db)
    if plan.config_changed:
        # …keep what is being replaced first, in THIS session, so the write is undoable through
        # «Letzte Änderungen» like every other one (app/config_history).
        await keep_previous(db, "workbook", actor_id)
        if row is None:
            db.add(DeploymentConfig(id=1, config_json=plan.config, updated_by=actor_id))
        else:
            row.config_json = plan.config
            row.updated_by = actor_id
        await db.flush()

    if plan.roster is not None:
        await _apply_roster(db, plan)

    return WorkbookImportResult(
        sheets=plan.preview.sheets,
        warnings=plan.preview.warnings,
        emptied=plan.preview.emptied,
    )


async def _apply_roster(db: AsyncSession, plan: ImportPlan) -> None:
    """Write the Mannschaft sheet.

    Same session as the config write above, so a failure in either takes both down: a station
    must never end up with a Dienstgrade list that no longer contains the ranks its people
    point at.

    ⚠️ A person is DEACTIVATED, never deleted — every incident they were on resolves their name
    through this row (api/personnel · deactivate_person).
    """
    roster, index = plan.roster, plan.roster_index
    if roster is None or index is None:
        return
    rows = plan.mannschaft_rows
    people = {p.id: p for p in await _people(db)}
    made: dict[int, Personnel] = {}
    order = plan.name_order

    for i, target in enumerate(roster.targets):
        source = rows[i]
        rank = plan.ranks_for_row.get(i)
        person = people.get(target.person_id) if target.person_id is not None else made.get(target.owner)
        if person is None:
            person = Personnel(display_name=source.name, rank=rank, is_active=source.active)
            db.add(person)
            await db.flush()
            made[i] = person
            people[person.id] = person
        else:
            # ⚠️ Only a genuine RENAME is written. A name that already matches what the app
            # serves is left alone, so re-importing an untouched export changes nothing even
            # under `nameOrder = first-last`. And when it IS a rename the split halves go with
            # it: person_display_name rebuilds the served name from first/last where both are
            # known, so keeping them would make the rename appear to do nothing.
            if source.name != personnel_svc.person_display_name(person, order):
                person.display_name = source.name
                person.first_name = None
                person.last_name = None
            # An empty Grad cell means «not stated», not «no Dienstgrad»: a workbook whose Grad
            # column somebody cleared must not strip the rank off the whole Wehr.
            if rank is not None:
                person.rank = rank
            person.is_active = source.active
        if source.provider and source.external_id and (person.id, source.provider) not in index.providers:
            # One identity per person per provider (uq_personnel_external_person_provider); a
            # name-matched row that would contradict an existing one is left alone.
            await personnel_svc.attach_external_identity(
                db, person=person, provider=source.provider, external_id=source.external_id
            )
            index.providers.add((person.id, source.provider))
            index.by_external[(source.provider, source.external_id)] = person.id

    for person_id in plan.deactivate:
        person = people.get(person_id)
        if person is not None:
            person.is_active = False
    await db.flush()

"""Personnel (Mannschaft) endpoints: roster list + manual CRUD + CSV import +
editor-only Divera member sync."""

import csv
import io
import uuid

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import personnel as personnel_svc
from ..auth.dependencies import EditorOrAdmin, UserOrAdmin
from ..config import settings
from ..database import get_db
from ..models import Personnel, PersonnelExternalIdentity
from ..schemas import (
    PersonnelCreate,
    PersonnelOut,
    PersonnelSyncExecuteBody,
    PersonnelSyncPreview,
    PersonnelSyncResult,
    PersonnelUpdate,
)

router = APIRouter(prefix="/personnel", tags=["personnel"])


async def _identity_map(db: AsyncSession, person_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[PersonnelExternalIdentity]]:
    if not person_ids:
        return {}
    rows = list(
        (await db.execute(
            select(PersonnelExternalIdentity).where(PersonnelExternalIdentity.personnel_id.in_(person_ids))
        )).scalars()
    )
    out: dict[uuid.UUID, list[PersonnelExternalIdentity]] = {}
    for identity in rows:
        out.setdefault(identity.personnel_id, []).append(identity)
    return out


def _personnel_out(person: Personnel, identities: list[PersonnelExternalIdentity]) -> dict:
    divera = next((i.external_id for i in identities if i.provider == "divera"), None)
    try:
        legacy_divera_id = int(divera) if divera is not None else person.divera_id
    except ValueError:
        legacy_divera_id = person.divera_id
    return {
        "id": person.id, "divera_id": legacy_divera_id,
        "external_identities": [
            {"provider": i.provider, "external_id": i.external_id, "synced_at": i.synced_at}
            for i in identities
        ],
        "display_name": person.display_name, "first_name": person.first_name,
        "last_name": person.last_name, "rank": person.rank, "is_active": person.is_active,
        "updated_at": person.updated_at,
    }


@router.get("", response_model=list[PersonnelOut])
async def list_personnel(
    _user: UserOrAdmin,
    include_inactive: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """The crew roster, ordered by name. Active-only unless ``include_inactive=true``."""
    stmt = select(Personnel).order_by(Personnel.display_name)
    if not include_inactive:
        stmt = stmt.where(Personnel.is_active.is_(True))
    people = list((await db.execute(stmt)).scalars())
    identities = await _identity_map(db, [p.id for p in people])
    return [_personnel_out(p, identities.get(p.id, [])) for p in people]


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
    return _personnel_out(person, identities.get(person.id, []))


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
    return _personnel_out(person, identities.get(person.id, []))


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


@router.post("/import-csv")
async def import_csv(
    _user: EditorOrAdmin,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Import a UTF-8 CSV. ``name`` is required; ``rank`` is optional. Provider-neutral
    ``provider`` + ``external_id`` columns may upsert an externally managed record. The legacy
    ``divera_id`` column remains accepted during the compatibility window.
    """
    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Datei zu gross (max. {settings.max_upload_mb} MB)")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise HTTPException(status_code=400, detail="Datei ist nicht UTF-8 kodiert") from e

    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None or "name" not in {(f or "").strip().lower() for f in reader.fieldnames}:
        raise HTTPException(status_code=400, detail="CSV-Kopfzeile fehlt oder enthält keine Spalte 'name'")

    # Existing rows indexed by generic provider identity for optional upsert.
    existing = list((await db.execute(select(Personnel))).scalars())
    identity_rows = list((await db.execute(select(PersonnelExternalIdentity))).scalars())
    by_external = {(i.provider, i.external_id): i.personnel_id for i in identity_rows}
    by_person = {p.id: p for p in existing}
    ranks = await personnel_svc.load_roster_ranks(db)  # for the optional rank column

    imported = 0
    skipped = 0
    errors: list[str] = []

    for i, row in enumerate(reader, start=2):  # line 1 is the header
        cells = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
        name = cells.get("name", "")
        if not name:
            skipped += 1
            errors.append(f"Zeile {i}: 'name' fehlt")
            continue
        legacy_divera = cells.get("divera_id") or ""
        try:
            if legacy_divera:
                int(legacy_divera)  # legacy contract was numeric; keep rejecting malformed rows
        except ValueError:
            skipped += 1
            errors.append(f"Zeile {i}: ungültige Zahl (divera_id)")
            continue
        provider = (cells.get("provider") or ("divera" if legacy_divera else "")).lower()
        external_id = cells.get("external_id") or legacy_divera or ""
        if provider and not external_id:
            skipped += 1
            errors.append(f"Zeile {i}: provider braucht external_id")
            continue

        rank = personnel_svc.match_rank(cells.get("rank", ""), ranks)
        if cells.get("rank") and rank is None:
            errors.append(f"Zeile {i}: unbekannter Grad '{cells['rank']}' — Person ohne Grad importiert")

        identity_key = (provider, external_id) if provider and external_id else None
        if identity_key is not None and identity_key in by_external:
            person = by_person[by_external[identity_key]]
            person.display_name = name
            person.rank = rank
            person.is_active = True
        else:
            person = Personnel(
                display_name=name,
                rank=rank,
                is_active=True,
            )
            db.add(person)
            await db.flush()
            if identity_key is not None:
                await personnel_svc.attach_external_identity(
                    db, person=person, provider=provider, external_id=external_id
                )
                by_external[identity_key] = person.id
                by_person[person.id] = person
        imported += 1

    await db.flush()
    return {"imported": imported, "skipped": skipped, "errors": errors}


def _require_divera() -> None:
    if not settings.divera_access_key:
        raise HTTPException(status_code=503, detail="Divera nicht konfiguriert (kein Access Key)")


@router.post("/sync/preview", response_model=PersonnelSyncPreview)
async def sync_preview(_user: EditorOrAdmin, db: AsyncSession = Depends(get_db)):
    _require_divera()
    try:
        return await personnel_svc.build_sync_preview(db)
    except (httpx.HTTPError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"Divera nicht erreichbar: {e}") from e


@router.post("/sync/execute", response_model=PersonnelSyncResult)
async def sync_execute(
    _user: EditorOrAdmin,
    body: PersonnelSyncExecuteBody | None = None,
    db: AsyncSession = Depends(get_db),
):
    _require_divera()
    try:
        return await personnel_svc.execute_sync(db, deactivate_stale=(body or PersonnelSyncExecuteBody()).deactivate_stale)
    except (httpx.HTTPError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"Divera nicht erreichbar: {e}") from e

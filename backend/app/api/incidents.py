"""Incidents: CRUD and workspace save (optimistic concurrency + snapshots)."""

import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from .. import audit, storage
from ..alarms import is_demo_deployment
from ..auth.dependencies import CurrentEditor, CurrentUser, UserOrAdmin, _admin_session_valid
from ..database import execute_dml, get_db
from ..geocode import geocode
from ..models import Incident
from ..schemas import (
    IncidentCreate,
    IncidentFull,
    IncidentMeta,
    IncidentPatch,
    WorkspaceOut,
    WorkspacePut,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/incidents", tags=["incidents"])


#: The Einsatzdaten a correction is worth recording. Everything a reconstruction needs to say
#: «the sheet was signed with THIS address» — and nothing that is not a dispatch fact.
_TRACKED_META = ("title", "type", "priority", "address", "lng", "lat", "started_at")


def _json_safe(v: object) -> object:
    """A value the audit payload can hold. The tracked fields are strings, floats and one
    datetime; the chain hashes its payload as JSON, so a datetime has to become a string here
    rather than at serialisation time — the hash must be reproducible from the stored row."""
    return v.isoformat() if isinstance(v, datetime) else v


async def _get(db: AsyncSession, incident_id: uuid.UUID) -> Incident:
    inc = (await db.execute(select(Incident).where(Incident.id == incident_id))).scalar_one_or_none()
    if inc is None:
        raise HTTPException(status_code=404, detail="Einsatz nicht gefunden")
    return inc


@router.get("", response_model=list[IncidentMeta])
async def list_incidents(
    _user: UserOrAdmin,
    archived: bool | None = None,
    limit: int = 100,
    skip: int = 0,
    db: AsyncSession = Depends(get_db),
) -> list[Incident]:
    # IncidentMeta never carries the heavy JSONB blobs — defer them so the list (hit on open
    # and every 30 s) doesn't drag every workspace + details out of Postgres.
    q = select(Incident).options(defer(Incident.map_workspace_json), defer(Incident.details_json))
    if archived is not None:
        q = q.where(Incident.is_archived.is_(archived))
    q = q.order_by(Incident.started_at.desc()).limit(min(limit, 500)).offset(skip)
    return list((await db.execute(q)).scalars())


@router.post("", response_model=IncidentFull, status_code=status.HTTP_201_CREATED)
async def create_incident(body: IncidentCreate, user: CurrentEditor, db: AsyncSession = Depends(get_db)) -> Incident:
    # The public demo is a single living incident everyone edits — block spawning new ones
    # server-side (the UI already hides the action). Editing the existing incident stays open.
    if await is_demo_deployment(db):
        raise HTTPException(status_code=403, detail="In der Demo können keine neuen Einsätze erstellt werden.")
    if (body.lat is None) != (body.lng is None):
        raise HTTPException(status_code=422, detail="lat und lng müssen beide oder keine gesetzt sein")
    # Geocode the address via swisstopo when coords are missing (map-click is the fallback).
    if body.lat is None and body.address:
        coords = await geocode(body.address)
        if coords:
            body.lat, body.lng = coords
    inc = Incident(
        title=body.title,
        type=body.type,
        priority=body.priority,
        text=body.text,
        address=body.address,
        lat=body.lat,
        lng=body.lng,
        details_json=body.details_json,
        source="manual",
        status="offen",
        is_exercise=body.is_exercise,
        created_by=user.id,
    )
    if body.started_at:
        # The wizard sends the Alarmierungszeit field on every manual create (prefilled with
        # «now», backdated when an analog Einsatz is nachgetragen) — either way a human saw
        # and accepted it, which is what makes it an alarm time rather than an insert time.
        inc.started_at = body.started_at
        inc.started_at_source = "manual"
    db.add(inc)
    await db.flush()
    await audit.append_event(
        db,
        incident_id=inc.id,
        op_type="incident.create",
        source="status",
        user_id=user.id,
        payload={"title": inc.title, "source": inc.source},
    )
    from ..webhooks import notify_incident_created

    await notify_incident_created(db, inc)
    await db.refresh(inc)
    return inc


@router.get("/{incident_id}", response_model=IncidentFull)
async def get_incident(incident_id: uuid.UUID, _user: CurrentUser, db: AsyncSession = Depends(get_db)) -> Incident:
    return await _get(db, incident_id)


async def _latch_editor_opened(db: AsyncSession, incident_id: uuid.UUID) -> None:
    """Cross-visibility latch: stamp the FIRST authenticated-editor workspace read/write —
    the QR capture view shows it as «KP-Tablet aktiv». Deliberately once-only semantics
    (conditional UPDATE, no rows matched after the first hit): «the KP has opened this
    incident at all», never a last-active tracker. updated_at is pinned to itself so the
    latch doesn't count as a content change («geändert nach Abschluss» derives from it)."""
    await db.execute(
        update(Incident)
        .where(Incident.id == incident_id, Incident.editor_opened_at.is_(None))
        .values(editor_opened_at=func.now(), updated_at=Incident.updated_at)
    )


@router.get("/{incident_id}/workspace", response_model=WorkspaceOut)
async def get_workspace(
    incident_id: uuid.UUID,
    user: CurrentUser,
    response: Response,
    since: int | None = None,
    db: AsyncSession = Depends(get_db),
):
    # Editors latch on read too (opening an incident GETs the workspace before any edit);
    # viewers (EL-Ansicht) don't — a read-only follower is not "the KP has it".
    latch = user.role == "editor"
    # Light live-follow: on a since= poll, read ONLY the revision (a cheap int column) to decide
    # 304 — don't drag the whole workspace JSONB out of Postgres every ~2 s just to return a
    # bodyless response. The full blob is loaded only on first open or when the caller is behind.
    if since is not None:
        rev = (await db.execute(select(Incident.workspace_rev).where(Incident.id == incident_id))).scalar_one_or_none()
        if rev is None:
            raise HTTPException(status_code=404, detail="Einsatz nicht gefunden")
        if latch:
            await _latch_editor_opened(db, incident_id)
        if since == rev:
            return Response(status_code=status.HTTP_304_NOT_MODIFIED)
    inc = await _get(db, incident_id)
    if latch and since is None:
        await _latch_editor_opened(db, incident_id)
    return WorkspaceOut(workspace=inc.map_workspace_json, workspace_rev=inc.workspace_rev)


async def apply_workspace_put(
    db: AsyncSession,
    incident_id: uuid.UUID,
    body: WorkspacePut,
    *,
    user_id: uuid.UUID | None,
    source: str = "client",
) -> WorkspaceOut:
    """Shared save path for the editor endpoint and the station capture endpoint.

    Optimistic concurrency at the DB level: bump the rev only if it still equals the
    client's base_rev. A conditional UPDATE is atomic, so two editors who both read
    rev=N can't both win — the loser matches 0 rows and gets the 409 (the app-level
    check alone raced because autoflush is off and the row isn't locked).
    """
    result = await execute_dml(
        db,
        update(Incident)
        .where(Incident.id == incident_id, Incident.workspace_rev == body.base_rev)
        .values(
            map_workspace_json=body.workspace,
            workspace_rev=Incident.workspace_rev + 1,
            updated_at=func.now(),
        ),
    )
    if result.rowcount == 0:
        inc = await _get(db, incident_id)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Workspace wurde zwischenzeitlich geändert",
                "server_rev": inc.workspace_rev,
                "your_base_rev": body.base_rev,
            },
        )
    new_rev = body.base_rev + 1
    await audit.snapshot_workspace(db, incident_id=incident_id, workspace=body.workspace)
    # Record the save in the hash chain so workspace changes are replayable/attributable.
    await audit.append_event(
        db,
        incident_id=incident_id,
        op_type="workspace.save",
        source=source,
        user_id=user_id,
        payload={"rev": new_rev},
    )
    return WorkspaceOut(workspace=body.workspace, workspace_rev=new_rev)


@router.put("/{incident_id}/workspace", response_model=WorkspaceOut)
async def put_workspace(
    incident_id: uuid.UUID, body: WorkspacePut, user: CurrentEditor, db: AsyncSession = Depends(get_db)
) -> WorkspaceOut:
    await _get(db, incident_id)  # 404 if the incident doesn't exist
    await _latch_editor_opened(db, incident_id)
    return await apply_workspace_put(db, incident_id, body, user_id=user.id)


@router.patch("/{incident_id}", response_model=IncidentFull)
async def patch_incident(
    incident_id: uuid.UUID, body: IncidentPatch, user: CurrentEditor, db: AsyncSession = Depends(get_db)
) -> Incident:
    inc = await _get(db, incident_id)
    data = body.model_dump(exclude_unset=True)
    status_before = inc.status
    archived_before = inc.is_archived
    exercise_before = inc.is_exercise
    report_done_before = inc.report_done_at
    # ⚠️ Snapshot BEFORE the setattr loop. Correcting the Einsatzdaten used to leave no trace at
    # all — only the Übung toggle wrote an event — so the address on a signed rapport could differ
    # from the address the crew drove to and nothing recorded that. These are the facts a
    # reconstruction needs, and the frontend already documents `meta.change` as covering «a person
    # changing the record» (lib/replay.ts); until now only one field made that true.
    before = {k: getattr(inc, k) for k in _TRACKED_META}
    for k, v in data.items():
        setattr(inc, k, v)
    changed = {
        k: {"from": _json_safe(before[k]), "to": _json_safe(getattr(inc, k))}
        for k in _TRACKED_META
        if k in data and getattr(inc, k) != before[k]
    }
    if changed:
        await audit.append_event(
            db,
            incident_id=inc.id,
            op_type="meta.change",
            source="einsatzdaten",
            user_id=user.id,
            payload={"fields": changed},
        )
    if data.get("started_at") is not None:
        # A correction in the Einsatzdaten panel is a human asserting the Alarmierungszeit —
        # it overrides whatever the alerting system said, and it upgrades an unknown
        # (server-default) time to a known one.
        inc.started_at_source = "manual"
    if "is_exercise" in data and data["is_exercise"] != exercise_before:
        await audit.append_event(
            db,
            incident_id=inc.id,
            op_type="meta.change",
            source="status",
            user_id=user.id,
            payload={"exercise": data["is_exercise"]},
        )
    if "report_done_at" in data and data["report_done_at"] != report_done_before:
        await audit.append_event(
            db,
            incident_id=inc.id,
            op_type="status.change",
            source="status",
            user_id=user.id,
            payload={"report_done": data["report_done_at"] is not None},
        )
        if data["report_done_at"] is not None:
            from .journal import append_system_row

            # A re-completion after late corrections self-documents: the journal shows when
            # each Rapport version was declared complete.
            text = (
                "Rapport abgeschlossen"
                if report_done_before is None
                else "Rapport erneut abgeschlossen (ersetzt frühere Version)"
            )
            await append_system_row(db, inc.id, icon="check", text=text)
    if "status" in data and data["status"] != status_before:
        await audit.append_event(
            db,
            incident_id=inc.id,
            op_type="status.change",
            source="status",
            user_id=user.id,
            payload={"from": status_before, "to": data["status"]},
        )
    if "is_archived" in data and data["is_archived"] != archived_before:
        await audit.append_event(
            db,
            incident_id=inc.id,
            op_type="status.change",
            source="status",
            user_id=user.id,
            payload={"archived": data["is_archived"]},
        )
        # Archive = the end of the incident (§6 record model): the FIRST archive stamps the
        # Einsatzende; a reopen (the correction path) keeps it — rows after closed_at render
        # as Nachträge. Both transitions self-document in the journal so a record read weeks
        # later explains its own gap.
        from .journal import append_system_row

        if data["is_archived"]:
            if inc.closed_at is None:
                inc.closed_at = datetime.now(UTC)
            await append_system_row(db, inc.id, icon="flag", text="Einsatz abgeschlossen")
        else:
            await append_system_row(db, inc.id, icon="undo", text="Einsatz wiedereröffnet (Nachtrag)")
    # Self-reported crew positions live exactly as long as the Einsatz does — the promise
    # made on the phone when someone opted in. The link session that fed them is already
    # dead at this point (`_incident_still_open`), so the rows would only sit there going
    # stale; drop them the moment the Einsatz stops being open, by any of the three routes
    # that end it. Reopening a closed Einsatz does NOT resurrect them: the phones start
    # reporting again on their own, and inventing positions nobody currently vouches for
    # would be worse than an empty layer.
    if not inc.is_open:
        from ..models import PersonPosition

        await execute_dml(db, delete(PersonPosition).where(PersonPosition.incident_id == inc.id))
    await db.flush()
    await db.refresh(inc)
    return inc


@router.delete("/{incident_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_incident(
    incident_id: uuid.UUID,
    _user: CurrentEditor,
    db: AsyncSession = Depends(get_db),
    admin_session: str | None = Cookie(default=None),
) -> None:
    """Hard delete. Child rows (journal, audit chain, people, media, snapshots) go via FK CASCADE;
    their storage blobs are removed best-effort first.

    TWO doors, because they answer different questions:

    · **Übungen** — any editor, any time. An exercise is not an operational record; it exists to
      be thrown away, and needing an admin for it would make the tidy-up cost more than the
      exercise.

    · **Real Einsätze** — an ADMIN session, and only once the Einsatz is ARCHIVED. Deleting one
      destroys an Einsatzakte: the Verlauf, the hash-chained audit trail, the Anwesenheit, every
      photo and voice memo. That is a legal record, so it takes the same key as the Verwaltung
      and it cannot happen to something still running — the archive step is the operator saying
      the Einsatz is over, and it is the only moment at which «löschen» is a decision rather than
      an accident. (Was a flat 403 before, which left a real Einsatz — a mistaken duplicate, a
      test alarm taken in earnest — undeletable by anybody.)

    ⚠️ The deletion is logged at WARNING before it happens, because the audit chain that would
    otherwise record it is one of the things being deleted.
    """
    inc = await _get(db, incident_id)
    if not inc.is_exercise:
        if not await _admin_session_valid(admin_session):
            raise HTTPException(
                status_code=403, detail="Nur Übungen können gelöscht werden — ein echter Einsatz braucht die Verwaltung"
            )
        if not inc.is_archived:
            raise HTTPException(
                status_code=409, detail="Einsatz zuerst abschliessen — ein laufender Einsatz kann nicht gelöscht werden"
            )
        logger.warning(
            "ADMIN DELETE of a real incident %s (%r, started %s, archived=%s) — Verlauf, Prüfkette, "
            "Anwesenheit und Medien gehen mit.",
            inc.id,
            inc.title,
            inc.started_at,
            inc.is_archived,
        )
    from ..models import Media, WorkspaceSnapshot

    keys = list((await db.execute(select(Media.storage_key).where(Media.incident_id == incident_id))).scalars()) + list(
        (
            await db.execute(select(WorkspaceSnapshot.storage_key).where(WorkspaceSnapshot.incident_id == incident_id))
        ).scalars()
    )
    for key in keys:
        storage.delete(key)
        storage.delete(key + ".peaks.json")  # cached waveform peaks ride next to the blob
    await db.delete(inc)
    await db.flush()

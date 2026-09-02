"""Incidents: CRUD and workspace save (optimistic concurrency + snapshots)."""

import logging
import secrets
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from .. import audit, live_wait, storage
from ..alarms import is_demo_deployment
from ..auth.dependencies import (
    CurrentAtemschutzWriter,
    CurrentEditor,
    CurrentUser,
    EditorOrAdmin,
    UserOrAdmin,
    _admin_session_valid,
    is_atemschutz_link,
)
from ..database import execute_dml, get_db
from ..geocode import geocode
from ..models import INCIDENT_ACTIVE_STATUSES, Incident
from ..schemas import (
    IncidentCreate,
    IncidentFull,
    IncidentMeta,
    IncidentPatch,
    TruppsPut,
    ViewLinkOut,
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


#: What every surface says when the incident behind an id is not there. One string, because
#: it is also the answer a caller must not be able to tell apart from «not yours» — six
#: routers outside this one raise it through `get_incident_or_404` below.
INCIDENT_NOT_FOUND = "Einsatz nicht gefunden"


async def get_incident_or_404(db: AsyncSession, incident_id: uuid.UUID, *, lock: bool = False) -> Incident:
    """The incident behind a path id, or 404 — the load every incident-scoped route opens with.

    `lock` takes the row FOR UPDATE — for a check-then-set like minting a link secret, where
    two editors reading NULL in the same window would otherwise both write, and the QR the
    first one already showed encodes a secret the second one overwrote."""
    stmt = select(Incident).where(Incident.id == incident_id)
    if lock:
        stmt = stmt.with_for_update()
    inc = (await db.execute(stmt)).scalar_one_or_none()
    if inc is None:
        raise HTTPException(status_code=404, detail=INCIDENT_NOT_FOUND)
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
    return await get_incident_or_404(db, incident_id)


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


async def _rev(db: AsyncSession, incident_id: uuid.UUID) -> int:
    """The workspace revision alone — a cheap int column, no JSONB. 404 if the incident is gone."""
    rev = (await db.execute(select(Incident.workspace_rev).where(Incident.id == incident_id))).scalar_one_or_none()
    if rev is None:
        raise HTTPException(status_code=404, detail=INCIDENT_NOT_FOUND)
    return rev


@router.get("/{incident_id}/workspace", response_model=WorkspaceOut)
async def get_workspace(
    incident_id: uuid.UUID,
    user: CurrentUser,
    response: Response,
    since: int | None = None,
    wait: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """The workspace blob, or a 304 when the caller's `since` revision is still current.

    `wait=1` (only meaningful together with `since`) makes that 304 a LONG POLL: instead of
    answering «unchanged» right away and being asked again two seconds later, the request parks
    until another device's save bumps the revision — or ~20 s pass, and the answer is the same
    304 it would have been. The follower gets a cross-device edit in the time it takes to commit,
    and a quiet incident costs one request per 20 s instead of one every 2–15 s.
    """
    # Editors latch on read too (opening an incident GETs the workspace before any edit);
    # viewers (EL-Ansicht) don't — a read-only follower is not "the KP has it".
    latch = user.role == "editor"
    # Light live-follow: on a since= poll, read ONLY the revision (a cheap int column) to decide
    # 304 — don't drag the whole workspace JSONB out of Postgres just to return a bodyless
    # response. The full blob is loaded only on first open or when the caller is behind.
    if since is not None:
        # Subscribe BEFORE the read: a save committing between the two would otherwise go unheard
        # and this follower would sit out the whole timeout with the new blob already in the DB.
        async with live_wait.subscribe(live_wait.workspace_topic(incident_id)) as changes:
            rev = await _rev(db, incident_id)
            if latch:
                await _latch_editor_opened(db, incident_id)
            if since == rev and wait:
                # Commit BEFORE parking. It persists the latch above and — the load-bearing half —
                # hands the pooled DB connection back: a dozen followers asleep on a checked-out
                # connection would drain the pool and stall every write in the station.
                await db.commit()
                if await changes.wait():
                    rev = await _rev(db, incident_id)
        if since == rev:
            return Response(status_code=status.HTTP_304_NOT_MODIFIED)
    inc = await get_incident_or_404(db, incident_id)
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
        inc = await get_incident_or_404(db, incident_id)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Workspace wurde zwischenzeitlich geändert",
                "server_rev": inc.workspace_rev,
                "your_base_rev": body.base_rev,
            },
        )
    new_rev = body.base_rev + 1
    # Wake the devices long-polling this incident's workspace — once this transaction commits,
    # so they re-read the blob they are being woken for (see app/live_wait).
    live_wait.notify_after_commit(db, live_wait.workspace_topic(incident_id))
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
    await get_incident_or_404(db, incident_id)  # 404 if the incident doesn't exist
    await _latch_editor_opened(db, incident_id)
    return await apply_workspace_put(db, incident_id, body, user_id=user.id)


@router.put("/{incident_id}/workspace/trupps", response_model=WorkspaceOut)
async def put_workspace_trupps(
    incident_id: uuid.UUID,
    body: TruppsPut,
    user: CurrentAtemschutzWriter,
    db: AsyncSession = Depends(get_db),
) -> WorkspaceOut:
    """Save ONLY the Atemschutz roster — the one write shape an Atemschutz link is given.

    It exists because the whole-document PUT would hand a link holder the entire Einsatz: the
    Karte, the Pläne, the Einstellungen, all of it replaceable in one request by a phone that
    never renders any of it. Here the server's own blob is the base and exactly one key is
    replaced, so what a link can damage is bounded by what it can see.

    Not a weaker save: `base_rev` goes through the same conditional UPDATE as the full PUT, so
    a concurrent save on the FU tablet makes this the identical 409 (client 3-way-merges and
    retries) rather than a silent overwrite. Editors may use it too — same route, same rules —
    and only they latch `editor_opened_at`; a link session is not «the KP has this incident».
    """
    inc = await get_incident_or_404(db, incident_id)
    link = is_atemschutz_link(user)
    if not link:
        await _latch_editor_opened(db, incident_id)
    new_ws = {**(inc.map_workspace_json or {}), "trupps": body.trupps}
    saved = await apply_workspace_put(
        db,
        incident_id,
        WorkspacePut(workspace=new_ws, base_rev=body.base_rev),
        user_id=None if link else user.id,
        source="atemschutz-link" if link else "client",
    )
    # Only the revision goes back: the caller sent a slice and reads nothing but the rev
    # (workspaceSync · push), and a phone on one bar has no use for the whole blob per tap.
    return WorkspaceOut(workspace=None, workspace_rev=saved.workspace_rev)


@router.patch("/{incident_id}", response_model=IncidentFull)
async def patch_incident(
    incident_id: uuid.UUID, body: IncidentPatch, user: CurrentEditor, db: AsyncSession = Depends(get_db)
) -> Incident:
    inc = await get_incident_or_404(db, incident_id)
    data = body.model_dump(exclude_unset=True)
    # The public demo has exactly one prepared running incident and one prepared archive.
    # Visitors may edit their contents, but changing either lifecycle leaves the next magazine
    # reader with no promised entry point (or two running incidents) until the reset. The client
    # already blocks its own Abschluss paths; this is the server-side boundary for direct API
    # calls and older clients.
    if await is_demo_deployment(db):
        lifecycle_change = (
            ("is_archived" in data and data["is_archived"] != inc.is_archived)
            or ("report_done_at" in data and data["report_done_at"] != inc.report_done_at)
            or ("status" in data and data["status"] != inc.status and data["status"] not in INCIDENT_ACTIVE_STATUSES)
            or ("is_exercise" in data and data["is_exercise"] != inc.is_exercise)
        )
        if lifecycle_change:
            raise HTTPException(status_code=403, detail="In der Demo kann der Einsatz nicht abgeschlossen werden.")
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


# --- the Rapport's view-only link --------------------------------------------------------
#
# «So people outside our station can see everything we did, in one go.» The link opens the
# ordinary read-only viewer on ONE Einsatz — the same surface, the same allowlist and the same
# scope check as the alarm link (auth/incident_link), with two deliberate differences: it does
# not die when the Einsatz closes, and it is revoked on its own instead of by rotating the
# station's minting key.
#
# The secret IS the link. Minting is idempotent — asking twice hands back the same URL rather
# than quietly invalidating the one already sent — because «I can't find the link» must not be
# the same gesture as «I want the old one dead».


def _view_link_token(secret: str) -> str:
    from .incident_link import VIEW_TOKEN_PREFIX

    return f"{VIEW_TOKEN_PREFIX}{secret}"


@router.get("/{incident_id}/view-link", response_model=ViewLinkOut)
async def get_view_link(
    incident_id: uuid.UUID, _user: CurrentEditor, db: AsyncSession = Depends(get_db)
) -> ViewLinkOut:
    """What the Rapport shows: the live link, or that there is none."""
    inc = await get_incident_or_404(db, incident_id)
    return ViewLinkOut(
        enabled=bool(inc.view_link_key),
        token=_view_link_token(inc.view_link_key) if inc.view_link_key else None,
    )


@router.post("/{incident_id}/view-link", response_model=ViewLinkOut)
async def create_view_link(
    incident_id: uuid.UUID, user: CurrentEditor, db: AsyncSession = Depends(get_db)
) -> ViewLinkOut:
    """Mint the link, or hand back the one that already exists."""
    inc = await get_incident_or_404(db, incident_id)
    if not inc.view_link_key:
        inc.view_link_key = secrets.token_urlsafe(32)
        await db.flush()
        # Worth a row in the chain: this is the moment the Einsatzakte became readable outside
        # the station. The secret itself never goes in — an audit trail is read by more people
        # than the link is meant for.
        await audit.append_event(
            db,
            incident_id=inc.id,
            op_type="meta.change",
            source="view-link",
            user_id=user.id,
            payload={"view_link": True},
        )
    return ViewLinkOut(enabled=True, token=_view_link_token(inc.view_link_key))


@router.delete("/{incident_id}/view-link", response_model=ViewLinkOut)
async def revoke_view_link(
    incident_id: uuid.UUID, user: CurrentEditor, db: AsyncSession = Depends(get_db)
) -> ViewLinkOut:
    """Revoke it. The URL stops working AND every session already open on it ends — checked per
    request in auth/incident_link, because a link that cannot expire has to be killable."""
    inc = await get_incident_or_404(db, incident_id)
    if inc.view_link_key:
        inc.view_link_key = None
        await db.flush()
        await audit.append_event(
            db,
            incident_id=inc.id,
            op_type="meta.change",
            source="view-link",
            user_id=user.id,
            payload={"view_link": False},
        )
    return ViewLinkOut(enabled=False, token=None)


# --- the Einsatz-Link, minted from inside the app -----------------------------------------
#
# «Die Zentrale soll live mitschauen.» Exactly the link a responder taps out of an alarm — the
# station's minting key signs it, the read-only allowlist bounds it, and it dies when the Einsatz
# is closed or the key is rotated (auth/incident_link). What is new is only who can produce one:
# until now that was the alerting system alone, so handing the EL or a Nachbarwehr a live view
# mid-Einsatz was something nobody at the Schadenplatz could do.
#
# NOTHING IS STORED, and that is the difference from the two link trios above. The token is
# derived from the incident id and the station key, so there is no per-incident secret, no GET to
# read one back and no DELETE to revoke one: taking it back is rotating the key in der Verwaltung
# — which takes every alarm link with it, deliberately — or closing the Einsatz. Deriving it also
# makes minting naturally idempotent: asking twice hands back the address already circulating.

#: `IncidentEvent.source` for the row below. String(16) in the model — keep it short.
EINSATZ_LINK_SOURCE = "einsatz-link"


@router.post("/{incident_id}/einsatz-link", response_model=ViewLinkOut)
async def create_einsatz_link(
    incident_id: uuid.UUID, user: CurrentEditor, db: AsyncSession = Depends(get_db)
) -> ViewLinkOut:
    """Hand back the read-only Einsatz-Link for this Einsatz, minting it on the spot.

    Two refusals, and they are deliberately different statuses because the operator can act on
    only one of them:
      · 403 — no minting key: the whole link surface is off, exactly as the exchange answers it
        (api/incident_link · `open_link_session`). Nothing to be done on the Schadenplatz, so the
        sheet points at der Verwaltung instead of offering a retry.
      · 409 — the Einsatz is finished: an alarm link dies the moment it closes, so minting one
        would hand over an address that never worked. Not the exchange's blind 404, because the
        caller is a signed-in editor who already knows this Einsatz exists.
    """
    from .incident_link import mint_incident_link_token, no_minting_key, station_minting_key

    inc = await get_incident_or_404(db, incident_id, lock=True)
    key = await station_minting_key(db)
    if not key:
        raise no_minting_key()
    if not inc.is_open:
        raise HTTPException(
            status_code=409,
            detail="Einsatz ist abgeschlossen – dafür kann kein Einsatz-Link mehr erstellt werden",
        )

    # One row per Einsatz, not per look: the moment worth recording is «the running Lage became
    # readable outside the FU», and re-opening the sheet to show the same QR again is not a
    # second such moment. There is no stored secret to tell the two apart, so the chain itself is
    # asked. The secret never goes in — an audit trail is read by more people than the link is.
    #
    # ⚠️ The SELECT is only the fast path. What ENFORCES «one row» is the partial unique index on
    # (incident_id) where source = 'einsatz-link' (models · IncidentEvent), because check-then-
    # append is a race and the incident-row lock above does not settle it everywhere: SQLite has
    # no row locks, so on a dev machine a StrictMode double mount wrote the row twice into the
    # hash chain. The savepoint is what lets the loser lose harmlessly — the duplicate INSERT is
    # rolled back to it, the winner's row and the chain stand, and both callers get the same
    # token, which is the answer they came for either way.
    from ..models import IncidentEvent

    seen = (
        await db.execute(
            select(IncidentEvent.id)
            .where(IncidentEvent.incident_id == inc.id, IncidentEvent.source == EINSATZ_LINK_SOURCE)
            .limit(1)
        )
    ).scalar_one_or_none()
    if seen is None:
        try:
            async with db.begin_nested():
                await audit.append_event(
                    db,
                    incident_id=inc.id,
                    op_type="meta.change",
                    source=EINSATZ_LINK_SOURCE,
                    user_id=user.id,
                    payload={"einsatz_link": True},
                )
        except IntegrityError:
            pass
    return ViewLinkOut(enabled=True, token=mint_incident_link_token(str(inc.id), key))


# --- the Atemschutz link -----------------------------------------------------------------
#
# «Der am Eingang soll die Atemschutzüberwachung auf seinem eigenen Handy führen.» Minted by an
# editor from a RUNNING Einsatz, opened on a phone with no login at all, and able to reach
# exactly the Atemschutzüberwachung of that one Einsatz — the workspace `trupps` slice plus the
# journal rows and events that go with it (auth/incident_link · ATEMSCHUTZ_LINK_ALLOWED).
#
# Structurally the view link's twin — the secret IS the link, minting is idempotent, revoking
# clears the column and kills open sessions — with the alarm link's lifetime: it cannot be
# minted on a finished Einsatz and it dies when this one is closed or archived.


def _atemschutz_link_token(secret: str) -> str:
    from .incident_link import ATEMSCHUTZ_TOKEN_PREFIX

    return f"{ATEMSCHUTZ_TOKEN_PREFIX}{secret}"


@router.get("/{incident_id}/atemschutz-link", response_model=ViewLinkOut)
async def get_atemschutz_link(
    incident_id: uuid.UUID, _user: CurrentEditor, db: AsyncSession = Depends(get_db)
) -> ViewLinkOut:
    """The live link, or that there is none. Readable on a closed Einsatz too — the QR panel
    has to be able to show that a link is still standing, which is what makes revoking it a
    deliberate act rather than something forgotten."""
    inc = await get_incident_or_404(db, incident_id)
    return ViewLinkOut(
        enabled=bool(inc.atemschutz_link_key),
        token=_atemschutz_link_token(inc.atemschutz_link_key) if inc.atemschutz_link_key else None,
    )


@router.post("/{incident_id}/atemschutz-link", response_model=ViewLinkOut)
async def create_atemschutz_link(
    incident_id: uuid.UUID, user: CurrentEditor, db: AsyncSession = Depends(get_db)
) -> ViewLinkOut:
    """Mint it, or hand back the one that already exists.

    409 on a closed or archived Einsatz, the same shape as refusing to delete a running one:
    the caller is an authenticated editor who knows the Einsatz exists, so the honest answer is
    «not in this state», not the exchange's deliberately blind 404. A minted link would be dead
    on arrival anyway — `enforce_link_scope` requires the Einsatz to be open on every request.
    """
    inc = await get_incident_or_404(db, incident_id, lock=True)
    if not inc.is_open:
        raise HTTPException(
            status_code=409,
            detail="Einsatz ist abgeschlossen — für die Atemschutzüberwachung kann kein Link mehr erstellt werden",
        )
    if not inc.atemschutz_link_key:
        inc.atemschutz_link_key = secrets.token_urlsafe(32)
        await db.flush()
        # In the chain, like the view link: this is the moment somebody outside the FU could
        # write into the Einsatz. The secret itself never goes in.
        await audit.append_event(
            db,
            incident_id=inc.id,
            op_type="meta.change",
            source="atemschutz-link",
            user_id=user.id,
            payload={"atemschutz_link": True},
        )
    return ViewLinkOut(enabled=True, token=_atemschutz_link_token(inc.atemschutz_link_key))


@router.delete("/{incident_id}/atemschutz-link", response_model=ViewLinkOut)
async def revoke_atemschutz_link(
    incident_id: uuid.UUID, user: CurrentEditor, db: AsyncSession = Depends(get_db)
) -> ViewLinkOut:
    """Take it back mid-Einsatz. The URL stops working AND the phone that already has it open
    is refused on its next request (auth/incident_link · `_atemschutz_key_unchanged`)."""
    inc = await get_incident_or_404(db, incident_id)
    if inc.atemschutz_link_key:
        inc.atemschutz_link_key = None
        await db.flush()
        await audit.append_event(
            db,
            incident_id=inc.id,
            op_type="meta.change",
            source="atemschutz-link",
            user_id=user.id,
            payload={"atemschutz_link": False},
        )
    return ViewLinkOut(enabled=False, token=None)


@router.delete("/{incident_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_incident(
    incident_id: uuid.UUID,
    _actor: EditorOrAdmin,
    db: AsyncSession = Depends(get_db),
    admin_session: str | None = Cookie(default=None),
) -> None:
    """Hard delete. Child rows (journal, audit chain, people, media, snapshots) go via FK CASCADE;
    their storage blobs are removed best-effort after the database commit.

    TWO doors, because they answer different questions:

    · **Übungen** — any editor, any time. An exercise is not an operational record; it exists to
      be thrown away, and needing an admin for it would make the tidy-up cost more than the
      exercise. That is the whole point of the flag, and a Wehr that cannot clear its own
      practice runs stops marking them as practice runs. A viewer still cannot (403).

    ⚠️ The door is ``EditorOrAdmin``, not ``CurrentEditor``: the Verwaltung's own incident list
      offers this button, and /admin is reached with an ADMIN cookie that need not be
      accompanied by an editor login. Requiring both made that control fail for exactly the
      person the Verwaltung exists for.

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
    inc = await get_incident_or_404(db, incident_id)
    if await is_demo_deployment(db):
        raise HTTPException(status_code=403, detail="In der Demo können Einsätze nicht gelöscht werden.")
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
        storage.delete_after_commit(db, key)
        # Cached waveform peaks ride next to the blob. It is harmless to queue the key for
        # photos/snapshots too: delete is deliberately idempotent for absent files.
        storage.delete_after_commit(db, key + ".peaks.json")
        # …and the list/marker thumbnail (api/media · _thumb_key). Same reasoning: delete is
        # idempotent for absent files, so queueing it for audio and snapshots costs nothing.
        storage.delete_after_commit(db, key + ".thumb.jpg")
    await db.delete(inc)
    await db.flush()

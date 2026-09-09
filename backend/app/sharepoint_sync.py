"""The SharePoint pull: a scheduled poll that feeds the EXISTING importers.

**A transport, not a second importer.** Every byte this module fetches is handed to the write
path that already owns that kind of record — `plans.store_plan` for a Modul-PDF,
`admin_geodata.store_geojson` + `referenceLayers` for a layer, `admin_checklists._upsert` for a
template, and the workbook's own preview/apply planner for the Arbeitsmappe. Object ids go
through `admin_objects.object_id_for_key`, the same uuid5 the CLI and the admin UI use, so a
station that loads its plans by hand today and points at SharePoint tomorrow UPDATES its
Einsatzobjekte rather than growing a second copy of every one of them.

**Loosely configured.** `sharepoint.sources` is a list of per-AREA entries, each with its own
site/library/folder (schemas · SharePointSource). A station whose Objektpläne live on the
Kommando site and whose Geodaten live in a different library configures two entries; a station
that only has the Arbeitsmappe configures one. Nothing requires a common root, and the per-area
naming conventions apply INSIDE whatever folder each entry names.

**What makes it safe.** Four rules, and each is a place this could have gone wrong:

* **A failed or partial listing never empties a populated area.** A walk is a complete
  statement of what a folder holds, so «it holds nothing» is actionable — and the action is to
  REFUSE the run and say so, exactly as `admin_config load` refuses a file that would empty a
  section. Every one of this project's config-clobbering incidents had this shape.
* **Deletions are soft.** A file gone from SharePoint is recorded as missing on the area's
  state row and its record is left alone. The likelier cause of a vanished file is somebody
  reorganising a folder than a decision that the crew should no longer have that plan.
* **The workbook keeps its confirmation.** The connector runs the same planner the admin
  preview runs and applies it ONLY when the plan refuses nothing and empties nothing. A
  workbook that would deactivate people or clear a config section is left for a human, and the
  area reports `needs_review` until one looks.
* **Nothing is written anywhere else.** No write ever goes back to SharePoint — see
  app/sharepoint_graph.

**Change detection.** Graph's delta query is the gate: with a stored deltaLink an unchanged
folder costs one request and stops there. Anything else falls through to a full walk, whose
per-file eTags decide what is downloaded. Delta is deliberately not used to identify WHICH
file changed — Graph documents `parentReference.path` as absent from a delta response and says
to track items by id, while every convention here is read off a path. So delta answers «is
there anything to do» and the walk answers «what is there».

⚠️ A blob deleted out from under us is not noticed by an eTag comparison (the eTag still
matches what we imported). The escape hatch is `POST /api/sharepoint/sync?full=true`, which
drops the tokens and the eTag memo and re-imports everything.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

# `_upsert` is the ONE checklist write path (dataset id, storage key, version bump). Private by
# name because admin_checklists is a CLI; this connector is its second legitimate caller, not a
# copy of it.
from .admin_checklists import _upsert as store_checklist_dataset
from .admin_geodata import GeodataManifestEntry, _first_coord, _to_reference_layers, store_geojson
from .admin_objects import object_id_for_key
from .config import settings
from .config_history import keep_previous
from .credentials import get as credential
from .credentials import load as load_credentials
from .deployment_config import config_row
from .models import DeploymentConfig, ObjectSite, SharePointSyncState
from .plans import plan_max_bytes, store_plan
from .schemas import SharePointArea, SharePointConfig, SharePointSource, load_stored_config
from .sharepoint_graph import GraphAuthError, GraphClient, GraphDeltaExpiredError, GraphError, RemoteFile

logger = logging.getLogger(__name__)

AREAS: tuple[SharePointArea, ...] = ("plans", "geodata", "checklists", "workbook")

#: Fits `ReferenceDataset.module` (String(16)) and the module slugs the app draws tiles from.
#: ⚠️ Enforced HERE and not only by the column: the test database is SQLite, which does not
#: enforce a String(n) at all, so a 40-character filename would pass every local test and 500
#: on the station's Postgres.
_MODULE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$")
#: A checklist template id / geodata layer id: a plain slug, and never one carrying the ':'
#: that separates a dataset id's own segments.
_SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
#: `<template>-p12.jpg` → the diagram for page 12 of that template.
_ASSET_RE = re.compile(r"^(?P<template>.+)-p(?P<page>\d{1,4})$")
_IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp", ".svg")

#: An object key out of a plans folder name. Long enough for «alterszentrum-sonnenhalde», short
#: enough that a stray file at the wrong level cannot mint an object with a paragraph for a name.
_MAX_OBJECT_KEY = 120


def _upload_max_bytes() -> int:
    """Cap for the non-PDF payloads (GeoJSON, templates, the workbook) — the SAME knob the
    upload path is held to (`MAX_UPLOAD_MB`). A file the admin UI could not have uploaded must
    not enter through the back door either, and a second knob would be a second thing to get
    wrong. Modul-PDFs use `plans.plan_max_bytes`, which is that same number."""
    return settings.max_upload_mb * 1024 * 1024


@dataclass
class AreaOutcome:
    """What one area's run did — the row the System card renders, and the state row's content."""

    area: str
    #: 'ok' | 'unchanged' | 'refused' | 'unreachable' | 'auth_failed' | 'error' | 'needs_review'
    status: str = "ok"
    detail: str | None = None
    imported: int = 0
    skipped: int = 0
    missing: list[str] = field(default_factory=list)

    @property
    def succeeded(self) -> bool:
        """Did this run leave the area in a state the operator can trust? `needs_review` counts
        as a completed run — the listing worked and the connector is waiting on a person."""
        return self.status in ("ok", "unchanged", "needs_review")


# --- configuration ----------------------------------------------------------------------


def sharepoint_credentials() -> tuple[str, str, str] | None:
    """`(tenant, client, secret)` if all three are set, else None — fail-closed like every
    other integration: half a credential stays off rather than failing per tick."""
    tenant = credential("sharepoint_tenant_id").strip()
    client = credential("sharepoint_client_id").strip()
    secret = credential("sharepoint_client_secret").strip()
    return (tenant, client, secret) if tenant and client and secret else None


async def sharepoint_settings(db: AsyncSession) -> SharePointConfig:
    """The `sharepoint` section of the stored config document, defaults where it is silent."""
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    stored = load_stored_config((row.config_json if row else None) or {})
    return stored.sharepoint


def secret_expiry_days() -> int | None:
    """Days until the stored client secret expires, negative once it has. None if unset.

    The guaranteed failure mode of this connector is not a bug — it is the calendar. Azure caps
    a client secret at 24 months and tells nobody when it lapses; the station finds out because
    plans stopped arriving. So the date is stored beside the secret and this is what the System
    card counts down.
    """
    raw = credential("sharepoint_secret_expires").strip()
    if not raw:
        return None
    try:
        expires = datetime.fromisoformat(raw).date()
    except ValueError:
        return None
    return (expires - datetime.now(UTC).date()).days


# --- the run ----------------------------------------------------------------------------


async def sync_sharepoint(
    db: AsyncSession, *, full: bool = False, transport: httpx.AsyncBaseTransport | None = None
) -> dict[str, Any]:
    """One scheduled run over every configured area. Never raises for a remote problem.

    `full=True` drops the delta tokens and the eTag memo first, so everything is re-imported —
    the operator's answer to «the data is there but the app does not have it».

    `transport` is httpx's own injection point and is how the tests stand a whole tenant up
    without a network. It is the ONLY seam this module offers: nothing here is monkeypatched in
    the suite, so what the tests exercise is the code the station runs.
    """
    creds = sharepoint_credentials()
    config = await sharepoint_settings(db)
    if creds is None or not config.sources:
        return {"status": "disabled", "areas": {}}

    tenant, client_id, client_secret = creds
    results: dict[str, Any] = {}
    # One client and therefore one token for the whole run, closed here rather than per area.
    async with httpx.AsyncClient(timeout=120.0, transport=transport) as http:
        graph = GraphClient(http, tenant_id=tenant, client_id=client_id, client_secret=client_secret)
        for source in config.sources:
            state = await _state_row(db, source.area)
            if full:
                state.delta_token = None
                state.files = {}
            outcome = await _sync_area(db, graph, source, state)
            _record(state, outcome)
            results[source.area] = {
                "status": outcome.status,
                "imported": outcome.imported,
                "skipped": outcome.skipped,
                "missing": len(outcome.missing),
                "detail": outcome.detail,
            }
    return {"status": "ok", "areas": results}


async def _state_row(db: AsyncSession, area: str) -> SharePointSyncState:
    row = (await db.execute(select(SharePointSyncState).where(SharePointSyncState.area == area))).scalar_one_or_none()
    if row is None:
        row = SharePointSyncState(area=area, status="ok")
        db.add(row)
        await db.flush()
    return row


def _record(state: SharePointSyncState, outcome: AreaOutcome) -> None:
    """Stamp an area's report onto its row. `last_success_at` only moves on a completed run —
    a green tick left standing through a week of auth failures is the silent death this whole
    status surface exists to prevent."""
    now = datetime.now(UTC)
    state.status = outcome.status
    state.detail = outcome.detail
    state.imported = outcome.imported
    state.skipped = outcome.skipped
    state.last_run_at = now
    if outcome.succeeded:
        state.last_success_at = now
    state.missing = [{"path": p, "since": now.isoformat()} for p in outcome.missing]


def _fingerprint(source: SharePointSource) -> str:
    """The folder this state row belongs to. A config edit that repoints an area must not
    resume against the previous folder's delta token or its eTag memo."""
    return f"{source.siteUrl or ''}|{source.driveId or ''}|{source.library or ''}|{source.path}"


async def _sync_area(
    db: AsyncSession, graph: GraphClient, source: SharePointSource, state: SharePointSyncState
) -> AreaOutcome:
    """Resolve, gate on delta, walk, import what changed. Catches every remote failure: a run
    that cannot reach SharePoint leaves the deployment exactly as it was, which is always the
    safe direction — yesterday's plan opens, a missing one does not."""
    out = AreaOutcome(area=source.area)
    fingerprint = _fingerprint(source)
    if state.source_fingerprint != fingerprint:
        state.source_fingerprint = fingerprint
        state.delta_token = None
        state.drive_id = None
        state.item_id = None
        state.files = {}
        state.missing = []

    try:
        if not state.drive_id or not state.item_id:
            state.drive_id = await graph.resolve_drive(
                site_url=source.siteUrl, drive_id=source.driveId, library=source.library
            )
            state.item_id = await graph.resolve_folder(state.drive_id, source.path)
            state.delta_token = None

        known: dict[str, str] = dict(state.files or {})
        if state.delta_token and known:
            try:
                changed, token = await graph.delta(state.drive_id, state.item_id, state.delta_token)
            except GraphDeltaExpiredError:
                changed, token = [{"resync": True}], None  # too old — walk everything
            if not changed:
                state.delta_token = token or state.delta_token
                out.status = "unchanged"
                out.skipped = len(known)
                return out
            state.delta_token = token
        else:
            # No resume point: take one BEFORE the walk, so anything changed while we are
            # walking is caught by the next run rather than falling between the two.
            _, state.delta_token = await graph.delta(state.drive_id, state.item_id, "latest")

        files = await graph.walk(state.drive_id, state.item_id)
    except GraphAuthError as e:
        out.status, out.detail = "auth_failed", str(e)[:400]
        logger.warning("SharePoint %s: authentication refused — %s", source.area, e)
        return out
    except GraphError as e:
        out.status, out.detail = "unreachable", str(e)[:400]
        logger.warning("SharePoint %s: %s — nothing changed", source.area, e)
        return out

    handler = _HANDLERS[source.area]
    return await handler(db, graph, state, files, out)


# --- the empty guard --------------------------------------------------------------------


async def _refuses_to_empty(db: AsyncSession, state: SharePointSyncState, relevant: list[RemoteFile]) -> str | None:
    """The refusal message when a listing carries nothing for an area that HAS something, else
    None.

    Mirrors `admin_config load`'s refusal, for the same reason: an empty listing is far more
    often a broken sync than a decision, and the cost of being wrong runs one way. A first run
    against a genuinely empty folder is not refused — there is nothing to protect.
    """
    if relevant:
        return None
    if not (state.files or {}):
        return None
    return (
        f"the folder listed no usable files, but {len(state.files or {})} were imported from it "
        "before. Refusing the run and changing nothing — check the folder still exists and the "
        "app registration still has access to it."
    )


def _changed(state: SharePointSyncState, file: RemoteFile) -> bool:
    """Has this file changed since we last imported it? An eTag comparison — the whole point of
    a listing carrying one."""
    return (state.files or {}).get(file.path) != file.etag


def _remember(state: SharePointSyncState, files: list[RemoteFile]) -> list[str]:
    """Replace the eTag memo with what the source now holds; return the paths that went away.

    Assigned as a NEW dict rather than mutated: `files` is a JSON column, and SQLAlchemy does
    not see an in-place mutation of one.
    """
    previous = dict(state.files or {})
    state.files = {f.path: f.etag for f in files}
    return sorted(set(previous) - set(state.files))


# --- area: Objektpläne ------------------------------------------------------------------


async def _sync_plans(
    db: AsyncSession, graph: GraphClient, state: SharePointSyncState, files: list[RemoteFile], out: AreaOutcome
) -> AreaOutcome:
    """`<object-key>/<module>.pdf` — one folder per Einsatzobjekt, one PDF per Modul-Slot.

    The folder name IS the object key: it is hashed with `object_id_for_key` (uuid5), which is
    the same id `admin_objects` mints for the same key, so the CLI, the admin UI and this
    connector all address one Einsatzobjekt. An object that does not exist yet is created with
    the folder name for a name and nothing else — an admin who renames it or geocodes it keeps
    that, because nothing here overwrites a name after creation.
    """
    usable = [f for f in files if f.suffix == ".pdf" and len(f.path.split("/")) == 2]
    refusal = await _refuses_to_empty(db, state, usable)
    if refusal:
        out.status, out.detail = "refused", refusal
        return out

    wanted = {f.path for f in usable}
    for file in files:
        if file.path not in wanted:
            out.skipped += 1
            logger.info("SharePoint plans: %s is not a <Objektschlüssel>/<Modul>.pdf — skipped", file.path)

    for file in usable:
        key, _, filename = file.path.partition("/")
        module = filename[: -len(".pdf")]
        if len(key) > _MAX_OBJECT_KEY or not _MODULE_RE.match(module):
            out.skipped += 1
            logger.warning("SharePoint plans: %s has no usable object key / module slug — skipped", file.path)
            continue
        if not _changed(state, file):
            out.skipped += 1
            continue
        if file.size > plan_max_bytes():
            out.skipped += 1
            logger.warning(
                "SharePoint plans: %s is %.1f MB, over the %d MB upload cap — skipped",
                file.path,
                file.size / (1024 * 1024),
                settings.max_upload_mb,
            )
            continue
        try:
            data = await graph.download(state.drive_id or "", file, max_bytes=plan_max_bytes())
        except GraphError as e:
            out.skipped += 1
            logger.warning("SharePoint plans: %s could not be fetched (%s) — keeping what we have", file.path, e)
            continue
        if not data.startswith(b"%PDF-"):
            out.skipped += 1
            logger.warning("SharePoint plans: %s is not a PDF — skipped", file.path)
            continue
        obj = await _object_for(db, key)
        await store_plan(
            db,
            obj,
            module,
            data,
            title=None,  # keep whatever the object/admin already calls it
            source_type="sharepoint",
            fetch_url=f"sharepoint:{file.path}",
        )
        out.imported += 1

    out.missing = _remember(state, usable)
    return out


async def _object_for(db: AsyncSession, key: str) -> ObjectSite:
    """The Einsatzobjekt a plans folder addresses — created on first sight, never renamed.

    ⚠️ The id is `uuid5(OBJECT_KEY_NAMESPACE, key)`, not a fresh UUID. That is what makes this
    connector and `admin_objects` two doors onto ONE object rather than two objects: the S3 plan
    pull could not create objects at all (its index carries an address, not a key), and the
    result was a station whose scheduled pull skipped every plan until somebody loaded the
    objects by hand.
    """
    oid = object_id_for_key(key)
    obj = (await db.execute(select(ObjectSite).where(ObjectSite.id == oid))).scalar_one_or_none()
    if obj is None:
        obj = ObjectSite(id=oid, name=key, source_note="SharePoint")
        db.add(obj)
        await db.flush()
    return obj


# --- area: Geodaten ---------------------------------------------------------------------


async def _sync_geodata(
    db: AsyncSession, graph: GraphClient, state: SharePointSyncState, files: list[RemoteFile], out: AreaOutcome
) -> AreaOutcome:
    """`<layer-id>.geojson` plus an optional `<layer-id>.json` sidecar for how it draws.

    ⚠️ The layer CONFIG is rebuilt whenever anything in this folder changed, even for layers
    whose GeoJSON did not: a sidecar edit («make the hydrants blue») changes no feature and
    must still reach the map. The bytes are what eTags spare — the sidecars are a few hundred
    bytes each and are read every time the area does anything at all.
    """
    layers = [f for f in files if f.suffix == ".geojson" and "/" not in f.path]
    sidecars = {f.path[: -len(".json")]: f for f in files if f.suffix == ".json" and "/" not in f.path}
    refusal = await _refuses_to_empty(db, state, layers)
    if refusal:
        out.status, out.detail = "refused", refusal
        return out
    if not layers:
        out.missing = _remember(state, [])
        return out
    if not any(_changed(state, f) for f in [*layers, *sidecars.values()]):
        out.skipped = len(layers)
        out.missing = _remember(state, [*layers, *sidecars.values()])
        return out

    entries: list[GeodataManifestEntry] = []
    for file in layers:
        slug = file.name[: -len(".geojson")]
        if not _SLUG_RE.match(slug):
            out.skipped += 1
            logger.warning("SharePoint geodata: %s is not a usable layer id — skipped", file.path)
            continue
        meta: dict[str, Any] = {}
        sidecar = sidecars.get(slug)
        if sidecar is not None:
            meta = await _read_json(graph, state, sidecar) or {}
        try:
            entry = GeodataManifestEntry(
                id=str(meta.get("id") or slug),
                kind="geojson",
                dataset=slug,
                geojson=f"/api/reference/geo:{slug}",
                **{k: v for k, v in meta.items() if k in _SIDECAR_FIELDS},
            )
        except ValueError as e:
            out.skipped += 1
            logger.warning("SharePoint geodata: sidecar for %s is unusable (%s) — layer skipped", slug, e)
            continue

        if _changed(state, file):
            try:
                data = await graph.download(state.drive_id or "", file, max_bytes=_upload_max_bytes())
            except GraphError as e:
                out.skipped += 1
                logger.warning("SharePoint geodata: %s could not be fetched (%s)", file.path, e)
                continue
            count = _feature_count(data)
            if count is None:
                out.skipped += 1
                logger.warning("SharePoint geodata: %s is not a WGS84 FeatureCollection — skipped", file.path)
                continue
            await store_geojson(
                db,
                slug,
                data,
                label=entry.label,
                source_note=entry.sourceNote or "SharePoint",
                feature_count=count,
                source_type="sharepoint",
            )
            out.imported += 1
        else:
            out.skipped += 1
        entries.append(entry)

    if entries:
        await _merge_reference_layers(db, _to_reference_layers(entries))
    out.missing = _remember(state, [*layers, *sidecars.values()])
    return out


#: Sidecar keys that mean anything — the display half of a `ReferenceLayerConfig`. Everything
#: else in the file is ignored rather than refused: a sidecar is a station's own note file, and
#: an unknown key in it must not cost them the layer.
_SIDECAR_FIELDS = frozenset(
    {
        "group",
        "label",
        "icon",
        "vectorKind",
        "symbol",
        "color",
        "nightColor",
        "opacity",
        "maxzoom",
        "attribution",
        "autoActivate",
        "sourceNote",
    }
)


def _feature_count(data: bytes) -> int | None:
    """Feature count if this is a WGS84 `[lng, lat]` FeatureCollection, else None.

    The same check `admin_geodata validate` runs, minus its `sys.exit`: a projected LV95 export
    dropped in the folder would otherwise draw a layer somewhere off the coast of Africa and
    nothing would say why.
    """
    try:
        doc = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(doc, dict) or doc.get("type") != "FeatureCollection":
        return None
    features = doc.get("features")
    if not isinstance(features, list):
        return None
    sample = _first_coord(features)
    if sample is not None and (abs(sample[0]) > 180 or abs(sample[1]) > 90):
        return None
    return len(features)


async def _read_json(graph: GraphClient, state: SharePointSyncState, file: RemoteFile) -> dict[str, Any] | None:
    """A small JSON file from the source folder, or None if it is not readable as one."""
    try:
        raw = await graph.download(state.drive_id or "", file, max_bytes=_upload_max_bytes())
        doc = json.loads(raw)
    except (GraphError, ValueError, UnicodeDecodeError) as e:
        logger.warning("SharePoint: %s is not readable JSON (%s)", file.path, e)
        return None
    return doc if isinstance(doc, dict) else None


async def _merge_reference_layers(db: AsyncSession, incoming: list[dict[str, Any]]) -> None:
    """Write the pulled layers into `referenceLayers`, KEEPING every layer we did not pull.

    ⚠️ Merged by id rather than assigned. `admin_geodata`'s own writer replaces the section
    wholesale because a manifest is the complete statement of a station's layers; a SharePoint
    folder is not — the canton's WMS layers are loaded from a manifest and have no file in it,
    and a wholesale write here would delete them on the first poll.

    The history row is stamped `geodata`, which is what this write IS. A new source value would
    render as «Unbekannt» in Verwaltung › Letzte Änderungen, and an unattributed row on the one
    list read to find out who did what is worse than a slightly broad label.
    """
    row = await config_row(db)
    await keep_previous(db, "geodata")
    current = dict(row.config_json or {})
    pulled = {layer["id"]: layer for layer in incoming if layer.get("id")}
    kept = [layer for layer in (current.get("referenceLayers") or []) if layer.get("id") not in pulled]
    current["referenceLayers"] = [*kept, *pulled.values()]
    row.config_json = load_stored_config(current).model_dump(mode="json")


# --- area: Checklisten ------------------------------------------------------------------


async def _sync_checklists(
    db: AsyncSession, graph: GraphClient, state: SharePointSyncState, files: list[RemoteFile], out: AreaOutcome
) -> AreaOutcome:
    """`<template>.json` plus its diagrams as `<template>-p<N>.<ext>` beside it.

    No pruning, unlike `admin_checklists load`: that command holds a manifest, which is a
    complete statement of the station's checklists, and may therefore delete what it does not
    name. A poll holds a folder listing, which may be a broken one — so a template that
    disappears is reported as missing and left in place.
    """
    templates = [f for f in files if f.suffix == ".json" and "/" not in f.path]
    assets = [f for f in files if f.suffix in _IMAGE_SUFFIXES and "/" not in f.path]
    refusal = await _refuses_to_empty(db, state, templates)
    if refusal:
        out.status, out.detail = "refused", refusal
        return out

    known = {f.name[: -len(".json")] for f in templates}
    for file in templates:
        template_id = file.name[: -len(".json")]
        if not _SLUG_RE.match(template_id):
            out.skipped += 1
            logger.warning("SharePoint checklists: %s is not a usable template id — skipped", file.path)
            continue
        if not _changed(state, file):
            out.skipped += 1
            continue
        doc = await _read_json(graph, state, file)
        if doc is None or doc.get("id") != template_id or not (doc.get("phases") or doc.get("entries")):
            out.skipped += 1
            logger.warning(
                "SharePoint checklists: %s is not a ChecklistTemplate with id %r and phases/entries — skipped",
                file.path,
                template_id,
            )
            continue
        await store_checklist_dataset(
            db,
            f"checklists:{template_id}",
            "checklists",
            str(doc.get("title") or template_id),
            "SharePoint",
            json.dumps(doc, ensure_ascii=False).encode("utf-8"),
            "application/json",
            "reference",
            f"-checklists_{template_id}.json",
        )
        out.imported += 1

    for file in assets:
        stem = file.name[: -len(file.suffix)]
        match = _ASSET_RE.match(stem)
        if match is None or match.group("template") not in known:
            out.skipped += 1
            logger.info("SharePoint checklists: %s is not a «<Vorlage>-p<Seite>» diagram — skipped", file.path)
            continue
        if not _changed(state, file):
            out.skipped += 1
            continue
        template_id, page = match.group("template"), int(match.group("page"))
        try:
            data = await graph.download(state.drive_id or "", file, max_bytes=_upload_max_bytes())
        except GraphError as e:
            out.skipped += 1
            logger.warning("SharePoint checklists: %s could not be fetched (%s)", file.path, e)
            continue
        await store_checklist_dataset(
            db,
            f"checklists:{template_id}:p{page}",
            "checklists",
            None,
            None,
            data,
            _IMAGE_TYPES.get(file.suffix, "application/octet-stream"),
            "reference",
            f"-checklists_{template_id}_p{page}{file.suffix}",
        )
        out.imported += 1

    out.missing = _remember(state, [*templates, *assets])
    return out


_IMAGE_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}


# --- area: Arbeitsmappe -----------------------------------------------------------------


async def _sync_workbook(
    db: AsyncSession, graph: GraphClient, state: SharePointSyncState, files: list[RemoteFile], out: AreaOutcome
) -> AreaOutcome:
    """The station workbook — parsed by the SAME planner the admin preview runs, applied only
    when that planner refuses nothing and empties nothing.

    ⚠️ The interactive import asks for a confirmation, and this path has nobody to ask. So the
    confirmation becomes a CONDITION: an upload whose preview would have shown a refused row,
    a deactivation or an emptied config section is not applied — the area reports
    `needs_review` with the reason, and a person opens Verwaltung › Stationsdaten and decides.
    Everything else about the import is unchanged: upsert-only, one transaction, all-or-nothing.
    """
    from .api.station_workbook import apply_workbook, plan_workbook

    books = [f for f in files if f.suffix == ".xlsx" and not f.name.startswith("~$")]
    refusal = await _refuses_to_empty(db, state, books)
    if refusal:
        out.status, out.detail = "refused", refusal
        return out
    if not books:
        return out
    if len(books) > 1:
        out.status = "needs_review"
        out.detail = f"{len(books)} .xlsx files in this folder — leave exactly one, or point the source at the file."
        out.skipped = len(books)
        return out

    file = books[0]
    if not _changed(state, file):
        out.skipped = 1
        out.missing = _remember(state, books)
        return out
    try:
        data = await graph.download(state.drive_id or "", file, max_bytes=_upload_max_bytes())
    except GraphError as e:
        out.status, out.detail = "unreachable", str(e)[:400]
        return out

    plan = await plan_workbook(db, data)
    if not plan.preview.ok:
        out.status = "needs_review"
        out.detail = "the workbook has rows the import refuses: " + " · ".join(plan.preview.errors[:3])
        return out
    if plan.preview.emptied:
        out.status = "needs_review"
        out.detail = "this workbook would empty " + ", ".join(plan.preview.emptied) + " — confirm it in Verwaltung"
        return out
    deactivations = sum(s.removed_total for s in plan.preview.sheets if s.removal_kind == "deactivated")
    if deactivations:
        out.status = "needs_review"
        out.detail = f"this workbook would deactivate {deactivations} person(s) — confirm it in Verwaltung"
        return out

    await apply_workbook(db, plan, actor_id=None)
    out.imported = 1
    # ⚠️ Remembered only AFTER the apply. A workbook whose import raised must be retried on the
    # next poll, not recorded as done.
    out.missing = _remember(state, books)
    return out


_HANDLERS = {
    "plans": _sync_plans,
    "geodata": _sync_geodata,
    "checklists": _sync_checklists,
    "workbook": _sync_workbook,
}


# --- status -----------------------------------------------------------------------------


async def sharepoint_status(db: AsyncSession) -> dict[str, Any]:
    """What the admin System card renders: per area, the last run and what it did.

    Deliberately answers even when the connector is off — «nicht eingerichtet» is a state an
    operator needs to be able to read, and a card that renders nothing at all is the same shape
    on the screen as a card whose fetch failed.
    """
    await load_credentials(db)
    creds = sharepoint_credentials()
    config = await sharepoint_settings(db)
    rows = {r.area: r for r in (await db.execute(select(SharePointSyncState))).scalars()}
    areas = []
    for source in config.sources:
        row = rows.get(source.area)
        areas.append(
            {
                "area": source.area,
                "path": source.path,
                "site": source.siteUrl or (f"drive {source.driveId}" if source.driveId else None),
                "status": row.status if row else "pending",
                "detail": row.detail if row else None,
                "imported": row.imported if row else 0,
                "skipped": row.skipped if row else 0,
                "missing": len(row.missing or []) if row else 0,
                "lastRunAt": row.last_run_at.isoformat() if row and row.last_run_at else None,
                "lastSuccessAt": row.last_success_at.isoformat() if row and row.last_success_at else None,
            }
        )
    return {
        "configured": creds is not None and bool(config.sources),
        "credentials": creds is not None,
        "intervalMinutes": config.intervalMinutes,
        "secretExpiresInDays": secret_expiry_days(),
        "areas": areas,
    }


__all__ = [
    "AREAS",
    "AreaOutcome",
    "secret_expiry_days",
    "sharepoint_credentials",
    "sharepoint_settings",
    "sharepoint_status",
    "sync_sharepoint",
]

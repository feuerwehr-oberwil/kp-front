"""Per-station deployment config: public GET (branding before login) + editor PUT.

The config document shape is defined in docs/CONFIGURATION.md §1 and validated through
``DeploymentConfigIn`` in schemas.py. The singleton row (id=1) is seeded empty on startup.

Response contract (both GET and PUT return the SAME projection ``DeploymentConfigOut``):

    {
      "identity": { "appName": null, "locale": null, "accentColor": null,
                    "assets": {"logo": null, "iconPng192": null, "iconPng512": null, "favicon": null},
                    "helpIntro": null },
      "map": { "defaultView": {"center": null, "centerLv95": null, "zoom": null},
               "geocoder": {"defaultLocality": null, "bboxLv95": null} },
      "referenceLayers": [ { "id": ..., "group": ..., "label": ..., "icon": ...,
                             "kind": "wms"|"wmts"|"geojson", "tiles": [...]|null,
                             "geojson": ...|null, "vectorKind": ..., "symbol": ...,
                             "color": ..., "nightColor": ..., "opacity": ...,
                             "maxzoom": ..., "attribution": ... } ],
      "fleet": { "attributeLists": [ {"symbol": ..., "field": ..., "options": [...]} ],
                 "vehicleTypes": [], "luefterTypes": [], "kleinloeschTypes": [],   # legacy
                 "partner": {"feuerwehr": [], "sanitaet": [], "polizei": [],
                             "chemiewehr": [], "zivilschutz": []} },
      "doctrine": { "defaultFunkkanal": null, "funkkanalMin": null, "funkkanalMax": null,
                    "alarmBar": null, "contactIntervalMin": null,
                    "contactGraceSec": null, "defaultPressureBar": null,
                    "pressureStep": null, "pressureMax": null },
      "roster": { "source": "manual"|"divera"|null },
      "alarmKeywords": null | { … },   # ADMIN SESSIONS ONLY — withheld from anonymous GET
      "integrations": { "diveraConfigured": bool, "traccarConfigured": bool },  # env-derived
      "alarmVocabulary": { "source": "shipped"|"deployment", "schemaVersion": int,
                           "titleKeywords": int, "highPriorityKeywords": int,
                           "fallbackCategory": str },                           # derived
      "version": str                     # opaque token of the STORED document — send it back as
                                         # If-Match on the next PUT (see put_config)
    }

Never exposes ``updated_by``, raw secrets, or API keys. On a fresh / empty / corrupt DB
row, GET serves the safe empty config above — never 404, never 500.
"""

import hashlib
import json
import logging

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..alarm_keywords import SHIPPED
from ..auth.dependencies import CurrentAdmin, OptionalUser, _admin_session_valid
from ..config_history import changed_sections, emptied_sections, keep_previous
from ..credentials import load as load_credentials
from ..database import get_db
from ..i18n import set_locale
from ..models import DeploymentConfig, DeploymentConfigHistory, User
from ..providers import integrations
from ..schemas import (
    AlarmVocabularyStatus,
    ConfigHistoryEntry,
    DeploymentConfigIn,
    DeploymentConfigOut,
    load_stored_config,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/config", tags=["config"])


def _alarm_vocabulary(doc: DeploymentConfigIn) -> AlarmVocabularyStatus:
    """Which alarm vocabulary this deployment classifies with, in five fields.

    The full block is already in the document, but «are we on the shipped words or our own»
    should not require reading 40 keywords to answer — least of all at 3am, when the question
    is usually «why was that alarm not HIGH».
    """
    if doc.alarmKeywords is None:
        return AlarmVocabularyStatus(
            source="shipped",
            schemaVersion=SHIPPED.schema_version,
            titleKeywords=len(SHIPPED.keyword_to_category),
            highPriorityKeywords=len(SHIPPED.high_priority_keywords),
            fallbackCategory=SHIPPED.fallback_category,
        )
    block = doc.alarmKeywords
    return AlarmVocabularyStatus(
        source="deployment",
        schemaVersion=block.schema_version,
        titleKeywords=len(block.keyword_to_category.pairs),
        highPriorityKeywords=sum(len(g.keywords) for g in block.high_priority_keywords.groups),
        fallbackCategory=block.fallback_category,
    )


def _version(doc: dict | None) -> str:
    """The version token of a stored config document: a hash of its CONTENT.

    ⚠️ Content, not ``updated_at``. A timestamp is the obvious choice and the wrong one — SQLite
    stores it to the second and Postgres' ``now()`` is transaction-start time, so two saves
    inside one second are indistinguishable and the check silently passes exactly when a
    conflict is most likely. A hash needs no column, no migration and no clock.

    It also gives the right answer to the case a timestamp gets wrong in the other direction:
    re-saving a document somebody else has already saved IDENTICALLY is not a conflict, because
    nothing the caller has is out of date.
    """
    return hashlib.sha256(json.dumps(doc or {}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


def _projection(
    doc: DeploymentConfigIn,
    *,
    include_keywords: bool = True,
    include_links: bool = True,
    version: str | None = None,
) -> DeploymentConfigOut:
    """Validated document + env-derived integration flags → the response projection.

    ``include_keywords=False`` withholds the ``alarmKeywords`` block. GET is public so the
    login screen can brand itself, and a station's whole alarm vocabulary is the one section
    with no unauthenticated reader: matching happens server-side and nothing in the frontend
    reads it. Publishing it would be surface for nothing.

    ``include_links=False`` empties ``report.links`` — the station's own Formulare (see
    lib/reportLinks). Those URLs are CAPABILITIES: a Google-Forms prefill link is submittable by
    anyone who has it, and the list also names a Wehr's internal paperwork and the hosts it
    lives on. There is no unauthenticated reader for them — only the Rapport shows them, and the
    Rapport is behind the PIN.

    An anonymous caller therefore sees ``links: []``, which is byte-identical to what a station
    that has configured none returns: the withholding does not announce itself. (Removing the
    key is not an option anyway — ``DeploymentConfigOut`` types the section, so the field comes
    back with its default whatever the dict says.)

    The ``alarmVocabulary`` SUMMARY stays public either way — it carries counts and which
    source is active, never the words — because "is my override live?" must be answerable
    without a session.

    ⚠️ Withholding either from an ADMIN would be a data-loss bug, not a tightening: the admin UI
    does a full-document PUT (GET → draft → PUT), so a config the admin never received is a
    config the next unrelated edit silently deletes. Hence the flags rather than a blanket drop.
    """
    payload = doc.model_dump()
    if not include_keywords:
        payload.pop("alarmKeywords", None)
    if not include_links:
        payload["report"] = {**(payload.get("report") or {}), "links": []}
    return DeploymentConfigOut(
        **payload,
        integrations=integrations(),
        alarmVocabulary=_alarm_vocabulary(doc),
        version=version,
    )


def _keep_assets(stored: dict | None, incoming: dict) -> dict:
    """Carry ``identity.assets`` from the stored document into an incoming full-document write.

    ⚠️ The branding slots are the one part of this document nobody TYPES. They are written by
    the upload endpoints (app/api/branding.py) and by ``admin_branding push``, because the URLs
    inside them only exist once a blob has been stored — and yet they live inside the document
    that the admin UI replaces wholesale on every autosave.

    So any full-document write could strip them, and repeatedly did: the Verwaltung holds the
    config in a client-side draft, and a draft loaded BEFORE a logo was installed (from the CLI,
    from another device, by the nightly demo reset) puts the logo back to null the next time
    anybody nudges an unrelated field. No error, no diff to look at, just a login screen with no
    brandmark and a Rapport with no letterhead. That is how the public demo lost its logo three
    times, and it is the same trap for a station.

    Not solvable in the model: ``DeploymentConfigIn`` fills missing sections with defaults, so by
    the time the body is validated «assets were not mentioned» and «assets were cleared» are the
    same null. Hence the rule is positional instead — the document body is not where assets are
    edited, the branding endpoints are, and DELETE ``/api/branding/{slot}`` is how one is removed.
    """
    kept = {k: v for k, v in (((stored or {}).get("identity") or {}).get("assets") or {}).items() if v}
    if not kept:
        return incoming
    identity = dict(incoming.get("identity") or {})
    identity["assets"] = {**(identity.get("assets") or {}), **kept}
    return {**incoming, "identity": identity}


@router.get("", response_model=DeploymentConfigOut)
async def get_config(
    db: AsyncSession = Depends(get_db),
    actor: OptionalUser = None,
    admin_session: str | None = Cookie(default=None),
) -> DeploymentConfigOut:
    """PUBLIC (no auth) — the login screen needs branding before login.

    Two sections are withheld from ANONYMOUS callers, and each for its own reason:

    * ``alarmKeywords`` — admin only; nothing in the frontend reads it (see ``_projection``).
    * ``report.links`` — the station's own Formulare. Withheld from anonymous callers but
      served to any SIGNED-IN one (PIN user or admin), because the Rapport that shows them is
      itself behind the PIN. A prefill URL is a capability — whoever has it can submit to that
      form — so «anyone who can reach the login screen» is the wrong audience for it.

    ⚠️ The app reads this at BOOT, before login, so a first fetch on a fresh device legitimately
    comes back without the links; ``AuthProvider.login`` re-reads the config on the way in (see
    lib/auth), and every later boot already carries the session cookie.

    Last-good fallback: if the persisted ``config_json`` is missing or fails validation
    (e.g. a hand-edited bad row), serve a safe empty config and log a warning. Never raises.

    ⚠️ Read through ``load_stored_config``, not the strict PUT-body model: a field that has
    grown a rule since the row was written (``identity.accentColor``) must be dropped, not
    refused. Refusing it lands in the fallback below — and answering one bad colour by serving
    the login screen a station with no name, no logo and no fleet is the wrong trade.
    """
    # `integrations` in the projection is derived from the credential store, so refresh it —
    # otherwise a station that just connected Divera would keep seeing «nicht konfiguriert»
    # on the surface it went to check.
    await load_credentials(db)
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    raw = row.config_json if (row and row.config_json) else {}
    try:
        doc = load_stored_config(raw)
    except Exception:  # noqa: BLE001 — never let a bad stored row brick GET
        logger.warning("deployment_config row failed validation; serving empty fallback", exc_info=True)
        doc = DeploymentConfigIn()
    is_admin = await _admin_session_valid(admin_session)
    return _projection(
        doc,
        include_keywords=is_admin,
        include_links=is_admin or actor is not None,
        version=_version(raw),
    )


@router.get("/meta")
async def get_config_meta(
    _admin: CurrentAdmin,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Admin-only audit metadata for the singleton config row: when it was last saved
    and who saved it (resolved display name). Returns plain nulls on a fresh / unstamped row.
    """
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        return {"updated_at": None, "updated_by_name": None}
    name: str | None = None
    if row.updated_by is not None:
        name = (await db.execute(select(User.display_name).where(User.id == row.updated_by))).scalar_one_or_none()
    updated_at = row.updated_at.isoformat() if row.updated_at else None
    return {"updated_at": updated_at, "updated_by_name": name}


@router.put("", response_model=DeploymentConfigOut)
async def put_config(
    body: DeploymentConfigIn,
    _admin: CurrentAdmin,
    actor: OptionalUser,
    db: AsyncSession = Depends(get_db),
    if_match: str | None = Header(default=None, alias="If-Match"),
    sec_fetch_site: str | None = Header(default=None, alias="Sec-Fetch-Site"),
    origin: str | None = Header(default=None, alias="Origin"),
) -> DeploymentConfigOut:
    """Admin-only. Validates the body (422 on invalid), persists the document to the
    singleton row, stamps ``updated_by`` (the admin's user when driving the UI, NULL for
    a CLI push), and returns the same projection as GET.

    ⚠️ ``identity.assets`` is NOT taken from the body — see ``_keep_assets``.

    ⚠️ ``If-Match`` carries the ``version`` the caller last read. This is a FULL-DOCUMENT
    replace and the Verwaltung autosaves, so a browser tab holding a draft from an hour ago
    reverted everything anybody had changed since — the whole document, silently, on the next
    nudge of one unrelated field. That is how the public demo lost its Dienstgrade, its
    Partnerorganisationen, its Atemschutz-Doktrin (including the Alarmdruck) and the point on
    its «Stk.» in one write, and it is the same trap for a station with two admins.

    Sent and stale → 409, and the client re-reads before deciding.

    ⚠️ A BROWSER MUST SEND IT. Making the header merely optional left the hole it was meant to
    close: the guard only protects tabs new enough to know about it, and the tab that does the
    damage is by definition an OLD one — it was open before the fix shipped, so it sends no
    header and is then indistinguishable from a CLI push. The demo was clobbered a second time
    that way, hours after the guard went live. A browser always sends `Sec-Fetch-Site` (and, on
    a cross-origin write, `Origin`); httpx and curl send neither unless told to, so
    ``admin_config load``, ``admin_geodata`` and ``admin_branding`` keep working untouched —
    those are one-shot pushes by somebody at a terminal, not a tab open since breakfast. The
    backup IMPORT is a browser and therefore sends the header too: it re-reads the version
    immediately before writing (admin/ConfigBackup), which is what keeps «replace everything
    with this file» deliberate without letting an hour-old page do it by accident.
    A browser that omits it gets 428 (Precondition Required): the request is not wrong, it is
    missing the one thing that makes it safe, and the fix is to reload the page.
    """
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    stored_version = _version(row.config_json if row else None)
    from_browser = sec_fetch_site is not None or origin is not None
    if if_match is None and from_browser:
        raise HTTPException(
            status_code=428,
            detail="Diese Seite ist veraltet. Bitte neu laden und die Änderung wiederholen.",
            headers={"ETag": stored_version},
        )
    if if_match is not None and if_match.strip('"') != stored_version:
        raise HTTPException(
            status_code=409,
            detail="Die Konfiguration wurde inzwischen an anderer Stelle geändert.",
            headers={"ETag": stored_version},
        )
    # Persist the normalized document (defaults filled in) so GET round-trips consistently.
    doc_json = _keep_assets(row.config_json if row else None, body.model_dump(mode="json"))
    actor_id = actor.id if actor else None
    # …and keep what is being replaced, so this write is undoable whatever it turns out to have
    # been (app/config_history). Best-effort by design: the net must never drop the write.
    await keep_previous(db, "api", actor_id)
    if row is None:
        row = DeploymentConfig(id=1, config_json=doc_json, updated_by=actor_id)
        db.add(row)
    else:
        row.config_json = doc_json
        row.updated_by = actor_id
    await db.flush()
    # Refresh the cached locale used for error-detail i18n.
    set_locale(body.identity.locale if body.identity else None)
    # …and the cached alarm vocabulary, so a saved keyword list is live on the next alarm
    # rather than up to a TTL later. Lazy import: divera pulls in the intake graph.
    from ..divera import reset_vocabulary_cache

    reset_vocabulary_cache()
    # …the PERSISTED document, not the body: they differ by the carried-over branding slots, and
    # the admin UI re-seeds its draft from this response — echoing the body would hand it back
    # the very nulls that were just refused, ready to be written again on the next edit.
    return _projection(DeploymentConfigIn.model_validate(doc_json), version=_version(doc_json))


@router.get("/history", response_model=list[ConfigHistoryEntry])
async def list_config_history(
    _admin: CurrentAdmin,
    db: AsyncSession = Depends(get_db),
    limit: int = 30,
) -> list[ConfigHistoryEntry]:
    """The kept previous configurations, newest first — the undo for the most destructive
    operation this app has.

    ⚠️ This existed only as a shell command (``admin_config history`` / ``restore``) while being
    the recovery path for a failure that has now happened four times. The table was write-only
    from a browser's point of view: every write kept its predecessor and nobody could see them.

    Each entry says WHERE the write came from and **what that write did**: `emptied` for sections
    that had content before and none after (the shape of the damage every time), and `sections`
    for what it CHANGED. `replaced_by` resolves to a display name where a person was behind it,
    and stays null for a CLI push, which is itself a useful distinction: «via api, nobody» is what
    an unattended writer looks like.

    ⚠️ `sections` used to list what a kept document CONTAINED, which — because every writer
    replaces the whole document — was the identical nine section names on every row: 26 rows of
    «alarms, doctrine, fleet, identity, journal, map, mittel, report, roster» after one afternoon
    of setting a station up. A list nobody can tell apart cannot answer «which entry do I go back
    to?». It now carries `changed_sections(kept, successor)` instead — one line per row that
    differs from its neighbours. Nothing about what is STORED changed.
    """
    rows = (
        (
            await db.execute(
                select(DeploymentConfigHistory)
                .order_by(DeploymentConfigHistory.replaced_at.desc())
                .limit(max(1, min(limit, 200)))
            )
        )
        .scalars()
        .all()
    )

    # who, for the entries that have a user behind them
    ids = {r.replaced_by for r in rows if r.replaced_by}
    names: dict[object, str] = {}
    if ids:
        for u in (await db.execute(select(User).where(User.id.in_(ids)))).scalars():
            names[u.id] = u.display_name

    current = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    live = (current.config_json if current else None) or {}

    out: list[ConfigHistoryEntry] = []
    # `rows` is newest-first, so the document that REPLACED entry i is entry i-1's kept copy —
    # and for the newest entry it is the live document. That is what makes "what did this write
    # change/empty" answerable at all: an entry stores the state BEFORE a write, never the write
    # itself. ⚠️ The OLDEST row in the page has no predecessor here, but it does not need one:
    # both answers are about the write that came AFTER the kept document, never before it.
    for i, r in enumerate(rows):
        successor = (rows[i - 1].config_json if i > 0 else live) or {}
        out.append(
            ConfigHistoryEntry(
                id=r.id,
                replacedAt=r.replaced_at,
                source=r.source,
                replacedBy=names.get(r.replaced_by) if r.replaced_by else None,
                sections=changed_sections(r.config_json, successor),
                emptied=emptied_sections(r.config_json, successor),
            )
        )
    return out


@router.post("/history/{entry_id}/restore", response_model=DeploymentConfigOut)
async def restore_config(
    entry_id: int,
    _admin: CurrentAdmin,
    actor: OptionalUser,
    db: AsyncSession = Depends(get_db),
) -> DeploymentConfigOut:
    """Put a kept configuration back.

    The document being replaced is kept first, so a restore is as undoable as anything else —
    including a restore of the wrong entry, which is the mistake somebody makes while hurrying
    to fix a clobber.
    """
    entry = (
        await db.execute(select(DeploymentConfigHistory).where(DeploymentConfigHistory.id == entry_id))
    ).scalar_one_or_none()
    if entry is None or not entry.config_json:
        raise HTTPException(status_code=404, detail=f"Kein aufbewahrter Stand mit der Nummer {entry_id}.")

    # ⚠️ Validate before writing. A document kept by an OLDER build can contain sections this one
    # no longer accepts; writing it unvalidated would put the row into the state that makes
    # GET fall back to an empty config — i.e. the restore would look like a worse clobber.
    # …but as a STORED document (`load_stored_config`): the history is the recovery path after a
    # clobber, and refusing to give a station its fleet and roster back because a colour kept in
    # 2026 no longer passes today's rule would break the one thing this endpoint is for. Such a
    # field comes back unset; everything else comes back.
    try:
        doc = load_stored_config(entry.config_json)
    except Exception as e:  # the message is for a person, not a caller
        raise HTTPException(
            status_code=422,
            detail=f"Dieser Stand lässt sich mit der laufenden Version nicht wiederherstellen: {e}",
        ) from e

    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    await keep_previous(db, "api", actor.id if actor else None)
    # ⚠️ The brandmark is carried from the LIVE document, not taken from the restored one — the
    # same rule a PUT follows. Restoring a config from before a logo upload must not delete the
    # logo: the asset URLs are written by the upload endpoints and point at blobs that exist now.
    doc_json = _keep_assets(row.config_json if row else None, doc.model_dump(mode="json"))
    if row is None:
        row = DeploymentConfig(id=1, config_json=doc_json, updated_by=actor.id if actor else None)
        db.add(row)
    else:
        row.config_json = doc_json
        row.updated_by = actor.id if actor else None
    # ⚠️ COMMIT here, not at dependency teardown. `get_db` commits after the response has been
    # returned, and this is the one endpoint whose caller immediately re-reads what it just
    # wrote: the Verwaltung refreshes «Letzte Änderungen» so the restored-over document appears
    # as a new entry. Against the teardown commit that refetch races and loses — the list came
    # back one row short and only a page reload showed the truth, which on an undo list reads as
    # «the restore did not take».
    await db.commit()
    set_locale(doc.identity.locale if doc.identity else None)
    from ..divera import reset_vocabulary_cache

    reset_vocabulary_cache()
    return _projection(DeploymentConfigIn.model_validate(doc_json), version=_version(doc_json))

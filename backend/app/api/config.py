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
from ..database import get_db
from ..i18n import set_locale
from ..models import DeploymentConfig, User
from ..providers import integrations
from ..schemas import AlarmVocabularyStatus, DeploymentConfigIn, DeploymentConfigOut

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
    doc: DeploymentConfigIn, *, include_keywords: bool = True, version: str | None = None
) -> DeploymentConfigOut:
    """Validated document + env-derived integration flags → the response projection.

    ``include_keywords=False`` withholds the ``alarmKeywords`` block. GET is public so the
    login screen can brand itself, and a station's whole alarm vocabulary is the one section
    with no unauthenticated reader: matching happens server-side and nothing in the frontend
    reads it. Publishing it would be surface for nothing.

    The ``alarmVocabulary`` SUMMARY stays public either way — it carries counts and which
    source is active, never the words — because "is my override live?" must be answerable
    without a session.

    ⚠️ Withholding it from an ADMIN would be a data-loss bug, not a tightening: the admin UI
    does a full-document PUT (GET → draft → PUT), so a config the admin never received is a
    config the next unrelated edit silently deletes. Hence the flag rather than a blanket drop.
    """
    payload = doc.model_dump()
    if not include_keywords:
        payload.pop("alarmKeywords", None)
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
    admin_session: str | None = Cookie(default=None),
) -> DeploymentConfigOut:
    """PUBLIC (no auth) — the login screen needs branding before login.

    One section is withheld from anonymous callers: ``alarmKeywords``. See ``_projection``.
    An admin session gets the full document, because the admin UI round-trips it.

    Last-good fallback: if the persisted ``config_json`` is missing or fails validation
    (e.g. a hand-edited bad row), serve a safe empty config and log a warning. Never raises.
    """
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    raw = row.config_json if (row and row.config_json) else {}
    try:
        doc = DeploymentConfigIn.model_validate(raw)
    except Exception:  # noqa: BLE001 — never let a bad stored row brick GET
        logger.warning("deployment_config row failed validation; serving empty fallback", exc_info=True)
        doc = DeploymentConfigIn()
    return _projection(doc, include_keywords=await _admin_session_valid(admin_session), version=_version(raw))


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

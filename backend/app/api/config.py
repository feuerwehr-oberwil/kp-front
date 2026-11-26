"""Per-station deployment config: GET (a short public list before login, the document with a
session) + editor PUT.

The config document shape is defined in docs/CONFIGURATION.md §1 and validated through
``DeploymentConfigIn`` in schemas.py. The singleton row (id=1) is seeded empty on startup.

Who reads what: a caller WITHOUT a session gets ``PUBLIC_PARTS`` and nothing else, the
Erfassungs-Poster gets ``CAPTURE_PARTS`` on its own route (api/capture), and every session gets
the projection below. A part somebody adds later is on neither list, so it is withheld until
somebody lists it.

Response contract (GET with a session and PUT return the SAME projection ``DeploymentConfigOut``):

    {
      "identity": { "appName": null, "shortName": null, "locale": null, "accentColor": null,
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
                 "origins": [str],                                                  # «Herkunft»
                 "vehicleTypes": [], "luefterTypes": [], "kleinloeschTypes": [],   # legacy
                 "partner": {"feuerwehr": [], "sanitaet": [], "polizei": [],
                             "chemiewehr": [], "zivilschutz": []} },
      "doctrine": { "defaultFunkkanal": null, "funkkanalMin": null, "funkkanalMax": null,
                    "alarmBar": null, "alarmBarRueckzug": null, "contactIntervalMin": null,
                    "contactGraceSec": null, "defaultPressureBar": null, "entryPressureMin": null,
                    "pressureStep": null, "pressureMax": null },
      "roster": { "source": "manual"|"divera"|null },
      "alarmKeywords": null | { … },   # ADMIN SESSIONS ONLY
      "integrations": { "diveraConfigured": bool, "traccarConfigured": bool },  # env-derived
      "alarmVocabulary": { "source": "shipped"|"deployment", "schemaVersion": int,
                           "titleKeywords": int, "highPriorityKeywords": int,
                           "fallbackCategory": str },                           # derived
      "categoryLabels": { str: str },   # derived: category key → German label (app/divera),
                                         # the Einsatz wizard's Kategorie picker, in its order
      "version": str,                    # opaque token of the STORED document — send it back as
                                         # If-Match on the next PUT (see put_config)
      "warnings": [str]                  # PUT only: keys the schema dropped, layers that cannot
                                         # resolve. Always [] on GET.
    }

Never exposes ``updated_by`` or server secrets. The one deliberate client credential is
``integrations.cartoBasemapKey``: CARTO requires it in browser tile URLs, so domain restrictions
rather than secrecy protect it. It is on no public list, so it reaches sessions only. On a fresh /
empty / corrupt DB row, GET serves the safe empty config above (a value past a length limit
costs only its entry) — never 404, never 500.

Every config write takes ``config_row(lock=True)`` BEFORE checking a version or deriving a
replacement. If-Match alone is a check-then-write race: overlapping requests could both accept
one version, discard one accepted change and keep the original twice in history.
"""

import hashlib
import json
import logging
from collections.abc import Iterable

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..alarm_keywords import SHIPPED
from ..auth.dependencies import CurrentAdmin, DeviceUser, OptionalUser, _admin_session_valid, is_link_session
from ..auth.incident_link import link_page_owns_session, read_link_session
from ..config import settings
from ..config_guard import (
    carry_runtime_sections,
    document_warnings,
    emptied_declared_sections,
    format_validation_errors,
)
from ..config_history import changed_sections, emptied_sections, keep_previous
from ..credentials import load as load_credentials
from ..database import get_db
from ..deployment_config import config_row, safe_config
from ..divera import CATEGORY_LABELS
from ..i18n import set_locale
from ..models import DeploymentConfig, DeploymentConfigHistory, User
from ..providers import integrations
from ..schemas import (
    AlarmVocabularyStatus,
    ConfigHistoryEntry,
    ConfigValidationResult,
    DeploymentConfigIn,
    DeploymentConfigOut,
    load_stored_config,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/config", tags=["config"])

#: Everything ``GET /api/config`` hands a caller WITHOUT a session (owner pick, 20.11.2026): what
#: the app draws before anybody is signed in — the start cover, the login screen, a link page
#: before its exchange, the Erfassungs-Poster's frame. Dotted paths into the response.
#:
#: ⚠️ An ALLOW-list on purpose. Until 20.11.2026 this route withheld five named sections and
#: served the rest, so every section added later was public by default: the fleet, the radio
#: channels, the alarm groups and the Kommandant's name all reached anybody who asked. A new part
#: is on this list only when the screens above cannot be drawn without it.
PUBLIC_PARTS: tuple[str, ...] = (
    "identity.appName",
    "identity.shortName",
    "identity.locale",
    "identity.accentColor",
    "identity.assets",
    # the demo ribbon, the demo's automatic login and the note on its login screen
    "identity.demoMode",
    "identity.demoNote",
    # draws «Mit Microsoft anmelden» on the login screen
    "integrations.microsoftLoginConfigured",
)

#: What the Erfassungs-Poster gets with its token (``GET /api/capture/config``): the pickers of
#: its form — Fahrzeuge, Alarmgruppen, the rank order of the Anwesenheit, the Material catalogue,
#: the Partnerorganisationen — and the three values its Rapport-PDF is composed with. Without
#: those three a Rapport printed from the poster would differ from the tablet's for the same
#: Einsatz: other Einsatzstunden, other stretches on the Personalblatt, no name on the
#: Kommandant's signature line.
CAPTURE_PARTS: tuple[str, ...] = (
    "fleet.vehicles",
    "alarms.groups",
    "roster.ranks",
    "mittel.catalogue",
    "report.partnerOrgs",
    "report.hoursRounding",
    "report.attendanceMergeGapMin",
    "identity.kommandant",
)


def pick_parts(document: dict, parts: Iterable[str]) -> dict:
    """Only the named parts of a config document, in the document's own shape.

    ``parts`` are dotted paths (``PUBLIC_PARTS``, ``CAPTURE_PARTS``). Whatever they do not name
    is ABSENT from the result, not emptied: the caller's device merges such an answer over the
    copy it holds (src/lib/deploymentConfig · mergePartial), and an emptied section would wipe
    that copy.
    """
    out: dict = {}
    for part in parts:
        *parents, leaf = part.split(".")
        source: object = document
        for key in parents:
            source = source.get(key) if isinstance(source, dict) else None
        if not isinstance(source, dict) or leaf not in source:
            continue
        target = out
        for key in parents:
            target = target.setdefault(key, {})
        target[leaf] = source[leaf]
    return out


async def stored_document(db: AsyncSession) -> tuple[DeploymentConfigIn, dict]:
    """The stored config as a validated document, plus the raw JSON it came from.

    The validated half is ``deployment_config · safe_config``: a missing row or one that fails
    validation (a hand-edited bad row) reads as the safe empty document, a value past a length
    limit as the document without its entry. Never raises. The raw
    half is read on purpose — the ``version`` is a hash of the JSON as stored.
    """
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    raw = row.config_json if (row and row.config_json) else {}
    return safe_config(row.config_json if row else None), raw


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
    include_internal: bool = True,
    include_filing: bool = True,
    version: str | None = None,
    warnings: list[str] | None = None,
) -> DeploymentConfigOut:
    """Validated document + env-derived integration flags → the response projection.

    This is what a SESSION reads. A caller without one never gets this object: ``get_config``
    cuts it down to ``PUBLIC_PARTS``. The flags below say what each KIND of session is still
    refused, each for its own reason.

    ``include_keywords=False`` withholds the ``alarmKeywords`` block — a station's whole alarm
    vocabulary. Matching happens server-side and nothing in the frontend reads it, so only an
    admin session, whose /admin edits the document, gets it.

    ``include_links=False`` empties ``report.links`` — the station's own Formulare (see
    lib/reportLinks). Those URLs are CAPABILITIES: a Google-Forms prefill link is submittable by
    anyone who has it, and the list also names a Wehr's internal paperwork and the hosts it
    lives on. Only the Rapport shows them, and the Rapport is behind the PIN, so a link session
    does not get them.

    Such a caller sees ``links: []``, which is byte-identical to what a station that has
    configured none returns: the withholding does not announce itself. (Removing the key is not
    an option anyway — ``DeploymentConfigOut`` types the section, so the field comes back with
    its default whatever the dict says.)

    ``integrations.cartoBasemapKey`` has no flag: it goes to every session. The key is a BROWSER
    credential — CARTO wants it in every tile URL, and a domain restriction in CARTO, not
    secrecy, is what stops it being used elsewhere. ⚠️ «A session» includes an incident-LINK
    session, and that is the whole subtlety. ``LinkApp`` renders the full app — the AdF who taps
    the alarm link gets the real map — while ``OptionalUser`` sees no user for them, because a
    link carries its own cookie and never an ``access_token``. ``/api/config`` is on the link
    allowlist for this exact reason (auth/incident_link · «the map is useless without it»).

    ``include_internal=False`` empties ``alarms.webhooks``, ``sharepoint.sources`` (RBAC audit
    S3, 22.10.2026) and ``incidentArchive.destinations`` (no client but /admin reads them). Both are addresses the SERVER talks to, and a webhook URL is often a
    capability (a Power Automate ``sig=``, a Teams hook, a ``?secret=``): whoever has it can post
    as the alarm. No client but /admin reads either, so only an admin session gets them.

    ``include_filing=False`` empties ``objectVisits.destinations`` — SharePoint site addresses,
    but ones a signed-in client DOES read (the Objektbesuch's «Ablage» line and the filing
    status name the destination's folders), so it follows ``report.links``: every PIN session,
    no link.

    ⚠️ Withholding any of these from an ADMIN would be a data-loss bug, not a tightening: the admin UI
    does a full-document PUT (GET → draft → PUT), so a config the admin never received is a
    config the next unrelated edit silently deletes. Hence the flags rather than a blanket drop.
    """
    payload = doc.model_dump()
    # The reset schedule is the server's robust public-demo identity. A stale config publish
    # must not remove auto-login/ribbon/client alarm muting until the next reset while the
    # server continues enforcing demo lifecycle guards.
    if settings.is_public_demo:
        payload["identity"] = {**(payload.get("identity") or {}), "demoMode": True}
        payload["doctrine"] = {
            **(payload.get("doctrine") or {}),
            "alarmBar": 0,
            "alarmBarRueckzug": None,
        }
    if not include_keywords:
        payload.pop("alarmKeywords", None)
    if not include_links:
        payload["report"] = {**(payload.get("report") or {}), "links": []}
    # Emptied, never removed — like `report.links`, the answer is byte-identical to a station
    # that configured none, so the withholding does not announce itself.
    if not include_internal:
        payload["alarms"] = {**(payload.get("alarms") or {}), "webhooks": []}
        payload["sharepoint"] = {**(payload.get("sharepoint") or {}), "sources": []}
        payload["incidentArchive"] = {**(payload.get("incidentArchive") or {}), "destinations": []}
    if not include_filing:
        payload["objectVisits"] = {**(payload.get("objectVisits") or {}), "destinations": []}
    return DeploymentConfigOut(
        **payload,
        integrations=integrations(),
        alarmVocabulary=_alarm_vocabulary(doc),
        categoryLabels=CATEGORY_LABELS,
        version=version,
        warnings=warnings or [],
    )


def _final_document(stored: dict | None, stated: set[str], doc: DeploymentConfigIn) -> dict:
    """The document a write would actually STORE: the validated body plus the sections nobody
    types, carried from ``stored`` wherever the caller was silent about them.

    ⚠️ ``stated`` is the set of top-level keys the RAW request body carried, and it has to come
    from there: ``DeploymentConfigIn`` fills missing sections with defaults, so by the time the
    body is validated «referenceLayers were not mentioned» and «referenceLayers were cleared»
    are the same empty list. The first is a caller that does not know the section exists — an
    agent writing three identity fields over the API, which used to delete a station's hydrants
    — and the second is a deliberate act that belongs in front of the refuse-to-empty guard.
    Only the raw keys tell them apart.

    The branding slots are carried whatever the caller stated; config_guard says why.
    """
    doc_json = doc.model_dump(mode="json")
    carry_runtime_sections(stored, doc_json, submitted=stated)
    return doc_json


@router.get("", response_model=DeploymentConfigOut)
async def get_config(
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: DeviceUser = None,
    admin_session: str | None = Cookie(default=None),
) -> DeploymentConfigOut | JSONResponse:
    """Open to every caller, but a caller WITHOUT a session gets a short list only.

    * No session — ``PUBLIC_PARTS``: the branding and two switches, what the start cover and the
      login screen draw. The answer holds those keys, ``"partial": true`` and nothing else — it
      is NOT the whole ``DeploymentConfigOut``, and ``partial`` is on no other answer.
    * A session of any kind (PIN login, Einsatz-Link, terminal, admin) — the document, minus
      what ``_projection`` refuses that kind of session:

      * ``alarmKeywords``, ``alarms.webhooks``, ``sharepoint.sources`` and
        ``incidentArchive.destinations`` — admin only.
      * ``report.links`` and ``objectVisits.destinations`` — a PIN session or admin, not a link:
        a prefill URL is a capability, and the Rapport that shows the links is behind the PIN.

    ⚠️ The app reads this at BOOT, before `/me`. A signed-in device whose access cookie has
    expired still counts as its account here, by its refresh cookie (auth/dependencies ·
    ``get_device_user``) — this route never answers 401, so nothing renews the session before
    it. A device that is not signed in (a new one, a link page before its exchange) gets the
    partial answer; the client MERGES that over the copy it holds and reads again once a
    session is known (src/lib/deploymentConfig · mergePartial, lib/auth). Replacing with it
    would empty a tablet's fleet and map layers.

    On a missing or invalid stored row every caller gets the safe empty config; a value past a
    length limit costs only its entry (``stored_document``). Never raises.
    """
    # `integrations` in the projection is derived from the credential store, so refresh it —
    # otherwise a station that just connected Divera would keep seeing «nicht konfiguriert»
    # on the surface it went to check.
    await load_credentials(db)
    doc, raw = await stored_document(db)
    # ⚠️ A page that speaks for its link («use») is that link and nothing more: not the admin
    # whose cookie lies in the same browser, and not a PIN account — `actor` is then the link's
    # own guest, which must not count as one (the Atemschutz board handed over on a phone that
    # is signed in got the Formular links and the filing destinations, and with an admin
    # cookie the whole admin projection).
    is_admin = not link_page_owns_session(request) and await _admin_session_valid(admin_session)
    has_account = actor is not None and not is_link_session(actor)
    # A link session is a session: LinkApp mounts the whole app, map included.
    if not (is_admin or has_account or read_link_session(request) is not None):
        # The projection first, so the public demo's forced `demoMode` is in the answer too.
        everything = _projection(doc).model_dump(mode="json")
        return JSONResponse({**pick_parts(everything, PUBLIC_PARTS), "partial": True})
    return _projection(
        doc,
        include_keywords=is_admin,
        include_links=is_admin or has_account,
        include_internal=is_admin,
        include_filing=is_admin or has_account,
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
    request: Request,
    body: DeploymentConfigIn,
    _admin: CurrentAdmin,
    actor: OptionalUser,
    db: AsyncSession = Depends(get_db),
    force: bool = False,
    if_match: str | None = Header(default=None, alias="If-Match"),
) -> DeploymentConfigOut:
    """Admin-only. Validates the body (422 on invalid), persists the document to the
    singleton row, stamps ``updated_by`` (the admin's user when driving the UI, NULL for
    a CLI push), and returns the same projection as GET plus any ``warnings``.

    Three guards stand in front of the write, and every caller passes the same three — a
    browser, a CLI push, a script, an agent. They used to live in ``admin_config``, which meant
    they protected the one path that already had a person reading its output while this endpoint
    answered 200 to the identical mistake (see app/config_guard).

    **1. ``If-Match`` is required.** It carries the ``version`` the caller last read. This is a
    FULL-DOCUMENT replace and the Verwaltung autosaves, so a browser tab holding a draft from an
    hour ago reverted everything anybody had changed since — the whole document, silently, on the
    next nudge of one unrelated field. That is how the public demo lost its Dienstgrade, its
    Partnerorganisationen, its Atemschutz-Doktrin (including the Alarmdruck) and the point on its
    «Stk.» in one write, and it is the same trap for a station with two admins. Missing → 428
    (Precondition Required): the request is not wrong, it is missing the one thing that makes it
    safe. Sent and stale → 409, and the caller re-reads before deciding.

    ⚠️ It was once required of BROWSERS only, detected by ``Sec-Fetch-Site`` / ``Origin``, so
    that the terminal CLIs kept working untouched. That exemption is what an agent inherits: a
    GET is one line away, and «I am not a browser» is not a reason to be allowed a blind
    full-document overwrite. Every in-repo writer already sends the header (``admin_config
    push``, ``admin_geodata``), so the cost is one extra GET for anything else — and the
    operator note in the CHANGELOG is for whoever has a raw ``curl`` script.

    **2. A write that would EMPTY a populated section is refused** with 409 and a structured
    ``detail`` naming the sections, unless it carries ``?force=true``. Publishing an OLD document
    over a newer one is the shape of every one of these incidents, and it reports success while a
    station quietly loses a section. A caller that means it says so.

    **3. The sections nobody types are carried over** — ``referenceLayers`` and
    ``identity.assets`` — see ``_final_document``.

    Keys the schema DROPPED come back in ``warnings`` rather than changing the status: every
    model is ``extra="ignore"``, so ``identitiy`` configures nothing and used to be answered with
    a plain 200.
    """
    # ⚠️ 422, NOT 409. `admin/ConfigContext.persist` reads every 409 as «the stored document
    # moved on» and renders «Die Änderungen sind gespeichert, aber diese Seite zeigt noch den
    # Stand von vorher…» — the exact opposite of what happened here, on a refusal no reload can
    # clear. 422 falls into the generic-rejection branch, which SHOWS this `detail` and halts
    # the autosave, so the demo admin reads the actual reason.
    if settings.is_public_demo and (body.identity.demoMode is not True or body.doctrine.alarmBar != 0):
        raise HTTPException(
            status_code=422,
            detail="Die öffentliche Demo muss demoMode=true und Alarmdruck=0 behalten.",
        )
    row = await config_row(db, lock=True)
    stored = row.config_json
    stored_version = _version(stored)
    if if_match is None:
        raise HTTPException(
            status_code=428,
            detail="Diese Seite ist veraltet. Bitte neu laden und die Änderung wiederholen.",
            headers={"ETag": stored_version},
        )
    if if_match.strip('"') != stored_version:
        raise HTTPException(
            status_code=409,
            detail="Die Konfiguration wurde inzwischen an anderer Stelle geändert.",
            headers={"ETag": stored_version},
        )
    # The raw body, for the two questions the validated model can no longer answer: which
    # sections the caller actually NAMED, and which keys the schema threw away. Starlette caches
    # the body, so this is the same bytes FastAPI already parsed — not a second read of the stream.
    submitted = await request.json()
    if not isinstance(submitted, dict):  # a non-object body never reaches DeploymentConfigIn
        submitted = {}
    # Persist the normalized document (defaults filled in) so GET round-trips consistently.
    doc_json = _final_document(stored, set(submitted), body)
    dropped = emptied_declared_sections(stored, doc_json)
    if dropped and not force:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "would_empty_sections",
                "message": (
                    "Diese Konfiguration würde "
                    f"{len(dropped)} Abschnitt(e) leeren, die aktuell Inhalt haben: "
                    f"{', '.join(dropped)}."
                ),
                "emptiedSections": dropped,
                "override": "?force=true",
            },
            headers={"ETag": stored_version},
        )
    actor_id = actor.id if actor else None
    # …and keep what is being replaced, so this write is undoable whatever it turns out to have
    # been (app/config_history). Best-effort by design: the net must never drop the write.
    await keep_previous(db, "api", actor_id)
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
    return _projection(
        DeploymentConfigIn.model_validate(doc_json),
        version=_version(doc_json),
        warnings=document_warnings(submitted, doc_json),
    )


@router.post("/validate", response_model=ConfigValidationResult)
async def validate_config(
    body: dict,
    _admin: CurrentAdmin,
    db: AsyncSession = Depends(get_db),
) -> ConfigValidationResult:
    """Admin-only DRY RUN of a config document. Writes nothing, ever.

    ``admin_config validate`` / ``diff`` answer these questions on a workstation, against
    ``DATABASE_URL``. That is the wrong place for the two callers that now matter most — an agent
    and a station that has no Python toolchain — so the same four answers are here: does the
    schema accept it, what did it silently drop, what would it EMPTY (the 409 a PUT would give),
    and what would it CHANGE.

    ``version`` is the stored document's token, so the follow-up is a PUT with a correct
    ``If-Match`` rather than a GET, a guess and a retry.

    ⚠️ Validated LOOSELY on purpose — a body that fails the schema is answered 200 with
    ``valid: false`` and the reasons, not 422. This endpoint's job is to report a verdict on a
    document; a 422 would make «this document is wrong» and «this request is wrong» the same
    answer, and the caller would have to parse FastAPI's error envelope to tell them apart.
    """
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    stored = row.config_json if row else None
    version = _version(stored)
    try:
        doc = DeploymentConfigIn.model_validate(body)
    except ValidationError as e:
        # No document to compare, so no emptied/changed answer can be honest about it — but the
        # ignored KEYS are still readable off the raw body, and a typo is exactly the kind of
        # thing that hides behind an unrelated validation error.
        return ConfigValidationResult(
            valid=False,
            errors=format_validation_errors(e),
            warnings=document_warnings(body, {}),
            version=version,
        )
    doc_json = _final_document(stored, set(body), doc)
    return ConfigValidationResult(
        valid=True,
        warnings=document_warnings(body, doc_json),
        emptiedSections=emptied_declared_sections(stored, doc_json),
        changedSections=changed_sections(stored, doc_json),
        version=version,
    )


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

    row = await config_row(db, lock=True)
    await keep_previous(db, "api", actor.id if actor else None)
    # ⚠️ The brandmark is carried from the LIVE document, not taken from the restored one — the
    # same rule a PUT follows. Restoring a config from before a logo upload must not delete the
    # logo: the asset URLs are written by the upload endpoints and point at blobs that exist now.
    # A restore STATES every section — it is a whole document somebody chose off the list — so
    # nothing else is carried: the layers it puts back are the ones stored with it, which is the
    # point of restoring it.
    doc_json = _final_document(row.config_json, set(DeploymentConfigIn.model_fields), doc)
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

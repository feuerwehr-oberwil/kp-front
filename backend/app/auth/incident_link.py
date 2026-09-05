"""Incident links — a logged-out session scoped to exactly one incident.

WHAT THIS IS
------------
An external alerting system (any of them — this is provider-neutral, see
docs/ALARM-INTEGRATIONS.md) puts a URL into the alert it sends out. A responder on a
personal phone taps it and sees the incident the way a ``viewer`` account sees it: map,
plans, hydrants, checklists, Verlauf. No login, and nothing that writes, prints, costs
money or leaves the building.

THE THIRD KIND OF LINK (2026-09-01)
-----------------------------------
The description above is the *alarm* link. Two more kinds land on the same door, tell
themselves apart by one claim, and differ in what keeps them alive — and, since 05.09., in
how much they reach:

  · alarm (``kf``)      — alive while the station's minting key is unchanged AND the Einsatz
                          is open. Reaches ``LINK_ALLOWED``.
  · view (``vk``)       — alive while ``Incident.view_link_key`` is unchanged; survives the
                          Einsatz closing, because that is its normal case. Reaches
                          ``VIEW_LINK_ALLOWED``, which is strictly smaller: it is the only
                          link that goes OUTSIDE the station, so it gets this Einsatz's own
                          record and nothing that enumerates the station.
  · Atemschutz (``ak``) — alive while ``Incident.atemschutz_link_key`` is unchanged AND the
                          Einsatz is open. Reaches ``LINK_ALLOWED`` ∪ ``ATEMSCHUTZ_LINK_ALLOWED``.

The Atemschutz link is the only one that writes anything the record keeps, and the shape of
that permission is the whole control. An editor mints it from a running Einsatz and hands the
QR to somebody who is *not* on the FU — a colleague at the Eingang with a clipboard — who then
operates the Atemschutzüberwachung of that one Einsatz from their own phone: Trupp anmelden,
Kontakt, Druck, Rückzug, draussen. No identity is asked for, so what the session may do has to
be narrow enough that possession of the QR is a proportionate credential.

Narrow means three routes, and one of them is a *slice*: the Atemschutz writer PUTs
``workspace/trupps``, never ``workspace``. Handing a link holder the whole-document PUT would
hand them the whole Einsatz — every drawing, every Fläche, every setting — with a stale copy
able to erase all of it. The slice route reads the server's own blob and replaces exactly the
``trupps`` key (api/incidents · ``put_workspace_trupps``). The journal and event writes are
narrowed a second time inside their handlers: only ``kind == "team"`` rows and only
``atemschutz.*`` op_types, and both are stamped ``atemschutz-link`` so the record says where
they came from.

WHOSE SESSION IS THIS (2026-09-02)
----------------------------------
A link is «just the literal page». Opening one must not change what the *device* is logged in
as, and a device login must not change what the link page shows. The link cookie is site-wide
— it has to be, because ``<img src="/api/media/…">`` and the service worker cannot carry a
header — so its mere PRESENCE used to decide what the whole browser was: the bare site
answered as the link's viewer, a dead link cookie 403'd the login screen behind it, and the
Atemschutz link «solved» the other direction by logging the phone OUT of its own account
before exchanging.

The page therefore says which session it is asking with, on every request the SPA makes
(``LINK_MODE_HEADER``, set in src/lib/api.ts · rawFetch). Nothing is inferred from a cookie
that happens to be lying around.

TWO KEYS, DELIBERATELY
----------------------
1. ``DeploymentConfig.incident_link_key`` — the station's *minting* key, shared with the
   alerting system. It signs the inbound link token. It can do exactly one thing: ask for a
   link session. It is NOT ``settings.secret_key``, and that separation is the point —
   ``secret_key`` peppers every PIN (``security._pepper``) and mints admin sessions
   (``security.create_admin_token``), so an alerting system holding it could issue itself
   deployment-admin access without ever knowing ``ADMIN_SECRET``.
2. ``settings.secret_key`` — signs the resulting *session* cookie, exactly like every other
   session in this app. It never leaves kp-front.

The alerting system mints offline, with no call to kp-front. That is required, not merely
convenient: the alerting system is on the life-critical path and must not acquire a runtime
dependency on this app being reachable.

THE ONE WRITE, AND WHY IT IS ONE
--------------------------------
``POST /api/incidents/{id}/positions`` and its DELETE are the only writes on this list. A
responder who has opted in on their own phone reports where they are, so the command post
can see that the crew sent on the Wassertransport really is at the Weiher.

They earn the exception because of what they cannot do: each touches exactly one ephemeral
row — the caller's own self-reported position — mutates no incident state, appends to no
record, spawns no job and makes no outbound call. Nothing they write survives the Einsatz.

The matching ``GET`` is deliberately absent, and that asymmetry is the privacy model, not an
oversight: a phone holding a link may *send* its position and may read *nobody's*. Whoever
tapped the alarm link does not thereby get a live map of where their colleagues are; that
picture belongs to the command post. Do not add the GET.

WHY DEFAULT-DENY
----------------
``viewer`` is not "read-only" in the sense a shared URL needs. A viewer may generate the
Einsatzrapport and Zeitplan PDFs (api/report.py), send both to the station's thermal printer
(api/print_relay.py), cancel someone else's print job, and register push subscriptions. A
handful of GETs are not reads either: ``/media/{id}/transcription`` mutates a job row,
``/media/{id}/peaks`` spawns a task that writes a file, and ``/geocode/*``, ``/weather`` and
``/traccar/*`` make billable outbound calls.

So the surface reachable with a link session is an *allowlist*, not a blocklist. There are
~40 viewer-reachable routes today; a blocklist would silently grant every route added after
this file was written, and the one thing this control has to survive is future edits.

SCOPE IS ENFORCED TWICE
-----------------------
Being on the allowlist is not enough: a route carrying an ``incident_id`` must carry *the*
incident the token was minted for, or a link to one incident reads every other one.

Fail-closed: no ``incident_link_key`` configured → the whole surface answers 403.
"""

import contextlib
import hashlib
import secrets
import uuid

from fastapi import Depends, HTTPException, Request, status
from jwt import InvalidTokenError as JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from .security import decode_token

LINK_COOKIE = "link_session"

#: How a PAGE tells the server which session it is asking with — see "WHOSE SESSION IS THIS".
#: Three cases, and the third is why this is a header and not a second cookie:
#:
#:   "off"  — the ordinary app, /admin, the login screen. The link cookie is none of this
#:            page's business and is not read at all, however long it still lives.
#:   "use"  — this page IS the link, and its link session is the authority: read the link
#:            cookie even when the device also holds a login of its own. Only the Atemschutz
#:            link sends this, because the handed-over Tafel has to be the Tafel on a phone
#:            whose owner happens to be signed in as well — WITHOUT touching that login.
#:   absent — a subresource the browser fetches with no headers of ours (media in an <img>,
#:            the service worker, the manifest, the SPA shell), and the alarm/view link pages:
#:            the original rule, i.e. a link cookie counts only where there is no login. A
#:            signed-in member who taps an alert link stays who they are.
LINK_MODE_HEADER = "X-Incident-Link"

#: The SPA fallback route in spa.py.
_SPA_FALLBACK = "/{full_path:path}"

#: The per-deployment PWA manifest in webmanifest.py. Registered before the SPA fallback, so
#: it is its own route and needs its own entry below.
_WEBMANIFEST = "/manifest.webmanifest"

#: Allowlisted AND exempt from the liveness checks — the two surfaces that have to work
#: while the caller's link session is stale, expired or bound to a finished Einsatz.
#:
#: The exchange is here because it is the *recovery* path: it authenticates on the mint
#: token's own signature, so an old cookie is irrelevant to whether it should run. Gating it
#: on that cookie's liveness produced a trap — after one Einsatz closed, the same phone was
#: refused the link to the NEXT alarm, and the only way out was clearing cookies. The
#: response replaces the cookie wholesale, so nothing is inherited from the stale one.
#:
#: The SPA shell is here so a responder whose link really has died gets the app's own
#: explanation instead of a bare JSON 403 where the HTML should be.
#: The PWA manifest is here for the same reason as the SPA shell: the browser fetches it
#: alongside the HTML with no session of its own, it carries nothing about any incident, and
#: refusing it would put a 403 in the console of a responder whose link has simply expired.
_LIVENESS_EXEMPT: frozenset[tuple[str, str]] = frozenset(
    {
        ("GET", _SPA_FALLBACK),
        ("GET", _WEBMANIFEST),
        ("POST", "/api/incident-link/session"),
    }
)

#: JWT ``type`` claim for both the inbound mint token and the session cookie. Distinct from
#: "access"/"refresh"/"admin" so a link credential can never be mistaken for a real session.
LINK_TOKEN_TYPE = "incident-link"  # noqa: S105 — a claim discriminator, not a credential


class _Denied(HTTPException):
    """One message for every refusal. A link holder must not be able to tell 'that route
    exists but you may not have it' from 'no such route' — the difference is a map of the
    API drawn by probing."""

    def __init__(self) -> None:
        super().__init__(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Für diesen Einsatz-Link nicht freigegeben",
        )


# --- the allowlist ---------------------------------------------------------------------
#
# (METHOD, route path template as mounted). Route templates, not raw URLs, so path params
# stay symbolic and a typo fails loudly at match time rather than silently widening access.
#
# Everything here is a genuine read. Deliberate exclusions, each for a stated reason:
#   report/pdf, zeitplan/pdf        — generate documents containing attendance + names
#   report/print, zeitplan/print    — make the station printer print, from a forwarded URL
#   print-jobs DELETE               — cancels another person's job
#   push/subscriptions              — writes rows tied to a user
#   diag/report                     — enqueues outbound telemetry
#   geocode/*, overpass/*           — billable third-party calls, and an open proxy
#   media/*/peaks, */transcription  — GETs that mutate state or write files
#
# Live vehicle positions and weather ARE included: they are display data on the Lage map,
# carry no personal data, and excluding them makes the link visibly poorer than the viewer
# account it is meant to mirror. They are the only outbound calls on this list.
LINK_ALLOWED: frozenset[tuple[str, str]] = frozenset(
    {
        # The app itself. `mount_spa`'s fallback is a real APIRoute, so it goes through this
        # gate too — without it a link session is refused the HTML before it can render a
        # single thing. (The `/assets` StaticFiles mount is not an APIRoute and never
        # reaches here.)
        ("GET", "/{full_path:path}"),
        # …and the manifest that goes with it (public, no session, no incident data).
        ("GET", _WEBMANIFEST),
        # Re-opening a link that is already open must not be refused by its own guard.
        ("POST", "/api/incident-link/session"),
        # Signing in must stay reachable *from* a link session. Someone who tapped the link
        # on the way to the Einsatz and then wants their real account — an editor arriving
        # on scene, or the operator opening /admin — would otherwise be locked out by this
        # guard, on their own phone, with no way back but clearing cookies. Both are
        # credential-gated in their own right, and once a real session exists
        # `read_link_session` stands aside entirely.
        ("GET", "/api/auth/roster"),
        ("POST", "/api/auth/login"),
        ("POST", "/api/admin/login"),
        # Signing OUT is deliberately NOT here (02.09.). A link is the literal page and owns
        # no session on this device: it cannot end one either. Nothing needs it any more —
        # the bare site ignores a link cookie outright (LINK_MODE_HEADER), so there is no
        # «stuck on that one Einsatz» state left to escape from — and refusing it is what
        # makes «tapping a link never logs this phone out» true even of a future stray call.
        ("GET", "/api/auth/me"),
        ("GET", "/api/config"),
        ("GET", "/api/plan-scales"),
        # `{key:path}` — the converter is part of the route's path as FastAPI records it, so
        # the plain `{key}` form matched no route and link sessions were refused the logo.
        ("GET", "/api/branding/file/{key:path}"),
        # the incident itself
        ("GET", "/api/incidents/{incident_id}"),
        ("GET", "/api/incidents/{incident_id}/workspace"),
        ("GET", "/api/incidents/{incident_id}/journal"),
        ("GET", "/api/incidents/{incident_id}/events"),
        ("GET", "/api/incidents/{incident_id}/snapshot"),
        ("GET", "/api/incidents/{incident_id}/samples"),
        ("GET", "/api/incidents/{incident_id}/state"),
        ("GET", "/api/incidents/{incident_id}/verify"),
        ("GET", "/api/incidents/{incident_id}/objects"),
        # The one write — see "THE ONE WRITE" above. The caller's own live position, in and
        # out. The GET on the same path is NOT here and must not be added.
        ("POST", "/api/incidents/{incident_id}/positions"),
        ("DELETE", "/api/incidents/{incident_id}/positions/{person_id}"),
        # station reference data — the map is useless without it
        ("GET", "/api/objects"),
        ("GET", "/api/objects/{object_id}"),
        ("GET", "/api/reference"),
        ("GET", "/api/reference/{dataset_id}"),
        ("GET", "/api/personnel"),
        ("GET", "/api/media/{media_id}"),
        # ⚠️ The thumbnail DOES write a file on first request, which is what keeps
        # `media/*/peaks` off this list. It is allowed anyway, and the difference is bounded:
        # one ~20 kB derivative of a picture this caller may already fetch in full, written once
        # and never again, spawning no job and making no outbound call. Refusing it would send
        # every link session back to full-size images in 40 px chips — the phone-killing memory
        # load this route exists to remove (api/media · get_media_thumb).
        ("GET", "/api/media/{media_id}/thumb"),
        # live display data
        ("GET", "/api/traccar/status"),
        ("GET", "/api/traccar/positions"),
        ("GET", "/api/traccar/trails"),
        ("GET", "/api/weather"),
    }
)

#: The extra three an ATEMSCHUTZ link session may reach, on top of everything above — the
#: complete write surface of «Atemschutzüberwachung von diesem einen Einsatz».
#:
#: They are additive, not a replacement: the Atemschutz holder needs the ordinary reads too
#: (the incident, the workspace, the journal — the surface they are annotating).
#:
#:   · the workspace SLICE, never `/workspace` itself. Same optimistic concurrency and the
#:     same 409 as the full PUT, but it can only replace the `trupps` key — a link holder must
#:     not be able to overwrite the Karte, the Pläne or the Einstellungen, least of all by
#:     saving a stale copy of a document they never see.
#:   · the journal append, narrowed again in the handler to `kind == "team"` rows.
#:   · the event ingest, narrowed again in the handler to `atemschutz.*` op_types.
#:
#: Both narrowings live in the handlers because they are about the CONTENT of a body, which a
#: (method, path) allowlist cannot see. Refusals there answer with `_Denied`, like here.
ATEMSCHUTZ_LINK_ALLOWED: frozenset[tuple[str, str]] = frozenset(
    {
        ("PUT", "/api/incidents/{incident_id}/workspace/trupps"),
        ("POST", "/api/incidents/{incident_id}/journal"),
        ("POST", "/api/incidents/{incident_id}/events"),
    }
)

#: What a RAPPORT VIEW link may reach — its own, strictly narrower list (2026-09-05).
#:
#: The other two links go to somebody INSIDE the station, for an Einsatz that is running. This
#: one goes outside it, for an Einsatz that is over: a Gemeinde, a Nachbarwehr, an insurer, and
#: whoever they forward the URL to. Handing that holder the alarm link's list handed them the
#: station's object register, the roster including people who have left, every Objektplan PDF
#: and the live position of every vehicle — none of which is in the Rapport they were sent, and
#: none of which becomes incident-scoped just because the token carries an incident claim.
#:
#: The rule is: THIS incident's record, plus the station material that record points at.
#:
#: Dropped from ``LINK_ALLOWED``, each for a stated reason:
#:   /api/objects                    — the station's object register; enumeration, and the
#:                                     viewer never calls it (the map uses …/objects below)
#:   /api/traccar/*                  — where the fleet is RIGHT NOW; not in any Rapport, and an
#:                                     outbound call triggered by someone outside the station
#:   /api/weather                    — the other outbound call, and meaningless for a finished
#:                                     Einsatz
#:   /api/admin/login                — the admin door has no business on a forwarded page
#:   …/positions POST + DELETE       — the alarm link's one write. Whoever is reading a
#:                                     finished Rapport is not on the Einsatz; this link
#:                                     writes NOTHING
#:   …/{incident_id}/state           — no caller in the app at all
#:
#: Three entries stay but are narrowed per request by ``_view_link_param_allowed``, because the
#: route is needed and the route's *answer* is station-wide:
#:   /api/objects/{object_id}        — only objects surfaced FOR this Einsatz
#:   /api/reference/{dataset_id}     — station reference data (hydrants, Checklisten, symbols)
#:                                     yes; an Objektplan only for those same objects
#:   /api/personnel                  — active roster only; ``?include_inactive`` is refused
#:
#: ⚠️ Kept deliberately: ``/api/auth/roster`` and ``/api/auth/login``. The roster route is
#: PUBLIC (auth/router · roster takes no session), so refusing it here would protect nothing
#: while breaking the member who taps a Rapport link and wants their own account back.
VIEW_LINK_ALLOWED: frozenset[tuple[str, str]] = frozenset(
    {
        # the app, its manifest, and re-opening the link itself
        ("GET", _SPA_FALLBACK),
        ("GET", _WEBMANIFEST),
        ("POST", "/api/incident-link/session"),
        # signing in from the page — see the note above
        ("GET", "/api/auth/roster"),
        ("POST", "/api/auth/login"),
        ("GET", "/api/auth/me"),
        # what the app needs to render as this station at all
        ("GET", "/api/config"),
        ("GET", "/api/plan-scales"),
        ("GET", "/api/branding/file/{key:path}"),
        # the incident's own record — the Rapport, and everything it is derived from
        ("GET", "/api/incidents/{incident_id}"),
        ("GET", "/api/incidents/{incident_id}/workspace"),
        ("GET", "/api/incidents/{incident_id}/journal"),
        ("GET", "/api/incidents/{incident_id}/events"),
        ("GET", "/api/incidents/{incident_id}/snapshot"),
        ("GET", "/api/incidents/{incident_id}/samples"),
        ("GET", "/api/incidents/{incident_id}/verify"),
        ("GET", "/api/incidents/{incident_id}/objects"),
        # …and its pictures. Already narrowed to this incident in api/media
        # (`_deny_media_outside_link_scope`), since neither route carries an incident_id.
        ("GET", "/api/media/{media_id}"),
        ("GET", "/api/media/{media_id}/thumb"),
        # station reference material, narrowed per request below
        ("GET", "/api/reference"),
        ("GET", "/api/reference/{dataset_id}"),
        ("GET", "/api/objects/{object_id}"),
        ("GET", "/api/personnel"),
    }
)

#: Path params that name an incident. A route on the allowlist carrying one of these must
#: carry the token's own incident.
_INCIDENT_PARAMS = ("incident_id",)

#: Reference datasets with NO object behind them that a Rapport view link legitimately needs:
#: the hydrant/GeoJSON layers, the bundled symbol pack, and the Checklisten templates/assets —
#: map and report furniture, the same for every Einsatz. A PDF is never furniture: an unbound
#: one is still a document (a station-object plan), and handing it to a forwarded Rapport link
#: is the SEC-02 leak. Anything not on this whitelist — a PDF, an unknown future kind — has to
#: clear the surfaced-object bar instead, so ``object_id is None`` on its own grants nothing.
_VIEW_LINK_FURNITURE_KINDS: frozenset[str] = frozenset({"geojson", "symbols", "checklists"})


def link_page_owns_session(request: Request) -> bool:
    """True when the page making this request IS a link page that answers for itself
    (``LINK_MODE_HEADER`` = "use"). Then the link session outranks any login the device
    holds — and, just as importantly, leaves that login alone."""
    return request.headers.get(LINK_MODE_HEADER) == "use"


def read_link_session(request: Request) -> dict | None:
    """The link session's claims, or None when this request isn't one.

    This answers *who the caller is*, not *what they may reach* — the second question is
    ``enforce_link_scope``'s, and conflating them broke the feature on the one browser that
    matters most. An admin cookie is deliberately NOT consulted: admin endpoints authorise on
    the secret and resolve to no user at all, so treating one as an identity leaves a link
    holder with none — every read 401s, on the operator's own browser, for as long as their
    admin session lasts.

    Which of the two cookies wins is the PAGE's answer, not this cookie jar's — see
    ``LINK_MODE_HEADER``. A page that is not a link page is never a link session, even while
    a link cookie is still lying in the browser; a page that is one is never anything else.
    """
    from .cookies import ACCESS_COOKIE

    mode = request.headers.get(LINK_MODE_HEADER)
    if mode == "off":
        return None
    if mode != "use" and request.cookies.get(ACCESS_COOKIE):
        return None
    raw = request.cookies.get(LINK_COOKIE)
    if not raw:
        return None
    try:
        payload = decode_token(raw)
    except JWTError:
        return None
    if payload.get("type") != LINK_TOKEN_TYPE:
        return None
    return payload


def _effective_path(request: Request) -> str | None:
    """The route template as *mounted*, e.g. ``/api/config`` — not ``/config``.

    Why this is not simply ``request.scope["route"].path``: under FastAPI 0.137 an
    ``include_router`` no longer flattens its routes into the app, and the route left in the
    scope is the original, router-local one. Its ``.path`` therefore lacks the ``/api``
    prefix it was mounted under, so every allowlist entry silently missed and the whole
    surface answered 403 — fail-closed, but dead.

    Whether the prefix applies is decided from the *request URL*, which is ground truth,
    rather than from a private attribute of the routing internals. Two routes with the same
    local path — one mounted under ``/api``, one not — stay distinguishable.
    """
    route = request.scope.get("route")
    local = getattr(route, "path", None)
    if local is None:
        return None
    prefix = settings.api_prefix
    raw = request.url.path
    if prefix and (raw == prefix or raw.startswith(f"{prefix}/")):
        return f"{prefix}{local}"
    return local


async def _minting_key_unchanged(db: AsyncSession, fingerprint: str | None) -> bool:
    """False once the station rotates or deletes the minting key, which ends every open
    session. Also false for a session minted before this claim existed — those predate the
    guarantee and it is safer to make their holders tap the link again than to grandfather
    a session that rotation cannot reach."""
    from ..models import DeploymentConfig

    if not fingerprint:
        return False
    current = (
        await db.execute(select(DeploymentConfig.incident_link_key).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()
    if not current:  # deleted → feature off → every open session ends with it
        return False
    return secrets.compare_digest(fingerprint, key_fingerprint(current))


async def _view_key_unchanged(db: AsyncSession, incident_id: str, fingerprint: str | None) -> bool:
    """False once the Rapport's view link is revoked (or re-minted), which ends every session it
    ever opened — not just the URL nobody has tapped yet.

    The mirror of ``_minting_key_unchanged``, one incident wide. Revoking is the ONE lever this
    link has: it outlives the Einsatz on purpose, so «it will expire eventually» is not an
    answer, and a link that has gone somewhere it should not must stop working everywhere at
    once — including on the phone that already has it open.
    """
    from ..models import Incident

    if not fingerprint:
        return False
    try:
        ident = uuid.UUID(incident_id)
    except (ValueError, AttributeError, TypeError):
        return False
    current = (await db.execute(select(Incident.view_link_key).where(Incident.id == ident))).scalar_one_or_none()
    if not current:  # revoked → the link is gone, and so is every session born from it
        return False
    return secrets.compare_digest(fingerprint, key_fingerprint(current))


async def _atemschutz_key_unchanged(db: AsyncSession, incident_id: str, fingerprint: str | None) -> bool:
    """False once the Atemschutz link is revoked (or re-minted) on this incident.

    The mirror of ``_view_key_unchanged`` on the other column, and it is the lever that makes
    the link retractable mid-Einsatz: the phone at the Eingang goes home, or the QR ends up
    somewhere it should not, and the editor takes it back without closing the Einsatz. It is
    only ONE of two conditions here — closing the Einsatz ends it as well.
    """
    from ..models import Incident

    if not fingerprint:
        return False
    try:
        ident = uuid.UUID(incident_id)
    except (ValueError, AttributeError, TypeError):
        return False
    current = (await db.execute(select(Incident.atemschutz_link_key).where(Incident.id == ident))).scalar_one_or_none()
    if not current:  # revoked → every session born from it ends with the URL
        return False
    return secrets.compare_digest(fingerprint, key_fingerprint(current))


async def _incident_still_open(db: AsyncSession, incident_id: str) -> bool:
    """Re-checked on EVERY request, not just at exchange.

    The rule the station agreed to is "the link works until the incident is closed" — so
    closing an Einsatz has to actually revoke it. The session cookie's own expiry is only a
    backstop for the incident nobody ever closes; if this were checked once at exchange
    time, closing would do nothing for the remaining 12 hours.
    """
    from ..models import Incident

    # `Incident.id` is a native UUID column: a str bind blows up in SQLAlchemy's Uuid
    # processor (and in asyncpg's codec), so coerce here. A malformed claim is a refusal,
    # never an exception — the claim is attacker-supplied.
    try:
        ident = uuid.UUID(incident_id)
    except (ValueError, AttributeError, TypeError):
        return False

    row = (await db.execute(select(Incident).where(Incident.id == ident))).scalar_one_or_none()
    return row is not None and row.is_open


async def _surfaced_object_ids(db: AsyncSession, incident_id: str) -> frozenset[uuid.UUID]:
    """The Einsatzobjekte one incident points at.

    The same set ``GET /api/incidents/{id}/objects`` serves — address match, then 400 m — plus
    the object an editor picked by hand on the KP tablet, which the workspace carries as
    ``pickedObjectId`` and which may sit well outside that radius.

    Derived by CALLING the listing handler rather than re-deriving its rule: a second copy of
    the address/radius logic would drift, and it would drift silently in the worst direction —
    the Rapport's own Objektplan answering 403 to the person it was sent to.
    """
    from ..api.objects import objects_near_incident
    from ..models import Incident

    try:
        ident = uuid.UUID(incident_id)
    except (ValueError, AttributeError, TypeError):
        return frozenset()

    try:
        # `_user` is that handler's auth dependency and is otherwise unused; this caller has
        # already been authorised by the link session, so there is nobody to pass.
        rows = await objects_near_incident(ident, None, db)  # type: ignore[arg-type]
    except HTTPException:  # the incident is gone → it surfaces nothing
        return frozenset()

    ids = {row.id for row in rows}
    workspace = (await db.execute(select(Incident.map_workspace_json).where(Incident.id == ident))).scalar_one_or_none()
    picked = (workspace or {}).get("pickedObjectId") if isinstance(workspace, dict) else None
    if isinstance(picked, str):
        with contextlib.suppress(ValueError):
            ids.add(uuid.UUID(picked))
    return frozenset(ids)


async def _view_link_param_allowed(request: Request, db: AsyncSession, path: str, incident_id: str) -> bool:
    """The second half of ``VIEW_LINK_ALLOWED``: three routes that a Rapport view genuinely
    needs but that answer with station-wide data unless the request itself is narrowed.

    A (method, path) allowlist cannot see this — it is about WHICH object, WHICH dataset, WHICH
    roster — so it is decided here, on the parameters, against what this one incident points at.

    Refusals are the ordinary ``_Denied``: "no such dataset" and "not for this Einsatz" must
    stay one answer, or a holder maps the station's plan store by watching status codes.
    """
    from ..models import ReferenceDataset

    if path == "/api/personnel":
        # The list route hands out people who have left the corps on `?include_inactive=true`.
        # That is administration, and it is what the finding reproduced.
        raw = (request.query_params.get("include_inactive") or "").strip().lower()
        return raw in ("", "false", "0", "no")

    if path == "/api/objects/{object_id}":
        got = request.path_params.get("object_id")
        try:
            wanted = uuid.UUID(str(got))
        except (ValueError, TypeError):
            return False
        return wanted in await _surfaced_object_ids(db, incident_id)

    if path == "/api/reference/{dataset_id}":
        dataset_id = str(request.path_params.get("dataset_id"))
        ds = (
            await db.execute(
                select(ReferenceDataset.object_id, ReferenceDataset.kind).where(ReferenceDataset.id == dataset_id)
            )
        ).one_or_none()
        if ds is None:
            return False  # unknown → refused exactly like forbidden
        object_id, kind = ds
        # An Objektplan IS somebody's building. Only for the objects this Einsatz surfaced — and
        # a document has to clear that bar even with NO object behind it, or an unbound plan/PDF
        # (object_id absent, kind "pdf") leaks whole to a forwarded Rapport link (SEC-02). So
        # ``object_id is None`` grants nothing on its own: only the genuine station furniture
        # below passes without an object.
        if object_id is not None:
            return object_id in await _surfaced_object_ids(db, incident_id)
        # No object behind it → allow ONLY map/report furniture: hydrant/GeoJSON layers, the
        # symbol pack, the Checklisten templates/assets. A PDF or an unknown kind is refused.
        return kind in _VIEW_LINK_FURNITURE_KINDS

    return True


async def enforce_link_scope(request: Request, db: AsyncSession = Depends(get_db)) -> None:
    """App-level gate. Runs on every route; no-ops unless the caller holds a link session.

    Registered as a FastAPI app dependency rather than a middleware on purpose: dependencies
    run *after* routing, so ``request.scope["route"]`` is the resolved route and the
    allowlist can be matched against path templates instead of re-implementing path matching
    with regexes that would drift from the real routes.
    """
    # Both imported lazily: `cookies` imports LINK_COOKIE from this module, and `dependencies`
    # imports read_link_session, so either at module level is a cycle.
    from .cookies import ADMIN_COOKIE
    from .dependencies import _admin_session_valid

    claims = read_link_session(request)
    if claims is None:
        # ⚠️ Forced mode with no link session (H2). A page that sent `X-Incident-Link: use` asked
        # to be the RESTRICTED link identity — not whatever the device is otherwise logged in as.
        # `read_link_session` already withheld any ambient identity, so if there are no claims
        # (link cookie absent or expired) the caller has none. An admin cookie lying in the same
        # browser must NOT silently hand admin routes back: Codex reached /api/capture/secret with
        # `use` + an admin cookie + no link cookie. Deny that path outright; the operator's own
        # /admin pages send "off" and never enter this branch.
        if link_page_owns_session(request) and await _admin_session_valid(request.cookies.get(ADMIN_COOKIE)):
            raise _Denied()
        return

    # A live admin session must not be narrowed by a leftover link cookie: the operator who
    # taps a link to see what responders see would otherwise be locked out of /admin on that
    # browser, including the key rotation that is their remedy. Validated, never merely
    # present — skipping the allowlist on an unverified cookie would let anyone holding a
    # link and a scrap of garbage walk straight past it. Someone with a real admin session
    # already outranks every route this guard protects.
    #
    # ⚠️ Except when the PAGE said it is the link (`LINK_MODE_HEADER` = "use"). That header is
    # a request for the restricted identity, and `read_link_session` has already honoured it —
    # so lifting the allowlist here anyway made the two disagree: /auth/me answered as the
    # Atemschutz session for incident A while every route was reachable for incident B. A page
    # that asks to be the link is the link, on an admin browser as much as any other; the
    # operator's own /admin pages send "off" and are untouched by this.
    if not link_page_owns_session(request) and await _admin_session_valid(request.cookies.get(ADMIN_COOKIE)):
        return

    path = _effective_path(request)
    if path is None:  # unrouted (404) — refuse rather than fall through
        raise _Denied()

    # One list per kind. The Atemschutz session widens the alarm list by exactly three entries;
    # the VIEW session gets its own, strictly narrower one (see VIEW_LINK_ALLOWED) because it
    # is the only link that leaves the station.
    atemschutz = bool(claims.get("ak"))
    view = bool(claims.get("vk"))
    if atemschutz:
        allowed = LINK_ALLOWED | ATEMSCHUTZ_LINK_ALLOWED
    elif view:
        allowed = VIEW_LINK_ALLOWED
    else:
        allowed = LINK_ALLOWED
    if (request.method.upper(), path) not in allowed:
        raise _Denied()

    # Scope check: an allowlisted route naming an incident must name *this* one.
    scoped = claims.get("inc")
    for param in _INCIDENT_PARAMS:
        got = request.path_params.get(param)
        if got is not None and str(got) != str(scoped):
            raise _Denied()

    # …and the routes that name no incident but answer with station-wide data are narrowed on
    # their own parameters. Only the view link needs this: it is the only one handed outside.
    if view and not await _view_link_param_allowed(request, db, path, str(scoped)):
        raise _Denied()

    # Liveness checks: closing the Einsatz — or rotating the minting key — revokes every
    # link to it, immediately. Skipped for the SPA shell itself so a responder whose link
    # just died gets the app's own "nicht mehr verfügbar" screen rather than a bare JSON 403
    # in place of the HTML.
    if (request.method.upper(), path) in _LIVENESS_EXEMPT:
        return

    # A Rapport VIEW link is the other lifecycle, and it is the reason that link exists: the
    # Einsatz is over, and somebody outside the station — a Gemeinde, a Nachbarwehr, an
    # insurer — is being shown what was done. So «still open» is not asked, and the station's
    # minting key is none of its business. Its one liveness condition is that the incident's
    # own view key still says what the session was born from, i.e. nobody revoked it.
    if claims.get("vk"):
        if not await _view_key_unchanged(db, str(scoped), claims.get("vk")):
            raise _Denied()
        return

    # An ATEMSCHUTZ link is the alarm link's lifecycle on a per-incident key: it exists while
    # the Einsatz runs and not one request longer, and the editor can take it back on its own
    # without rotating the station's key or ending the Einsatz. Both conditions, always.
    if atemschutz:
        if not await _atemschutz_key_unchanged(db, str(scoped), claims.get("ak")):
            raise _Denied()
        if not await _incident_still_open(db, str(scoped)):
            raise _Denied()
        return

    if not await _minting_key_unchanged(db, claims.get("kf")):
        raise _Denied()
    if not await _incident_still_open(db, str(scoped)):
        raise _Denied()


def link_session_incident(request: Request) -> str | None:
    """The incident a link session is bound to, for handlers that need to narrow a listing."""
    claims = read_link_session(request)
    return claims.get("inc") if claims else None


def key_fingerprint(key: str) -> str:
    """A short, non-reversible marker of which minting key a session was born from.

    Carried in the session cookie so rotation can revoke sessions that are *already open*.
    Without it, rotating would only invalidate links not yet tapped: an exchanged session is
    signed with this app's own secret and would happily outlive the rotation by up to
    ``incident_link_session_ttl``. Rotation is the lever an operator reaches for when a link
    has gone somewhere it shouldn't, so it has to mean "everything, now".

    A digest, not the key: the cookie goes to a phone, and it must not carry the station's
    minting secret even in part.
    """
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def create_link_session_token(incident_id: str, minting_key: str) -> str:
    """Mint the *session* cookie value — signed with this app's own secret, never the
    station's minting key, and never handed to anyone outside kp-front."""
    from .security import _encode

    return _encode(
        {"inc": str(incident_id), "scope": "incident-link", "kf": key_fingerprint(minting_key)},
        token_type=LINK_TOKEN_TYPE,
        expires=settings.incident_link_session_ttl,
    )


def create_view_session_token(incident_id: str, view_key: str) -> str:
    """The same session cookie for a Rapport view link, marked with `vk` instead of `kf`.

    That one claim is what tells ``enforce_link_scope`` which liveness rule applies — this
    session survives the Einsatz closing and dies when the incident's own link is revoked.
    The cookie's TTL is unchanged and stays the backstop: the holder re-taps the URL, which is
    a no-op for as long as the station leaves the link standing.
    """
    from .security import _encode

    return _encode(
        {"inc": str(incident_id), "scope": "incident-link", "vk": key_fingerprint(view_key)},
        token_type=LINK_TOKEN_TYPE,
        expires=settings.incident_link_session_ttl,
    )


def create_atemschutz_session_token(incident_id: str, key: str) -> str:
    """The same session cookie for an Atemschutz link, marked with `ak`.

    That claim does two things at once, and it is the only thing that separates this session
    from a read-only one: it widens the allowlist by ``ATEMSCHUTZ_LINK_ALLOWED``, and it
    selects the liveness rule (this incident's own key, plus the Einsatz still running).
    """
    from .security import _encode

    return _encode(
        {"inc": str(incident_id), "scope": "incident-link", "ak": key_fingerprint(key)},
        token_type=LINK_TOKEN_TYPE,
        expires=settings.incident_link_session_ttl,
    )

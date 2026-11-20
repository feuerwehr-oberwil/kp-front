"""Every route needs a login — unless it is on the list below, with its reason.

A new route is open the moment it is mounted without an auth dependency, and nothing else in the
suite notices: its own tests call it signed in. This test walks every mounted route and fails
when one has no auth dependency and is not on ``PUBLIC``. Opening a route to callers without a
session is then an edit HERE, which a reviewer sees.

What counts as an auth dependency is ``AUTH`` — the callables that refuse a caller without a
session, a token or the admin secret. ``get_optional_user`` is not on it: it answers «nobody»
instead of refusing. The app-wide ``enforce_link_scope`` is not on it either: it narrows a link
session and lets a caller without any cookie through.

Routes come from the routers as mounted, not from ``app.openapi()``: the SPA fallback and the
manifest are ``include_in_schema=False`` and must be seen too (see ``test_incident_link`` for why
``app.routes`` alone is not enough since FastAPI 0.137).
"""

from collections.abc import Iterator

from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute

from app.api import capture, integrations, object_visits, station_reference
from app.auth import dependencies as auth
from app.main import app

#: The callables that refuse a caller who has no session, token or secret.
AUTH = frozenset(
    {
        auth.get_current_user,
        auth.get_current_editor,
        auth.get_record_writer,
        auth.get_append_writer,
        auth.get_atemschutz_writer,
        auth.get_current_admin,
        auth.get_user_or_admin,
        auth.get_editor_or_admin,
        # the Erfassungs-Poster's token (fail-closed without a poster secret)
        capture._check_token,
        # an account or the admin, never a link (Objektbesuche, «Karte & Objekte»)
        object_visits.get_reader,
        station_reference.get_station_reader,
        # the organizer integration's bearer key
        integrations.require_organizer,
    }
)

_OWN_SECRET = "its own secret, checked in the handler (fail-closed without one)"

#: The SPA fallback (app/spa.py). Mounted only where a frontend build is present, so the image
#: has it and a bare test run does not.
SPA_FALLBACK = ("GET", "/{full_path:path}")

#: Every route a caller without a session may reach, and why. Keep it short.
PUBLIC: dict[tuple[str, str], str] = {
    # --- the app itself and its probes
    SPA_FALLBACK: "the SPA shell: it draws the login screen",
    ("GET", "/manifest.webmanifest"): "the PWA manifest, fetched with the shell: name, colours, icons",
    ("GET", "/health"): "liveness probe: version and commit",
    ("GET", "/ready"): "readiness probe: database and storage",
    # --- what the login screen needs before anybody is signed in
    ("GET", "/api/config"): "the login screen brands itself; the route decides what a caller without a session gets",
    ("GET", "/api/branding/file/{key:path}"): "the logo and icons the config names",
    ("GET", "/api/auth/roster"): "the login tiles (SECURITY.md · functional labels)",
    ("POST", "/api/auth/login"): "the door: PIN, rate-limited",
    ("POST", "/api/auth/refresh"): "authenticates on the refresh cookie itself",
    ("POST", "/api/auth/logout"): "ends whatever session the cookies hold",
    ("GET", "/api/auth/microsoft/start"): "the Microsoft door: off unless configured",
    ("GET", "/api/auth/microsoft/callback"): "the Microsoft door: checks state, PKCE and the id token",
    ("GET", "/api/admin/session"): "whether /admin is configured and unlocked, never the secret",
    ("POST", "/api/admin/login"): "the admin door: the secret, rate-limited",
    ("POST", "/api/admin/logout"): "ends the admin session",
    # --- a link is exchanged for its session here
    ("POST", "/api/incident-link/session"): "authenticates on the link token's signature",
    ("POST", "/api/incident-link/terminal-session"): "authenticates on the terminal device cookie",
    # --- machines with their own secret
    ("POST", "/api/divera/webhook"): _OWN_SECRET,
    ("POST", "/api/alarms"): _OWN_SECRET,
    ("POST", "/api/alarms/milestones"): _OWN_SECRET,
    ("POST", "/api/firehub/webhook"): _OWN_SECRET,
    ("POST", "/api/traccar/fake"): _OWN_SECRET + ", and TRACCAR_FAKE",
    ("DELETE", "/api/traccar/fake"): _OWN_SECRET + ", and TRACCAR_FAKE",
    ("POST", "/api/print-agent/claim"): _OWN_SECRET,
    ("GET", "/api/print-agent/jobs/{job_id}/file"): _OWN_SECRET,
    ("POST", "/api/print-agent/jobs/{job_id}/status"): _OWN_SECRET,
    ("GET", "/api/stats/incidents"): _OWN_SECRET,
    ("POST", "/api/push/subscriptions/renew"): "the push endpoint and its keys are the credential",
    # --- write-only sinks and one image
    ("POST", "/api/diag/client-error"): "the crash sink: reads nothing back, throttled",
    ("POST", "/api/diag/boot"): "the launch timing line: reads nothing back",
    ("POST", "/api/hit"): "the visit counter: closed list, always 204",
    ("GET", "/api/weather/radar/{key}.png"): "one MeteoSwiss radar frame, fetched by <img> with no header",
}


def _mounted() -> Iterator[tuple[str, str, APIRoute]]:
    """(METHOD, path as mounted, route) for every API route of the app."""

    def routes(route: object, base: str) -> Iterator[tuple[str, str, APIRoute]]:
        if isinstance(route, APIRoute):
            for method in (route.methods or set()) - {"HEAD", "OPTIONS"}:
                yield method.upper(), f"{base}{route.path}", route

    for entry in app.routes:
        inner = getattr(entry, "original_router", None)
        if inner is None:
            yield from routes(entry, "")
            continue
        for sub in inner.routes:
            # a router mounted inside a router would hide its routes from this walk
            assert not hasattr(sub, "original_router"), f"nested router under {entry.include_context.prefix}"
            yield from routes(sub, entry.include_context.prefix)


def _calls(dependant: Dependant) -> Iterator[object]:
    for dep in dependant.dependencies:
        yield dep.call
        yield from _calls(dep)


def _needs_auth(route: APIRoute) -> bool:
    return any(call in AUTH for call in _calls(route.dependant))


def test_every_route_needs_a_login_or_is_on_the_public_list():
    mounted = list(_mounted())
    assert len(mounted) > 200, "the walk found too few routes: the app's router layout changed"
    opened = sorted({(m, p) for m, p, route in mounted if not _needs_auth(route)} - set(PUBLIC))
    assert opened == [], (
        "routes without an auth dependency that are not on PUBLIC — add CurrentUser / CurrentAdmin, "
        f"or list them with a reason: {opened}"
    )


def test_the_public_list_names_only_open_routes_that_exist():
    """A stale entry reads like a decision and is none: the route is gone, or it needs a login
    by now and the entry would let it lose that again unseen."""
    by_key = {(m, p): route for m, p, route in _mounted()}
    gone = sorted(set(PUBLIC) - set(by_key) - {SPA_FALLBACK})
    assert gone == [], f"PUBLIC entries that match no mounted route: {gone}"
    guarded = sorted(key for key in PUBLIC if key in by_key and _needs_auth(by_key[key]))
    assert guarded == [], f"PUBLIC entries whose route has an auth dependency: {guarded}"

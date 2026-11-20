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
``app.routes`` alone is not enough since FastAPI 0.137). EVERY entry of the route table is
accounted for: an API route by its dependencies, a plain route, a mount or a WebSocket only by
standing on ``PUBLIC``, and a kind this walk does not know fails it.

The table is read as it stands after import. A route added later, at startup, is not seen —
nothing in this app does that.
"""

from collections.abc import Iterator

from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute
from starlette.routing import BaseRoute, Mount, Route, WebSocketRoute

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
    ("GET", "/api/config"): "open by design: api/config · get_config decides what a caller without a session reads",
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
    ("POST", "/api/incident-link/session"): "checks a signed link token or a link secret before it opens a session",
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
    ("OPTIONS", "/api/hit"): "its preflight: the landing page posts from another origin",
    ("GET", "/api/weather/radar/{key}.png"): "one MeteoSwiss radar frame, fetched by <img> with no header",
    # --- not API routes: nothing to hang a dependency on, so each one stands here
    ("GET", "/openapi.json"): "the API contract, also committed as docs/openapi.json (settings.api_docs_enabled)",
    ("GET", "/docs"): "Swagger UI over that contract (settings.api_docs_enabled)",
    ("GET", "/docs/oauth2-redirect"): "Swagger UI's own helper page",
    ("GET", "/redoc"): "ReDoc over that contract (settings.api_docs_enabled)",
    ("MOUNT", "/assets"): "the built frontend bundle: static files, the same for everybody",
}

#: Entries that exist only in some runs: the SPA fallback and the bundle need a frontend build,
#: the docs pages are off in production.
OPTIONAL = frozenset(
    {SPA_FALLBACK, ("MOUNT", "/assets")}
    | {key for key in PUBLIC if key[1] in ("/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc")}
)


def _calls(dependant: Dependant) -> Iterator[object]:
    for dep in dependant.dependencies:
        yield dep.call
        yield from _calls(dep)


def _mounted() -> Iterator[tuple[str, str, bool]]:
    """(METHOD, path as mounted, has an auth dependency) for every entry of the route table.

    A mount is ("MOUNT", path), a WebSocket ("WS", path) and a plain route that takes every
    method ("*", path): none of them has a dependency tree this
    walk can read, so both count as open. ``HEAD`` beside ``GET`` on one route is Starlette's own
    twin of that GET and is not listed twice; every other method is, ``OPTIONS`` included.
    """

    def entries(route: BaseRoute, base: str, outer: tuple[object, ...]) -> Iterator[tuple[str, str, bool]]:
        inner = getattr(route, "original_router", None)
        if inner is not None:  # an included router, possibly inside another one
            context = route.include_context  # type: ignore[attr-defined]
            # dependencies given to include_router(...) guard every route below it
            here = (*outer, *(dep.dependency for dep in context.dependencies))
            for sub in inner.routes:
                yield from entries(sub, f"{base}{context.prefix}", here)
        elif isinstance(route, APIRoute):
            guarded = any(call in AUTH for call in (*outer, *_calls(route.dependant)))
            for method in route.methods or set():
                yield method.upper(), f"{base}{route.path}", guarded
        elif isinstance(route, Route):
            if route.methods is None:  # Starlette: no methods given = every method
                yield "*", f"{base}{route.path}", False
                return
            methods = set(route.methods)
            for method in methods - ({"HEAD"} if "GET" in methods else set()):
                yield method.upper(), f"{base}{route.path}", False
        elif isinstance(route, Mount):
            yield "MOUNT", f"{base}{route.path}", False
        elif isinstance(route, WebSocketRoute):
            yield "WS", f"{base}{route.path}", False
        else:
            raise AssertionError(f"a kind of route this test cannot read: {type(route).__name__} {route!r}")

    for entry in app.routes:
        yield from entries(entry, "", ())


def test_every_route_needs_a_login_or_is_on_the_public_list():
    mounted = list(_mounted())
    assert len(mounted) > 200, "the walk found too few routes: the app's router layout changed"
    opened = sorted({(m, p) for m, p, guarded in mounted if not guarded} - set(PUBLIC))
    assert opened == [], (
        "routes without an auth dependency that are not on PUBLIC — add CurrentUser / CurrentAdmin, "
        f"or list them with a reason: {opened}"
    )


def test_the_public_list_names_only_open_routes_that_exist():
    """A stale entry reads like a decision and is none: the route is gone, or it needs a login
    by now and the entry would let it lose that again unseen."""
    by_key = {(m, p): guarded for m, p, guarded in _mounted()}
    gone = sorted(set(PUBLIC) - set(by_key) - OPTIONAL)
    assert gone == [], f"PUBLIC entries that match no mounted route: {gone}"
    guarded = sorted(key for key in PUBLIC if by_key.get(key))
    assert guarded == [], f"PUBLIC entries whose route has an auth dependency: {guarded}"

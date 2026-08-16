"""FastAPI application entrypoint.

Single service: serves the API under /api and (in production) the built SPA from the
same origin — so cookies are SameSite=Lax and there is no CORS.
"""

import logging
import re
from contextlib import asynccontextmanager

logging.basicConfig(level=logging.INFO)
# httpx logs every request at INFO with the FULL URL incl. query string — that leaks the
# Divera accesskey (passed as ?accesskey=...) into the logs. Silence its per-request line;
# our own code logs what matters without the secret.
logging.getLogger("httpx").setLevel(logging.WARNING)


#: Query parameters whose VALUE is a credential, as they appear in a URL anywhere in a log
#: line. `accesskey` is Divera's own spelling; `secret` is how both webhook intakes and the
#: capture/stats links accept theirs (`?secret=…`), which uvicorn's access log writes out in
#: full on every legitimate call.
_SECRET_QUERY_PARAM = re.compile(
    r"(?i)([?&](?:accesskey|access_key|api_key|apikey|key|secret|token|password|passwd|pwd))=[^&\s'\"]*"
)


def _redact(value: object) -> object:
    """`?accesskey=abc` → `?accesskey=<redacted>`, for anything that is a string."""
    return _SECRET_QUERY_PARAM.sub(r"\1=<redacted>", value) if isinstance(value, str) else value


class RedactSecretsInUrls(logging.Filter):
    """The last line of defence against a credential in a log line.

    ⚠️ THE SAME MITIGATION AS THE `httpx` LINE ABOVE, one step further along. Silencing httpx
    covered the request log httpx emits itself. It does not cover a URL that reaches a log any
    OTHER way, and two do:

      * an exception message rendered into a traceback — `httpx.HTTPStatusError` stringifies
        as «… for url '…?accesskey=<the key>'», which is how `scheduler._poll_divera`'s
        `logger.exception` wrote the station's Divera key to the container log on every failed
        poll;
      * uvicorn's access log, which writes the full query string of every request — so an
        alerting system posting to `/api/divera/webhook?secret=…` printed the station's
        webhook secret once per alarm.

    Attached to HANDLERS rather than loggers, because `uvicorn.access` sets `propagate = False`
    and never reaches the root handler.

    ⚠️ `exc_text` is pre-rendered here on purpose. `logging.Formatter.format` reuses a record's
    `exc_text` when it is already set and only falls back to formatting `exc_info` itself, so
    filling it in with a redacted rendering is what lets a FILTER — which otherwise sees only
    `msg` and `args` — reach the traceback where the leak actually lived.

    ⚠️ Belt, not braces. The braces are that no credential reaches a message in the first place
    (`divera.check_response`, `audio.transcribe`, `api/personnel._divera_unreachable`). A
    scrubber can only redact shapes it was taught — this one knows nothing about a secret that
    appears without a `?name=` in front of it — so it must never become the reason a call site
    stops being careful.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _redact(record.msg)
        if record.args:
            if isinstance(record.args, dict):
                record.args = {k: _redact(v) for k, v in record.args.items()}
            else:
                record.args = tuple(_redact(a) for a in record.args)
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = _redact(record.exc_text)  # type: ignore[assignment]
        return True


def install_log_redaction() -> None:
    """Put :class:`RedactSecretsInUrls` on every configured handler.

    ⚠️ Called TWICE, and both times are load-bearing. At import time it covers the root handler
    `basicConfig` just made, which is where this app's own loggers land. At lifespan startup it
    covers `uvicorn.*`, configured by uvicorn's own `dictConfig` at a moment this module cannot
    order itself against. Idempotent, so the second pass cannot double-redact.
    """
    handlers = list(logging.getLogger().handlers)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        handlers.extend(logging.getLogger(name).handlers)
    for handler in handlers:
        if not any(isinstance(f, RedactSecretsInUrls) for f in handler.filters):
            handler.addFilter(RedactSecretsInUrls())


install_log_redaction()

logger = logging.getLogger(__name__)

from collections.abc import AsyncGenerator
from datetime import UTC, datetime

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .auth.incident_link import enforce_link_scope
from .auth.router import router as auth_router
from .auth.token_blocklist import token_blocklist
from .config import settings
from .database import Base, engine
from .i18n import set_locale, translate_detail
from .spa import mount_spa
from .webmanifest import register_manifest_route


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Second pass, now that uvicorn has installed its own handlers — `uvicorn.access` does not
    # propagate to root, and it is the log that prints `?secret=…` on every webhook call.
    install_log_redaction()

    # Dev convenience: create tables from models. Production uses Alembic migrations.
    if settings.dev_create_all and not settings.is_production:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("dev_create_all: tables ensured")

    if settings.seed_database:
        from .seed import seed_users
        from .seed_config import seed_deployment_config
        from .seed_reference import seed_reference

        # ⚠️ ACCOUNTS FIRST, AND LOUDLY. This used to share one try/except with the two blocks
        # below, which logged and continued — so a production boot with no SEED_PIN (the state
        # `scripts/init-env.sh` used to leave behind) came up with NO USER ACCOUNTS, reported
        # `/ready` ok, passed the SETUP smoke test, and met the operator as «Keine Benutzer
        # hinterlegt» on a login screen, while the docs told them the PIN was 000000. It also
        # took the symbol pack and the config row with it, because they were in the same block.
        # A first boot that cannot create a login is not a running deployment; failing here is
        # the cheapest place to find that out. `seed.py` says so and now it is true.
        await seed_users()

        # These two are genuinely best-effort: the bundled symbol pack is authoritative in the
        # frontend (lib/useSymbols) and a missing config row is served as an empty config
        # (api/config · get_config), so a station degrades visibly rather than breaking.
        try:
            await seed_reference()
            await seed_deployment_config()
        except Exception:
            logger.exception("Reference/config seeding failed (continuing — the app degrades safely)")

    # Load the deployment locale for error-detail i18n (null-safe; stays de-CH otherwise).
    try:
        from sqlalchemy import select

        from .database import async_session_maker
        from .models import DeploymentConfig

        async with async_session_maker() as db:
            row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        cfg = (row.config_json if (row and row.config_json) else {}) or {}
        identity = cfg.get("identity") or {}
        set_locale(identity.get("locale"))
    except Exception:
        logger.exception("Loading deployment locale failed (defaulting to de-CH)")

    # Prime the integration-credential snapshot BEFORE anything serves a request. The
    # synchronous readers (push_enabled, the Traccar client, the provider registry) read this
    # snapshot, so a cold one would make a configured integration look off for the first few
    # seconds of a boot. `load` never raises — a database that isn't up yet leaves the
    # snapshot empty, which is the fail-closed state those consumers already handle.
    try:
        from .credentials import load as load_credentials

        await load_credentials(force=True)
    except Exception:
        logger.exception("Priming the integration credentials failed (continuing — they reload on demand)")

    await token_blocklist.start_cleanup_task()

    # Divera poll scheduler (Phase 3) is started here once that module lands.
    try:
        from .scheduler import start_scheduler

        await start_scheduler(app)
    except ImportError:
        pass

    yield

    await token_blocklist.stop_cleanup_task()
    try:
        from .scheduler import stop_scheduler

        await stop_scheduler()
    except ImportError:
        pass
    await engine.dispose()


app = FastAPI(
    title=settings.project_name,
    version=settings.version,
    lifespan=lifespan,
    # Incident-link containment, applied at the app level so it covers EVERY route —
    # including ones added long after auth/incident_link.py was written. A per-router
    # opt-in would make the safe case the one someone has to remember. No-ops unless the
    # caller holds a link session. See auth/incident_link.py for why it is default-deny.
    dependencies=[Depends(enforce_link_scope)],
    docs_url="/docs" if settings.api_docs_enabled else None,
    redoc_url="/redoc" if settings.api_docs_enabled else None,
    openapi_url="/openapi.json" if settings.api_docs_enabled else None,
)

# Sync-channel compression, both directions: responses (workspace/journal/reference JSON is
# highly repetitive → ~8–10× smaller on field LTE) and gzip-encoded request bodies from the
# frontend (large workspace saves). Request inflation enforces a decompressed-size cap so a
# gzip bomb can't expand past the JSON body limit; the Content-Length middleware below still
# bounds the wire size. No streaming/SSE endpoints exist, so response gzip is safe globally.
from starlette.middleware.gzip import GZipMiddleware

from .gzip_request import GzipRequestMiddleware

app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(GzipRequestMiddleware, max_decompressed_bytes=settings.max_json_body_mb * 1024 * 1024)


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """Same JSON shape as Starlette's default ({"detail": ...}) but with the detail run
    through the configured-locale translation. Status code and headers (e.g. the
    WWW-Authenticate header on 401s) are preserved; non-string details pass through.
    """
    detail = exc.detail
    if isinstance(detail, str):
        detail = translate_detail(detail)
    return JSONResponse(
        {"detail": detail},
        status_code=exc.status_code,
        headers=exc.headers,
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Unhandled errors must still answer JSON: clients surface {"detail": ...} from every
    error response (the capture client parses it), and Starlette's plain-text default
    "Internal Server Error" breaks that. Neutral detail only — the traceback stays in the
    server log, nothing internal leaks to the client. HTTPExceptions never reach this
    (they're handled above), so the normal error flow is untouched.
    """
    logger.exception("Unhandled error on %s %s", request.method, request.url.path, exc_info=exc)
    return JSONResponse({"detail": translate_detail("Interner Fehler")}, status_code=500)


@app.middleware("http")
async def capture_server_time(request: Request, call_next):
    """Every /api/capture/* response carries the server clock so the capture client can
    warn about device clock skew (times are typed on whatever phone scanned the poster).
    Contract with the frontend: header `X-Server-Time`, ISO-8601 UTC. On every capture
    response — errors included, so the skew check works even before token auth.
    """
    response = await call_next(request)
    if request.url.path.startswith(f"{settings.api_prefix}/capture"):
        response.headers["X-Server-Time"] = datetime.now(UTC).isoformat()
    return response


@app.middleware("http")
async def api_json_no_store(request: Request, call_next):
    """API JSON must never be HTTP-cached: without Cache-Control, Safari's heuristic cache
    served stale poll results (an STT status stuck on "none" hid finished transcriptions).
    The client also sends cache:'no-store', but the header protects devices still running
    an older PWA bundle. Media streaming (audio/images) stays cacheable — range requests
    and repeat playback benefit from it.
    """
    response = await call_next(request)
    if request.url.path.startswith("/api/") and response.headers.get("content-type", "").startswith("application/json"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    """Reject oversized bodies early (413) so a single large POST can't OOM the instance.

    Multipart uploads (media / plans / reference files) get the larger cap; JSON bodies
    (workspace blob, details, …) the smaller one. Keyed off the declared Content-Length.
    """
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            size = int(cl)
        except ValueError:
            return JSONResponse({"detail": "Ungültige Content-Length"}, status_code=400)
        is_upload = "multipart/form-data" in request.headers.get("content-type", "")
        cap_mb = settings.max_upload_mb if is_upload else settings.max_json_body_mb
        if size > cap_mb * 1024 * 1024:
            return JSONResponse({"detail": f"Anfrage zu gross (max. {cap_mb} MB)"}, status_code=413)
    return await call_next(request)


@app.get("/health")
async def health() -> dict:
    """Liveness only — static by design. Readiness (DB + storage) is /ready; point container
    and platform healthchecks THERE, or an unreachable database still reports healthy.

    Carries the BUILD, not just the version: `curl /health` is the first thing anybody does to
    a deployment that is behaving oddly, and `{"version": "0.6.0"}` is the same answer from a
    from-source build of `main` and from a three-day-old published image. `commit`/`built_at`
    say which one is actually running (see `Settings.build`).
    """
    build = settings.build
    return {
        "status": "ok",
        "service": settings.project_name,
        "version": settings.version,  # == build["release"]; the pre-existing key, kept for callers
        "commit": build["commit"],
        "built_at": build["built_at"],
    }


@app.get("/ready")
async def ready() -> JSONResponse:
    """Readiness: can this instance do real work? Probes the database and the storage volume
    so the orchestrator restarts/alerts on a data-layer outage instead of serving green."""
    from sqlalchemy import text

    from . import storage

    checks: dict[str, str] = {}
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:
        logger.exception("Readiness probe: database unreachable")
        checks["database"] = "error"
    try:
        storage.probe_writable()
        checks["storage"] = "ok"
    except Exception:
        logger.exception("Readiness probe: storage not writable")
        checks["storage"] = "error"
    ok = all(v == "ok" for v in checks.values())
    return JSONResponse(
        {"status": "ok" if ok else "error", "version": settings.version, **checks},
        status_code=200 if ok else 503,
    )


# --- API routers (each phase registers here) ---
P = settings.api_prefix
app.include_router(auth_router, prefix=P)


def _register_optional_routers() -> None:
    """Routers added by later phases; imported defensively so Phase 1 runs alone."""
    for module_name, attr in [
        ("app.api.admin", "router"),
        ("app.api.config", "router"),
        ("app.api.plan_scales", "router"),
        ("app.api.branding", "router"),
        ("app.api.incidents", "router"),
        ("app.api.person_positions", "router"),
        ("app.api.media", "router"),
        ("app.api.divera", "router"),
        ("app.api.alarms", "router"),
        ("app.api.capture", "router"),
        ("app.api.incident_link", "router"),
        ("app.api.personnel", "router"),
        ("app.api.station_workbook", "router"),
        ("app.api.traccar", "router"),
        ("app.api.weather", "router"),
        ("app.api.geocode", "router"),
        ("app.api.overpass", "router"),
        ("app.api.reference", "router"),
        ("app.api.objects", "router"),
        ("app.api.objects", "incidents_objects_router"),
        ("app.api.events", "router"),
        ("app.api.journal", "router"),
        ("app.api.push", "router"),
        ("app.api.report", "router"),
        ("app.api.print_relay", "router"),
        ("app.api.stats", "router"),
        ("app.api.system", "router"),
        ("app.api.credentials", "router"),
        ("app.api.diag", "router"),
    ]:
        try:
            mod = __import__(module_name, fromlist=[attr])
            app.include_router(getattr(mod, attr), prefix=P)
        except ImportError:
            continue


_register_optional_routers()

# The PWA manifest is generated per-deployment from the station's identity, so it must be a
# route — and it must be registered BEFORE mount_spa, whose catch-all would otherwise serve
# the build-time file straight from dist/. See webmanifest.py.
register_manifest_route(app)

# SPA fallback must be mounted LAST so it doesn't shadow /api, /health, or /ready.
mount_spa(app)

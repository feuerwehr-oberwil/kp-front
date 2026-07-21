"""FastAPI application entrypoint.

Single service: serves the API under /api and (in production) the built SPA from the
same origin — so cookies are SameSite=Lax and there is no CORS.
"""

import logging
from contextlib import asynccontextmanager

logging.basicConfig(level=logging.INFO)
# httpx logs every request at INFO with the FULL URL incl. query string — that leaks the
# Divera accesskey (passed as ?accesskey=...) into the logs. Silence its per-request line;
# our own code logs what matters without the secret.
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

from collections.abc import AsyncGenerator  # noqa: E402
from datetime import UTC, datetime  # noqa: E402

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from starlette.exceptions import HTTPException as StarletteHTTPException  # noqa: E402

from .auth.router import router as auth_router  # noqa: E402
from .auth.token_blocklist import token_blocklist  # noqa: E402
from .config import settings  # noqa: E402
from .database import Base, engine  # noqa: E402
from .i18n import set_locale, translate_detail  # noqa: E402
from .spa import mount_spa  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Dev convenience: create tables from models. Production uses Alembic migrations.
    if settings.dev_create_all and not settings.is_production:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("dev_create_all: tables ensured")

    if settings.seed_database:
        try:
            from .seed import seed_users
            from .seed_config import seed_deployment_config
            from .seed_reference import seed_reference

            await seed_users()
            await seed_reference()
            await seed_deployment_config()
        except Exception:  # noqa: BLE001
            logger.exception("Seeding failed (continuing)")

    # Load the deployment locale for error-detail i18n (null-safe; stays de-CH otherwise).
    try:
        from sqlalchemy import select

        from .database import async_session_maker
        from .models import DeploymentConfig

        async with async_session_maker() as db:
            row = (
                await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
            ).scalar_one_or_none()
        cfg = (row.config_json if (row and row.config_json) else {}) or {}
        identity = cfg.get("identity") or {}
        set_locale(identity.get("locale"))
    except Exception:  # noqa: BLE001 — never let locale loading block startup
        logger.exception("Loading deployment locale failed (defaulting to de-CH)")

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
    docs_url="/docs" if settings.api_docs_enabled else None,
    redoc_url="/redoc" if settings.api_docs_enabled else None,
    openapi_url="/openapi.json" if settings.api_docs_enabled else None,
)

# Sync-channel compression, both directions: responses (workspace/journal/reference JSON is
# highly repetitive → ~8–10× smaller on field LTE) and gzip-encoded request bodies from the
# frontend (large workspace saves). Request inflation enforces a decompressed-size cap so a
# gzip bomb can't expand past the JSON body limit; the Content-Length middleware below still
# bounds the wire size. No streaming/SSE endpoints exist, so response gzip is safe globally.
from starlette.middleware.gzip import GZipMiddleware  # noqa: E402

from .gzip_request import GzipRequestMiddleware  # noqa: E402

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
    and platform healthchecks THERE, or an unreachable database still reports healthy."""
    return {"status": "ok", "service": settings.project_name, "version": settings.version}


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
    except Exception:  # noqa: BLE001 — the probe must report, never raise
        logger.exception("Readiness probe: database unreachable")
        checks["database"] = "error"
    try:
        storage.probe_writable()
        checks["storage"] = "ok"
    except Exception:  # noqa: BLE001
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
        ("app.api.media", "router"),
        ("app.api.divera", "router"),
        ("app.api.alarms", "router"),
        ("app.api.capture", "router"),
        ("app.api.personnel", "router"),
        ("app.api.traccar", "router"),
        ("app.api.weather", "router"),
        ("app.api.geocode", "router"),
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
        ("app.api.diag", "router"),
    ]:
        try:
            mod = __import__(module_name, fromlist=[attr])
            app.include_router(getattr(mod, attr), prefix=P)
        except ImportError:
            continue


_register_optional_routers()

# SPA fallback must be mounted LAST so it doesn't shadow /api, /health, or /ready.
mount_spa(app)

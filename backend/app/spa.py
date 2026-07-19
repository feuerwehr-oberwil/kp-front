"""Serve the built Vite SPA from FastAPI (single-service, same-origin in production).

Static assets are served from ``<spa_dir>/assets``; every other non-API GET falls back
to ``index.html`` so client-side routing works. If the build dir is absent (e.g. running
the API standalone in dev with Vite on :5188), this is a no-op.
"""

import logging
import os

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import settings

logger = logging.getLogger(__name__)


# The PWA update chain lives or dies on these files being revalidated on every fetch: without
# an explicit Cache-Control the browser applies HEURISTIC freshness (10% of file age), so hours
# after a deploy a tablet could keep re-reading a stale sw.js/index.html from its HTTP cache and
# never learn a new build exists. ETag/Last-Modified make the forced revalidation a cheap 304.
_NO_CACHE_FILES = {"index.html", "sw.js", "sw-notify.js", "manifest.webmanifest", "registerSW.js"}


def _cache_control(basename: str) -> str:
    return "no-cache" if basename in _NO_CACHE_FILES else "public, max-age=3600"


class ImmutableStaticFiles(StaticFiles):
    """/assets/* carries a content hash in the filename — safe to cache forever."""

    async def get_response(self, path: str, scope):  # type: ignore[no-untyped-def]
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


def mount_spa(app: FastAPI) -> None:
    spa_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", settings.spa_dir))
    index = os.path.join(spa_dir, "index.html")
    if not os.path.isfile(index):
        logger.info("SPA build not found at %s — API runs standalone (Vite serves the SPA in dev).", spa_dir)
        return

    assets_dir = os.path.join(spa_dir, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", ImmutableStaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}", response_model=None, include_in_schema=False)
    async def spa_fallback(request: Request, full_path: str) -> FileResponse | JSONResponse:
        # Never swallow API routes.
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        # Serve a real file if it exists (favicon, plans, leitungskataster, …), but only
        # if it resolves to within spa_dir — never let "../" escape the build directory.
        candidate = os.path.abspath(os.path.join(spa_dir, full_path))
        if full_path and (candidate == spa_dir or candidate.startswith(spa_dir + os.sep)) and os.path.isfile(candidate):
            return FileResponse(candidate, headers={"Cache-Control": _cache_control(os.path.basename(candidate))})
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    logger.info("Serving SPA from %s", spa_dir)

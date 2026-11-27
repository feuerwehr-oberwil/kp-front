"""``GET /api/demo/wake`` – the readiness signal of the public demo's wake page.

The landing site's «Demo» links open a wake page (site/demo.template.html, on kp-front.ch)
that polls this route on the demo, cross-origin, and opens the demo once it answers 200. The
first poll is also what wakes a sleeping demo (app/demo_sleep).

200 ``{"ready": true}`` means the app, its database and its storage are up AND the boot reset
is done: the reset runs in the lifespan, before the port opens, so a process that can answer
at all has finished it. 503 ``{"ready": false}`` otherwise. Not use: polling it does not keep
the demo awake (demo_sleep · QUIET_PATHS).

Only on the public demo: everywhere else the route is a 404, so a station has no new surface.
CORS is the beacon's allowlist (visits · BEACON_ORIGINS), echoed back, never ``*``. A plain
GET without credentials is a CORS simple request, so there is no preflight to answer.
"""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from .. import visits
from ..database import engine
from ..demo_sleep import enabled
from ..readiness import check_readiness

router = APIRouter(tags=["demo"])


@router.get("/demo/wake", include_in_schema=False)
async def wake(request: Request) -> JSONResponse:
    """Whether the demo is ready for a visitor (see the module docstring)."""
    if not enabled():
        raise HTTPException(status_code=404)
    checks = await check_readiness(engine)
    ready = all(v == "ok" for v in checks.values())
    out = JSONResponse({"ready": ready}, status_code=200 if ready else 503)
    out.headers["Cache-Control"] = "no-store"
    origin = request.headers.get("origin")
    if origin in visits.BEACON_ORIGINS:
        out.headers["Access-Control-Allow-Origin"] = origin
        out.headers["Vary"] = "Origin"
    return out

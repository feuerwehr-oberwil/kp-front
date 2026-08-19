"""The two visit-statistics endpoints: the beacon that writes, and the admin read.

``POST /api/hit`` is the only surface in this backend that answers a browser on another
origin, and it is the smallest one that could be: it takes a kind and a key from a closed
allowlist, counts one hit, and answers ``204`` no matter what it was told. It reports
nothing back — not whether the key was known, not whether the flag is on — because a
counter that answers questions is a counter someone can interrogate.

``GET /api/admin/visits`` reads the aggregates behind ADMIN_SECRET, like every other admin
surface. There is no read path that is not admin-gated.

See app/visits.py for the mechanism and the two gates; PRIVACY.md for the promise.
"""

import json
import logging

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.status import HTTP_204_NO_CONTENT

from .. import visits
from ..auth.dependencies import CurrentAdmin
from ..database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(tags=["visits"])

#: What the beacon may ask to have counted. `page`/`referrer` come from the landing page
#: (cross-origin), `feature` from the demo SPA's own rail. `demo` is not in here on purpose:
#: an app-shell visit is what the SERVER saw, so only the middleware may write it.
_BEACON_KINDS = {"page": visits.PAGE_KEYS, "feature": visits.FEATURE_KEYS}

#: The beacon body cap. A hit is two short strings; anything larger is not one.
_MAX_BODY = 512


def _allow_origin(request: Request, response: Response) -> None:
    """Echo the origin back when it is one of ours, so the browser console stays clean.

    ``sendBeacon`` discards the response either way — the hit lands with or without this
    header. It exists so a visitor with devtools open does not see a CORS error on a page
    that is working perfectly. Never ``*``: an allowlist that answers everyone is not one.
    """
    origin = request.headers.get("origin")
    if origin in visits.BEACON_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"


@router.post("/hit", status_code=HTTP_204_NO_CONTENT, include_in_schema=False)
async def hit(request: Request, response: Response) -> Response:
    """Count one landing-page read or one demo surface. Always 204, never a message.

    Sent with ``navigator.sendBeacon`` and a ``text/plain`` body, which makes it a CORS
    *simple* request: no preflight, no cookies, nothing for the browser to negotiate. So the
    body is parsed here rather than through a pydantic model — the content type is the
    visitor's, not ours.
    """
    out = Response(status_code=HTTP_204_NO_CONTENT)
    _allow_origin(request, out)

    origin = request.headers.get("origin")
    same_origin = origin is None  # the demo's own SPA sends no Origin on a same-origin beacon
    if not (same_origin or origin in visits.BEACON_ORIGINS):
        return out

    raw = await request.body()
    if len(raw) > _MAX_BODY:
        return out
    try:
        body = json.loads(raw or b"{}")
    except (ValueError, UnicodeDecodeError):
        return out
    if not isinstance(body, dict):
        return out

    kind, key = body.get("kind"), body.get("key")
    if not isinstance(kind, str) or not isinstance(key, str):
        return out
    allowed = _BEACON_KINDS.get(kind)
    if allowed is None or key not in allowed:
        return out

    await visits.record(kind, key, request)

    # A referral is a property of a page view, so it is only read alongside one — and only
    # ever as a bare hostname (visits.clamp_referrer), capped per day so the bucket cannot
    # be filled with invented subdomains.
    if kind == "page":
        referrer = body.get("referrer")
        host = visits.clamp_referrer(referrer if isinstance(referrer, str) else None)
        if host and visits.referrer_allowed(visits.today(), host):
            await visits.record("referrer", host, request)

    return out


@router.options("/hit", include_in_schema=False)
async def hit_preflight(request: Request) -> Response:
    """Only reached if a caller sends a non-simple beacon; kept so that case is a 204 too."""
    out = Response(status_code=HTTP_204_NO_CONTENT)
    _allow_origin(request, out)
    if "Access-Control-Allow-Origin" in out.headers:
        out.headers["Access-Control-Allow-Methods"] = "POST"
        out.headers["Access-Control-Allow-Headers"] = "content-type"
        out.headers["Access-Control-Max-Age"] = "86400"
    return out


@router.get("/admin/visits")
async def read_visits(
    _admin: CurrentAdmin,
    days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The aggregates, newest day first. ``enabled`` says whether anything is still counting —
    an all-zero month on a box with the flag off is not the same fact as a quiet month."""
    rows = await visits.read(db, days)
    return {
        "enabled": visits.enabled(),
        "days": days,
        "rows": [
            {"day": r.day.isoformat(), "kind": r.kind, "key": r.key, "hits": r.hits, "uniques": r.uniques} for r in rows
        ],
    }

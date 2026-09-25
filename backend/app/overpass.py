"""Overpass (OpenStreetMap) building footprints — proxied, not called from the browser.

The «Umrisse» surface draws building outlines around an incident. It used to `fetch()` the
Overpass mirrors straight from the browser, which quietly made three claims untrue at once:
README's "every external service is proxied by the backend (the browser never calls a third
party)", PRIVACY.md's "the one exception is the two channels below", and the reasonable
assumption that an incident's coordinates stay between the station and its own server. The
surface is prefetched on every incident open, so this was not a corner case — and one of the
mirrors is hosted in Russia.

Now the browser asks its own backend and the backend asks Overpass. Same mirror race (the
public overpass-api.de alone is often slow or queued), same 20 s per-mirror stall guard, one
origin from the browser's point of view.

Mirrors are configurable — a station with its own Overpass instance sets OVERPASS_MIRRORS and
never leaves the building. The https-only guard mirrors traccar.py / weather.py.
"""

import asyncio
import logging
import time
from collections import OrderedDict
from urllib.parse import urlsplit

import httpx

from .config import settings

logger = logging.getLogger(__name__)

# Per-mirror stall guard. ⚠️ ABOVE the query's own `[timeout:25]` (25.09.2026): at 20 s the
# backend hung up on a mirror the query had just given 25 s to answer, and staging logged
# «ReadTimeout» from a mirror that was still working. The browser still gives up at its own 20 s,
# but a late answer is not wasted any more — it lands in the cache below, and the next open (or
# «Erneut laden», which joins the same in-flight fetch) gets it at once.
FETCH_TIMEOUT_S = 30.0

# Answers are kept per query: building outlines do not change on the operator's timescale, and
# every device of an Einsatz asks for the SAME box (the surface is prefetched on every open). A
# public mirror throttles per client address — all of a Railway deployment's traffic is one — so
# four tablets opening one Einsatz used to be twelve concurrent queries, and the 504s that
# followed were our own doing. Bounded in size and age; a failure is never cached.
CACHE_TTL_S = 6 * 3600.0
CACHE_MAX = 64
_cache: OrderedDict[str, tuple[float, dict]] = OrderedDict()
# identical queries in flight share ONE race (and its answer)
_inflight: dict[str, asyncio.Task] = {}

# Overpass rejects unfamiliar clients on some mirrors; be honest about who is calling.
_USER_AGENT = "kp-front (+https://github.com/feuerwehr-oberwil/kp-front)"

# THE building-footprint query, shared by every caller (/overpass/buildings and the georef
# suggest's reference fetch). Overpass QL is a query language and the callers are
# authenticated-but-not-admin, so the server always builds the query itself — the callers only
# supply a bounding box. One definition, or the two copies drift apart silently.
BUILDINGS_QUERY = '[out:json][timeout:25];(way["building"]({bbox});relation["building"]({bbox}););out geom;'


def mirrors() -> list[str]:
    """Configured mirrors, https-only. Empty list = the surface is unavailable."""
    raw = settings.overpass_mirrors
    out: list[str] = []
    for candidate in (m.strip() for m in raw.split(",")):
        if not candidate:
            continue
        if urlsplit(candidate).scheme != "https":
            # Same SSRF guard as the other outbound clients: a plain-http or file:// mirror
            # in config must not become a way to point the backend at something internal.
            logger.warning("ignoring non-https Overpass mirror: %s", candidate)
            continue
        out.append(candidate)
    return out


async def fetch_buildings(query: str, timeout_s: float = FETCH_TIMEOUT_S, *, cache: bool = True) -> dict:
    """The answer to `query`: from the cache, from a race already in flight for the same query,
    or from a new mirror race. Raises on total failure (nothing is cached then).

    `cache=False` for a caller that keeps the answer itself (the station snapshot in
    reference_buildings, megabytes that live in storage) — it always races afresh.
    """
    urls = mirrors()
    if not urls:
        raise RuntimeError("no Overpass mirrors configured")
    if not cache:
        return await _race(urls, query, timeout_s)
    now = time.monotonic()
    hit = _cache.get(query)
    if hit and now - hit[0] < CACHE_TTL_S:
        _cache.move_to_end(query)
        return hit[1]
    task = _inflight.get(query)
    if task is None:
        task = asyncio.create_task(_race(urls, query, timeout_s))
        _inflight[query] = task

        def settle(t: asyncio.Task, q: str = query) -> None:
            if _inflight.get(q) is t:
                del _inflight[q]
            if not t.cancelled() and t.exception() is None:
                _cache[q] = (time.monotonic(), t.result())
                _cache.move_to_end(q)
                while len(_cache) > CACHE_MAX:
                    _cache.popitem(last=False)

        task.add_done_callback(settle)
    # shielded: a caller that goes away (the browser's own 20 s) must not cancel the race the
    # other callers — and the cache — are waiting on
    return await asyncio.shield(task)


async def _race(urls: list[str], query: str, timeout_s: float) -> dict:
    """Race the mirrors; first success wins. Raises on total failure.

    The slower requests are left to finish and discarded — cancelling them buys nothing and
    Overpass counts a cancelled query against the caller either way.
    """

    async def one(url: str) -> dict:
        try:
            async with httpx.AsyncClient(timeout=timeout_s) as client:
                response = await client.post(
                    url,
                    content=f"data={query}".encode(),
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded",
                        "User-Agent": _USER_AGENT,
                    },
                )
                response.raise_for_status()
                return response.json()
        except Exception as exc:
            # A silent mirror failure is how «reference_unreachable» stayed a mystery for a day:
            # say WHICH mirror answered WHAT (a 429 from a public mirror reads very differently
            # from a stalled connection).
            status = getattr(getattr(exc, "response", None), "status_code", None)
            logger.warning("Overpass mirror %s failed: %s%s", url, type(exc).__name__, f" {status}" if status else "")
            raise

    tasks = [asyncio.create_task(one(url)) for url in urls]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        # FIRST_COMPLETED also fires on the first *failure*, so keep taking results until one
        # succeeds or every mirror has been tried.
        while True:
            for task in done:
                if not task.cancelled() and task.exception() is None:
                    return task.result()
            if not pending:
                raise RuntimeError("all Overpass mirrors failed")
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()

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
from urllib.parse import urlsplit

import httpx

from .config import settings

logger = logging.getLogger(__name__)

# Per-mirror stall guard. Matches the timeout the browser used to apply, so the surface's
# worst-case wait is unchanged by the move behind the proxy.
FETCH_TIMEOUT_S = 20.0

# Overpass rejects unfamiliar clients on some mirrors; be honest about who is calling.
_USER_AGENT = "kp-front (+https://github.com/feuerwehr-oberwil/kp-front)"


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


async def fetch_buildings(query: str) -> dict:
    """Race the configured mirrors; first success wins. Raises on total failure.

    The slower requests are left to finish and discarded — cancelling them buys nothing and
    Overpass counts a cancelled query against the caller either way.
    """
    urls = mirrors()
    if not urls:
        raise RuntimeError("no Overpass mirrors configured")

    async def one(url: str) -> dict:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_S) as client:
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

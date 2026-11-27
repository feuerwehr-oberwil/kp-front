"""Let the public demo fall asleep when nobody uses it (PUBLIC DEMO ONLY).

The demo runs on Railway «Serverless»: a service sleeps once it has sent no outbound packet
for 5–10 minutes, and the next request wakes it with a cold boot. Every timer in this process
that reaches the database or the internet — the scheduler's jobs, the leadership probe, the
token-blocklist cleanup, the weather radar — is outbound traffic, so on the demo each of them
asks :func:`idle` first and does nothing while nobody has been here for
:data:`IDLE_AFTER_SECONDS`. «Nobody» is read off the requests themselves (:class:`MarkUse`): an
in-memory clock, so asking it costs no traffic of its own.

How it is used:

* ``scheduler`` builds its schedulers from :class:`QuietScheduler` (every job gated, one place)
  and skips the leadership probe while :func:`idle`;
* ``auth/token_blocklist`` skips its hourly cleanup while :func:`idle`;
* ``main`` installs :class:`MarkUse` and runs :func:`reset_on_boot` in the lifespan, so every
  wake is a fresh Musterdorf demo (``api/demo`` answers the wake page once that is done).

⚠️ A station never sees any of this: :func:`enabled` is ``settings.is_public_demo`` (a demo
reset schedule is configured), and every gate answers «not idle» everywhere else.
"""

import functools
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from starlette.types import ASGIApp, Receive, Scope, Send

from .config import settings

logger = logging.getLogger(__name__)

#: How long after the last request the demo counts as unused. Its jobs stop then, and Railway
#: puts it to sleep 5–10 min after their last packet. Long enough that a visitor reading a
#: screen without touching it keeps the live parts (fake fleet, weather) moving.
IDLE_AFTER_SECONDS = 5 * 60

#: Requests that are not use: the landing page's visit beacon, the wake page's poll and the
#: platform probes. Each still wakes a sleeping demo (any request does), but none of them can
#: keep it awake — the beacon on its own buys one boot and then lets the demo sleep again.
QUIET_PATHS = frozenset({"/health", "/ready", f"{settings.api_prefix}/hit", f"{settings.api_prefix}/demo/wake"})

#: Boot counts as use: the request that woke the demo is on its way to the app.
_last_use = time.monotonic()


def enabled() -> bool:
    """Whether this process is the public demo, the only deployment that ever goes idle."""
    return settings.is_public_demo


def touch() -> None:
    """Record that somebody is using the demo right now."""
    global _last_use
    _last_use = time.monotonic()


def idle() -> bool:
    """True on the demo when nobody has used it for :data:`IDLE_AFTER_SECONDS`; never elsewhere."""
    return enabled() and time.monotonic() - _last_use > IDLE_AFTER_SECONDS


def when_used[**P](job: Callable[P, Awaitable[None]]) -> Callable[P, Awaitable[None]]:
    """Wrap a scheduler job so that, on an idle demo, a tick returns before it touches anything."""

    @functools.wraps(job)
    async def gated(*args: P.args, **kwargs: P.kwargs) -> None:
        if idle():
            return
        await job(*args, **kwargs)

    return gated


class QuietScheduler(AsyncIOScheduler):
    """An ``AsyncIOScheduler`` whose every job is :func:`when_used` — the scheduler's jobs need
    no gate of their own, and a job added later cannot forget it."""

    def add_job(self, func: Any, *args: Any, **kwargs: Any) -> Any:
        return super().add_job(when_used(func), *args, **kwargs)


class MarkUse:
    """ASGI middleware: every request outside :data:`QUIET_PATHS` is use (:func:`touch`)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket") and scope["path"] not in QUIET_PATHS:
            touch()
        await self.app(scope, receive, send)


async def reset_on_boot() -> None:
    """On the demo, wipe and reseed the Musterdorf demo before the first request is served.

    A wake is a cold boot, so this makes every wake (and every deploy) a fresh demo. It runs
    inside the lifespan on purpose: uvicorn opens its port only after it, so no visitor — the
    wake page's poll included — ever reaches a half-reset demo. The timed reset
    (``DEMO_RESET_CRON``) stays for a demo that is in use for hours, gated like every job.
    A failed reset is logged and the demo serves what it has, as the timed one always did.
    """
    if not enabled():
        return
    from .demo_reset import reset

    started = time.monotonic()
    try:
        # `wipe_objects=False` for the same reason as the timed job (scheduler · _demo_reset):
        # only the full reload (`scripts/demo-reset.sh`) re-pushes the Einsatzobjekte.
        await reset(wipe_objects=False)
    except Exception:
        logger.exception("Demo reset on boot failed (serving the demo as it is)")
        return
    logger.info("Demo reset on boot done in %.1fs", time.monotonic() - started)

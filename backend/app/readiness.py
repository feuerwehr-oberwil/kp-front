"""The shared, bounded data-layer check used by /ready and the external heartbeat."""

import logging

import anyio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from . import storage

logger = logging.getLogger(__name__)
PROBE_TIMEOUT_SECONDS = 3


async def check_readiness(engine: AsyncEngine) -> dict[str, str]:
    checks = {}
    try:
        with anyio.fail_after(PROBE_TIMEOUT_SECONDS):
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:  # noqa: BLE001 - every data-layer failure must withhold a healthy signal
        logger.warning("Readiness probe: database unavailable", exc_info=True)
        checks["database"] = "error"
    try:
        with anyio.fail_after(PROBE_TIMEOUT_SECONDS):
            await anyio.to_thread.run_sync(storage.probe_writable, abandon_on_cancel=True)
        checks["storage"] = "ok"
    except Exception:  # noqa: BLE001 - includes platform filesystem errors and probe timeout
        logger.warning("Readiness probe: storage unavailable", exc_info=True)
        checks["storage"] = "error"
    return checks

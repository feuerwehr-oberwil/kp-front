"""The shared, bounded data-layer check used by /ready and the external heartbeat."""

import asyncio
import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor

import anyio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from . import storage

logger = logging.getLogger(__name__)
PROBE_TIMEOUT_SECONDS = 3
_storage_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="readiness-storage")
_storage_guard = threading.Lock()
_storage_future: Future[None] | None = None


async def _check_storage() -> None:
    """One physical filesystem probe, even after its HTTP caller has stopped waiting."""
    global _storage_future
    with _storage_guard:
        if _storage_future is not None and not _storage_future.done():
            raise RuntimeError("A previous storage readiness probe is still running")
        _storage_future = _storage_executor.submit(storage.probe_writable)
        future = _storage_future
    # Cancellation can cancel queued work before dispatch. A running concurrent Future
    # cannot be cancelled, so it remains the gate until the filesystem call really ends.
    await asyncio.wrap_future(future)


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
            await _check_storage()
        checks["storage"] = "ok"
    except Exception:  # noqa: BLE001 - includes platform filesystem errors and probe timeout
        logger.warning("Readiness probe: storage unavailable", exc_info=True)
        checks["storage"] = "error"
    return checks

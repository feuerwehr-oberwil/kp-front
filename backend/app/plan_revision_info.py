"""Cheap PDF document facts, cached only by immutable original storage key."""

from functools import lru_cache

import anyio

from . import storage
from .pdfium_lock import pdfium_lock


def read_page_count(storage_key: str) -> int:
    """Read the actual original; approval calls this directly rather than trusting job state."""
    import pypdfium2 as pdfium

    data = storage.get_bytes(storage_key)
    with pdfium_lock:
        document = pdfium.PdfDocument(data)
        try:
            return len(document)
        finally:
            document.close()


@lru_cache(maxsize=2048)
def _cached_page_count(storage_key: str) -> int:
    return read_page_count(storage_key)


async def revision_page_count(storage_key: str, *, fresh: bool = False) -> int | None:
    """Unreadable originals cannot be approved or supply a fit to an incident."""
    try:
        return await anyio.to_thread.run_sync(read_page_count if fresh else _cached_page_count, storage_key)
    except (OSError, ValueError, RuntimeError):
        return None

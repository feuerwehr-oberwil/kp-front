"""Object storage abstraction.

v1 = a local directory (Railway volume in prod). Keys are slash-delimited paths under
the storage root; used for media, snapshot blobs, and reference-data files. Swap this
module's internals for R2/S3 at scale without touching callers.
"""

import contextlib
import os
import shutil
import uuid
from collections.abc import AsyncIterator

import anyio

from .config import settings

_ROOT = os.path.abspath(settings.media_storage_dir)


class TooLargeError(Exception):
    """A streamed write exceeded the caller's max_bytes; the partial file was removed."""


def _full(key: str) -> str:
    # Prevent path traversal: keys are relative, normalised, and must stay under root.
    safe = os.path.normpath(key).lstrip("/")
    path = os.path.abspath(os.path.join(_ROOT, safe))
    if not path.startswith(_ROOT + os.sep) and path != _ROOT:
        raise ValueError(f"Unsafe storage key: {key!r}")
    return path


def new_key(prefix: str, suffix: str = "") -> str:
    """Generate a fresh storage key like 'media/<uuid>.jpg'."""
    return f"{prefix.rstrip('/')}/{uuid.uuid4().hex}{suffix}"


def put_bytes(key: str, data: bytes) -> str:
    path = _full(key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    return key


async def put_astream(key: str, chunks: AsyncIterator[bytes], max_bytes: int | None = None) -> int:
    """Stream async chunks (e.g. an UploadFile) to key without holding the file in memory.
    Enforces max_bytes while writing; on TooLarge — or any other failure mid-write — the
    partial file is deleted so an aborted upload never leaves an orphaned blob."""
    path = _full(key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    total = 0
    try:
        # ASYNC230 suppressed: the point of this function is to NOT hold the upload in memory. The
        # writes interleave with awaited chunk reads, so the loop yields between them; routing
        # each individual write through a thread would cost more than the write itself.
        with open(path, "wb") as fh:  # noqa: ASYNC230
            async for chunk in chunks:
                total += len(chunk)
                if max_bytes is not None and total > max_bytes:
                    raise TooLargeError(key)
                fh.write(chunk)
    except BaseException:
        delete(key)
        raise
    return total


def get_bytes(key: str) -> bytes:
    """Read a stored blob. Synchronous — from an async context use `aget_bytes`."""
    with open(_full(key), "rb") as fh:
        return fh.read()


async def aget_bytes(key: str) -> bytes:
    """Read a stored blob without stalling the event loop.

    Not premature: the reference store holds region-wide Leitungskataster GeoJSON in the tens
    of megabytes, and a rapport render pulls a dozen journal photos back to back. A plain
    `open().read()` in a request handler freezes every other request — including the live
    position feed — for the whole read.
    """
    return await anyio.to_thread.run_sync(get_bytes, key)


def exists(key: str) -> bool:
    return os.path.isfile(_full(key))


def delete(key: str) -> None:
    """Best-effort remove a stored blob; a missing file is not an error."""
    with contextlib.suppress(FileNotFoundError):
        os.remove(_full(key))


def local_path(key: str) -> str:
    """Absolute path for FileResponse streaming."""
    return _full(key)


def size(key: str) -> int:
    return os.path.getsize(_full(key))


def copy_in(src_path: str, key: str) -> str:
    """Copy an external file (e.g. a seed asset) into storage under key."""
    path = _full(key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    shutil.copyfile(src_path, path)
    return key


def probe_writable() -> None:
    """Readiness probe: prove the storage root is mounted AND writable — a real write/delete,
    so an unmounted volume, read-only mount, or full disk fails instead of passing on a mere
    directory check. Raises on failure."""
    os.makedirs(_ROOT, exist_ok=True)
    path = os.path.join(_ROOT, ".readycheck")
    with open(path, "wb") as fh:
        fh.write(b"ok")
    os.remove(path)

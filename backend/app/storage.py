"""Object storage abstraction.

v1 = a local directory (Railway volume in prod). Keys are slash-delimited paths under
the storage root; used for media, snapshot blobs, and reference-data files. Swap this
module's internals for R2/S3 at scale without touching callers.
"""

import contextlib
import fcntl
import json
import logging
import os
import tempfile
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import BinaryIO

import anyio
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .transaction_hooks import after_commit, after_rollback

_ROOT = os.path.abspath(settings.media_storage_dir)
_BACKUP_INTERNAL = ".kp-backup"
log = logging.getLogger(__name__)


class TooLargeError(Exception):
    """A streamed write exceeded the caller's max_bytes; the partial file was removed."""


def _full(key: str) -> str:
    # Keys are relative blob names. Resolve links before checking containment so a
    # restored/misconfigured volume cannot redirect a read, write or delete outside it.
    if (
        not key
        or os.path.isabs(key)
        or "\\" in key
        or "\x00" in key
        or ".." in key.split("/")
        or key.split("/")[0] == _BACKUP_INTERNAL
    ):
        raise ValueError(f"Unsafe storage key: {key!r}")
    root = os.path.realpath(_ROOT)
    candidate = os.path.abspath(os.path.join(root, key))
    path = os.path.realpath(candidate)
    if not path.startswith(root + os.sep):
        raise ValueError(f"Unsafe storage key: {key!r}")
    # Blobs never need symlinks. Refuse aliases within the volume too: otherwise a
    # public branding key could point at private incident media under the same root.
    if path != candidate:
        raise ValueError(f"Unsafe storage key: {key!r}")
    return path


def new_key(prefix: str, suffix: str = "") -> str:
    """Generate a fresh storage key like 'media/<uuid>.jpg'."""
    return f"{prefix.rstrip('/')}/{uuid.uuid4().hex}{suffix}"


def _fsync_directory(directory: str) -> None:
    """Make a rename in `directory` durable. Best-effort: a platform or filesystem that cannot
    open or fsync a directory (Windows, some network mounts) keeps the old behaviour."""
    try:
        fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _open_temporary(key: str) -> tuple[str, str, int]:
    """(final path, temporary path, open fd) of a fresh temporary file beside `key`."""
    path = _full(key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".upload-", dir=os.path.dirname(path))
    return path, temporary, fd


def _sync_file(fh: BinaryIO) -> None:
    fh.flush()
    os.fsync(fh.fileno())


def _publish(temporary: str, path: str, *, durable: bool) -> None:
    # A backup holds the same shared lock, so publishing does not wait for it.
    # Only a single physical deletion's inode check/unlink needs exclusivity.
    with backup_guard():
        os.replace(temporary, path)
    if durable:
        _fsync_directory(os.path.dirname(path))


@contextlib.contextmanager
def _atomic_writer(key: str, *, durable: bool = True) -> Iterator[BinaryIO]:
    """Publish complete bytes by replacement; failed writes leave the previous blob intact.

    ⚠️ Durable by default (23.09.2026): the bytes are fsynced BEFORE the rename and the
    directory after it. Without that, a power cut or a container kill shortly after a save could
    leave the new name pointing at an empty or truncated file — the rename is atomic, the data
    behind it was not yet on disk — while the database row committed to reference it. A photo,
    a Modul PDF, a snapshot the replay anchors on: all originals. `durable=False` is for DERIVED
    bytes only (plan tiles), which are regenerated when missing and would otherwise pay two
    fsyncs per 512-px tile.
    """
    path, temporary, fd = _open_temporary(key)
    try:
        with os.fdopen(fd, "wb") as fh:
            yield fh
            if durable:
                _sync_file(fh)
        _publish(temporary, path, durable=durable)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.remove(temporary)


def put_bytes(key: str, data: bytes, *, durable: bool = True) -> str:
    """Write a blob atomically. Blocking — including an fsync; from a request handler with a
    large payload prefer `aput_bytes`. `durable=False`: derived data only (see _atomic_writer)."""
    with _atomic_writer(key, durable=durable) as fh:
        fh.write(data)
    return key


async def aput_bytes(key: str, data: bytes) -> str:
    """`put_bytes` without stalling the event loop (the write, its temporary file and the
    atomic publish all run on a worker thread)."""
    return await anyio.to_thread.run_sync(put_bytes, key, data)


async def put_astream(key: str, chunks: AsyncIterator[bytes], max_bytes: int | None = None) -> int:
    """Stream async chunks (e.g. an UploadFile) to key without holding the file in memory.
    Enforces max_bytes while writing. A failure removes only the unpublished temporary file;
    readers and snapshots keep the previous complete bytes until the replacement succeeds."""
    total = 0
    # Writes interleave with awaited chunk reads, so uploads yield without being buffered
    # in memory. The temporary file becomes visible at its final key only after completion.
    # The two fsyncs (file, then directory — see _atomic_writer) run on a worker thread: for a
    # 25 MB upload they are the one part of this that can take real time.
    path, temporary, fd = _open_temporary(key)
    try:
        with os.fdopen(fd, "wb") as fh:
            async for chunk in chunks:
                total += len(chunk)
                if max_bytes is not None and total > max_bytes:
                    raise TooLargeError(key)
                fh.write(chunk)
            await anyio.to_thread.run_sync(_sync_file, fh)
        await anyio.to_thread.run_sync(lambda: _publish(temporary, path, durable=True))
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.remove(temporary)
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
    """Remove a blob, retaining its bytes while a backup may still need the old SQL reference."""
    path = _full(key)
    with backup_guard(exclusive=True, blocking=False) as acquired, contextlib.suppress(FileNotFoundError):
        if acquired:
            os.remove(path)
        else:
            with _file_guard("deferred.lock"):
                directory = os.path.join(backup_directory(), "deferred")
                os.makedirs(directory, exist_ok=True)
                name = os.path.join(directory, uuid.uuid4().hex)
                # Pin the incarnation before identifying it. Otherwise a repeatedly rewritten
                # cache key could reuse an old inode and inherit its queued deletion.
                os.link(path, name + ".blob")
                try:
                    with open(name + ".part", "w") as fh:
                        json.dump({"key": key}, fh)
                    os.replace(name + ".part", name + ".json")
                except BaseException:
                    with contextlib.suppress(FileNotFoundError):
                        os.remove(name + ".part")
                    os.remove(name + ".blob")
                    raise


def backup_directory() -> str:
    """Private coordination files live on the same volume across app/maintenance processes."""
    directory = os.path.join(os.path.realpath(_ROOT), _BACKUP_INTERNAL)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    return directory


@contextlib.contextmanager
def _file_guard(name: str, *, exclusive: bool = False, blocking: bool = True) -> Iterator[bool]:
    with open(os.path.join(backup_directory(), name), "a") as fh:
        flags = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        try:
            fcntl.flock(fh, flags | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            yield False
        else:
            try:
                yield True
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)


@contextlib.contextmanager
def backup_guard(*, exclusive: bool = False, blocking: bool = True) -> Iterator[bool]:
    """Shared backup/publication lock; exclusive deletion never waits on a backup."""
    with _file_guard("guard.lock", exclusive=exclusive, blocking=blocking) as acquired:
        yield acquired


def collect_deferred_deletes() -> None:
    """Reclaim retained originals after pinning; a rewritten key never inherits an old delete."""
    directory = os.path.join(backup_directory(), "deferred")
    if not os.path.isdir(directory):
        return
    for name in os.listdir(directory):
        # The metadata lock excludes partially published markers only for this short
        # cleanup step. No request waits for the SQL dump or archive compression.
        with _file_guard("deferred.lock", exclusive=True, blocking=False) as metadata:
            if not metadata:
                continue
            with backup_guard(exclusive=True, blocking=False) as acquired:
                if not acquired:
                    continue
                marker = os.path.join(directory, name)
                with contextlib.suppress(FileNotFoundError):
                    if name.endswith(".part"):
                        os.remove(marker)
                    elif name.endswith(".blob"):
                        if not os.path.exists(marker.removesuffix(".blob") + ".json"):
                            os.remove(marker)
                    elif name.endswith(".json"):
                        try:
                            with open(marker) as fh:
                                record = json.load(fh)
                            if not isinstance(record, dict) or not isinstance(record.get("key"), str):
                                raise ValueError("Invalid deferred deletion record")
                            path = _full(record["key"])
                        except ValueError:
                            # An unreadable intent cannot authorise deletion. Keep its pin too:
                            # it may be the only surviving old bytes. Other records still progress.
                            log.warning(
                                "Invalid deferred deletion %s; retaining marker and pinned blob for inspection", marker
                            )
                            continue
                        pin = marker.removesuffix(".json") + ".blob"
                        with contextlib.suppress(FileNotFoundError):
                            pinned = os.stat(pin)
                            current = os.stat(path)
                            if (current.st_dev, current.st_ino) == (pinned.st_dev, pinned.st_ino):
                                os.remove(path)
                        # Remove intent first. A crash leaves a reclaimable orphan link,
                        # never a published deletion pointing at an unpinned/reusable inode.
                        os.remove(marker)
                        with contextlib.suppress(FileNotFoundError):
                            os.remove(pin)


def created_in_transaction(db: AsyncSession, key: str) -> None:
    """Remove a newly written blob if the SQL row pointing at it does not commit."""
    after_rollback(db, lambda: delete(key))


def delete_after_commit(db: AsyncSession, key: str | None) -> None:
    """Remove an obsolete blob only once the SQL row stopped pointing at it."""
    if key:
        after_commit(db, lambda: delete(key))


def replaced_in_transaction(db: AsyncSession, *, new_key: str, old_key: str | None) -> None:
    """Track both halves of replacing a blob referenced by a database row."""
    created_in_transaction(db, new_key)
    if old_key and old_key != new_key:
        delete_after_commit(db, old_key)


def local_path(key: str) -> str:
    """Absolute path for FileResponse streaming."""
    return _full(key)


def size(key: str) -> int:
    return os.path.getsize(_full(key))


def probe_writable() -> None:
    """Readiness probe: prove the storage root is mounted AND writable — a real write/delete,
    so an unmounted volume, read-only mount, or full disk fails instead of passing on a mere
    directory check. Raises on failure."""
    os.makedirs(_ROOT, exist_ok=True)
    fd, path = tempfile.mkstemp(prefix=".readycheck-", dir=_ROOT)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(b"ok")
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.remove(path)

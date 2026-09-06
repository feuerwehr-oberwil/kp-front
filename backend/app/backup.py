"""Capture a coherent SQL/blob pair without pausing incident writes.

Original blob keys are immutable and published before their SQL transaction commits.
Hold the deletion guard before pg_dump establishes its snapshot, then hardlink every
surviving blob. Extra unreferenced files are harmless; missing referenced files are not.
The private hardlinks survive subsequent replacement/deletion during compression.
"""

import contextlib
import fcntl
import gzip
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO
from urllib.parse import quote, urlencode

from sqlalchemy.engine import make_url

from . import storage
from .config import settings


@contextlib.contextmanager
def backup_run() -> Iterator[Path]:
    """One backup per volume; kernel ownership survives app restarts and ends on helper death."""
    directory = Path(storage.backup_directory())
    with (directory / "run.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("Another backup is already running for this storage volume") from exc
        # Only this lock owner can own work directories. A killed helper may have left one.
        for old in directory.glob("work-*"):
            shutil.rmtree(old)
        storage.collect_deferred_deletes()
        with tempfile.TemporaryDirectory(prefix="work-", dir=directory) as work:
            yield Path(work)


def dump_database(destination: Path) -> None:
    """Check pg_dump itself, not only the gzip stream produced from its stdout."""
    url = make_url(settings.database_url)
    query = dict(url.query)
    password = query.pop("password", url.password)
    if isinstance(password, tuple):
        password = password[-1]
    environment = os.environ.copy()
    if password is not None:
        environment["PGPASSWORD"] = password
    # Build libpq's URI with percent encoding, including query spaces (SQLAlchemy's
    # display renderer uses '+' there). Never include either form of password in argv.
    host = url.host or ""
    if ":" in host:
        host = f"[{host}]"
    authority = f"{quote(url.username, safe='')}@" if url.username is not None else ""
    authority += host + (f":{url.port}" if url.port is not None else "")
    # make_url decodes credentials/query values but leaves database percent escapes intact.
    connection = f"postgresql://{authority}/{quote(url.database or '', safe='%')}"
    if query:
        connection += "?" + urlencode(query, doseq=True, quote_via=quote)
    executable = shutil.which("pg_dump")
    if executable is None:
        raise RuntimeError("pg_dump is not installed in this image")
    # Fixed executable, argv (no shell), operator-configured database connection only.
    with subprocess.Popen(  # noqa: S603
        [executable, "--dbname", connection], stdout=subprocess.PIPE, env=environment
    ) as process:
        if process.stdout is None:
            raise RuntimeError("pg_dump stdout is unavailable")
        try:
            with gzip.open(destination, "wb") as output:
                shutil.copyfileobj(process.stdout, output)
        except BaseException:
            process.kill()
            raise
        if process.wait() != 0:
            raise RuntimeError("PostgreSQL dump failed; no backup pair was produced")


def pin_blobs(destination: Path) -> None:
    """Pin complete files only; internal scratch files and prior backups are not incident data."""
    root = Path(os.path.realpath(storage._ROOT))
    destination.mkdir()

    def refuse_unreadable(error: OSError) -> None:
        raise error

    for directory, subdirs, files in os.walk(root, onerror=refuse_unreadable):
        parent = Path(directory)
        subdirs[:] = [
            name for name in subdirs if not name.startswith(".") and not (parent == root and name == "backups")
        ]
        for name in [*subdirs, *files]:
            if (parent / name).is_symlink():
                raise ValueError("Storage contains a symlink; refusing an ambiguous backup")
        for name in files:
            if name.startswith("."):
                continue
            source = parent / name
            if not stat.S_ISREG(source.stat(follow_symlinks=False).st_mode):
                raise ValueError("Storage contains a non-regular file; refusing an ambiguous backup")
            target = destination / source.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            os.link(source, target)


def write_pair(output: BinaryIO) -> None:
    """Stream a transport tar containing the two independently verifiable backup files."""
    with backup_run() as work:
        database = work / "db.sql.gz"
        snapshot = work / "blobs"
        with storage.backup_guard():
            dump_database(database)
            pin_blobs(snapshot)
        storage.collect_deferred_deletes()
        assets = work / "storage.tar.gz"
        with tarfile.open(assets, "w:gz") as archive:
            archive.add(snapshot, arcname=".")
        with tarfile.open(fileobj=output, mode="w|") as transport:
            transport.add(database, arcname="db.sql.gz")
            transport.add(assets, arcname="storage.tar.gz")


if __name__ == "__main__":
    try:
        write_pair(sys.stdout.buffer)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"Backup failed: {exc}", file=sys.stderr)
        sys.exit(1)

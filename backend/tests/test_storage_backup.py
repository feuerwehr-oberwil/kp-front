"""A stored blob remains a complete immutable version while backups/readers use it."""

import gzip
import io
import multiprocessing
import os
import tarfile
from pathlib import Path

import pytest

from app import backup, storage


def test_replacing_a_blob_preserves_an_existing_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "_ROOT", str(tmp_path / "storage"))
    storage.put_bytes("plans/example.pdf", b"original plan")
    snapshot = tmp_path / "snapshot.pdf"
    os.link(storage.local_path("plans/example.pdf"), snapshot)

    storage.put_bytes("plans/example.pdf", b"replacement plan")

    assert storage.get_bytes("plans/example.pdf") == b"replacement plan"
    assert snapshot.read_bytes() == b"original plan"


@pytest.mark.asyncio
async def test_failed_stream_does_not_destroy_a_committed_blob(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "_ROOT", str(tmp_path / "storage"))
    storage.put_bytes("media/example.wav", b"committed recording")

    async def interrupted():
        yield b"unfinished replacement"
        raise ConnectionError("upload disconnected")

    with pytest.raises(ConnectionError, match="upload disconnected"):
        await storage.put_astream("media/example.wav", interrupted())

    assert storage.get_bytes("media/example.wav") == b"committed recording"
    assert list((tmp_path / "storage" / "media").iterdir()) == [tmp_path / "storage" / "media" / "example.wav"]


@pytest.fixture
def backup_root(tmp_path, monkeypatch):
    root = tmp_path / "storage"
    root.mkdir()
    monkeypatch.setattr(storage, "_ROOT", str(root))
    return root


def _unpack_pair(data):
    with tarfile.open(fileobj=io.BytesIO(data)) as transport:
        dump = transport.extractfile("db.sql.gz").read()
        assets = transport.extractfile("storage.tar.gz").read()
    with tarfile.open(fileobj=io.BytesIO(assets), mode="r:gz") as archive:
        files = {
            member.name.removeprefix("./"): archive.extractfile(member).read()
            for member in archive.getmembers()
            if member.isfile()
        }
    return gzip.decompress(dump), files


def test_dump_reference_survives_concurrent_plan_replacement_and_cleanup(backup_root, monkeypatch):
    storage.put_bytes("plans/old.pdf", b"old plan")

    def dump(destination):
        # SQL snapshot already references old.pdf. A replacement transaction commits
        # before pinning and invokes its after-commit deletion of the old blob.
        with gzip.open(destination, "wb") as output:
            output.write(b"PostgreSQL database dump: plans/old.pdf")
        storage.put_bytes("plans/new.pdf", b"new plan")
        storage.delete("plans/old.pdf")
        assert storage.exists("plans/old.pdf")

    monkeypatch.setattr(backup, "dump_database", dump)
    original_collect = storage.collect_deferred_deletes

    def after_pin():
        original_collect()
        # Deletion after pinning cannot destroy bytes used by compression either.
        if storage.exists("plans/new.pdf"):
            storage.delete("plans/new.pdf")

    monkeypatch.setattr(storage, "collect_deferred_deletes", after_pin)
    output = io.BytesIO()
    backup.write_pair(output)
    dump_bytes, files = _unpack_pair(output.getvalue())
    assert b"plans/old.pdf" in dump_bytes
    assert files == {"plans/old.pdf": b"old plan", "plans/new.pdf": b"new plan"}
    assert not storage.exists("plans/old.pdf")
    assert list(Path(storage.backup_directory()).glob("work-*")) == []
    assert list((Path(storage.backup_directory()) / "deferred").glob("*.json")) == []


def test_deferred_delete_does_not_remove_a_replacement_inode(backup_root):
    storage.put_bytes("cache/thumb.jpg", b"old")
    with storage.backup_guard():
        storage.delete("cache/thumb.jpg")
        storage.put_bytes("cache/thumb.jpg", b"new")
    storage.collect_deferred_deletes()
    assert storage.get_bytes("cache/thumb.jpg") == b"new"


def test_failed_deletion_marker_keeps_original(backup_root, monkeypatch):
    storage.put_bytes("plans/original.pdf", b"original")

    def refuse(*args, **kwargs):
        raise OSError("disk full")

    with storage.backup_guard():
        monkeypatch.setattr(storage.json, "dump", refuse)
        with pytest.raises(OSError, match="disk full"):
            storage.delete("plans/original.pdf")
    assert storage.get_bytes("plans/original.pdf") == b"original"


def test_only_complete_blobs_are_pinned(backup_root, tmp_path):
    storage.put_bytes("media/complete.jpg", b"complete")
    (backup_root / "media" / ".upload-partial").write_bytes(b"partial")
    (backup_root / ".readycheck-partial").write_bytes(b"probe")
    (backup_root / "backups").mkdir()
    (backup_root / "backups" / "pre-migrate.sql.gz").write_bytes(b"prior dump")
    destination = tmp_path / "pinned"
    with storage.backup_guard():
        backup.pin_blobs(destination)
    assert [str(path.relative_to(destination)) for path in destination.rglob("*") if path.is_file()] == [
        "media/complete.jpg"
    ]


@pytest.mark.parametrize("special", ["symlink", "fifo"])
def test_backup_refuses_nonregular_blobs(backup_root, tmp_path, special):
    if special == "symlink":
        (backup_root / "unsafe").symlink_to(tmp_path / "outside")
    else:
        os.mkfifo(backup_root / "unsafe")
    with storage.backup_guard(), pytest.raises(ValueError, match="refusing"):
        backup.pin_blobs(tmp_path / "pinned")


def test_overlapping_backup_is_refused_and_failed_owner_releases_lock(backup_root):
    with pytest.raises(RuntimeError, match="interrupted"), backup.backup_run():
        with pytest.raises(RuntimeError, match="already running"), backup.backup_run():
            pass
        raise RuntimeError("interrupted")
    with backup.backup_run() as work:
        assert work.is_dir()


@pytest.mark.parametrize("failure", ["dump", "pin", "compress"])
def test_interrupted_capture_never_emits_a_pair_and_cleans_work(backup_root, monkeypatch, failure):
    storage.put_bytes("plans/old.pdf", b"old")

    def fail(*args, **kwargs):
        raise OSError("synthetic interruption")

    def dump(destination):
        with gzip.open(destination, "wb") as output:
            output.write(b"PostgreSQL database dump")
        storage.delete("plans/old.pdf")

    monkeypatch.setattr(backup, "dump_database", fail if failure == "dump" else dump)
    if failure == "pin":
        monkeypatch.setattr(backup, "pin_blobs", fail)
    if failure == "compress":
        monkeypatch.setattr(backup.tarfile, "open", fail)
    output = io.BytesIO()
    with pytest.raises(OSError, match="synthetic interruption"):
        backup.write_pair(output)
    assert output.getvalue() == b""
    assert list(Path(storage.backup_directory()).glob("work-*")) == []
    storage.collect_deferred_deletes()


def _hold_backup_guard(root, ready, finish):
    storage._ROOT = root
    with storage.backup_guard():
        ready.set()
        finish.wait()


def test_another_process_retains_deletes_and_kernel_releases_a_killed_helper(backup_root):
    storage.put_bytes("plans/original.pdf", b"original")
    ctx = multiprocessing.get_context("fork")
    ready, finish = ctx.Event(), ctx.Event()
    process = ctx.Process(target=_hold_backup_guard, args=(str(backup_root), ready, finish))
    process.start()
    try:
        assert ready.wait(5)
        storage.delete("plans/original.pdf")
        assert storage.exists("plans/original.pdf")
        process.kill()
        process.join(5)
        assert not process.is_alive()
        storage.collect_deferred_deletes()
        assert not storage.exists("plans/original.pdf")
    finally:
        if process.is_alive():
            process.kill()
        process.join(5)

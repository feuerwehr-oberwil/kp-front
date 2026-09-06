"""Interrupted deletion metadata must release retained bytes without racing a live producer."""

import gzip
import io
import json
import multiprocessing
import os
import tarfile
from pathlib import Path
from unittest.mock import patch

import pytest

from app import backup, storage


@pytest.fixture
def deferred_root(tmp_path, monkeypatch):
    root = tmp_path / "storage"
    monkeypatch.setattr(storage, "_ROOT", str(root))
    storage.put_bytes("media/example.wav", b"original recording")
    return root


def _interrupt_deferred_operation(root: str, phase: str) -> None:
    storage._ROOT = root
    if phase == "publication":
        replace = os.replace

        def interrupt(source, target):
            if str(target).endswith(".json"):
                os._exit(91)
            replace(source, target)

        with patch.object(storage.os, "replace", interrupt):
            storage.delete("media/example.wav")
    else:
        remove = os.remove

        def interrupt(path):
            if str(path).endswith(".blob"):
                os._exit(92)
            remove(path)

        with patch.object(storage.os, "remove", interrupt):
            storage.collect_deferred_deletes()
    raise RuntimeError("The simulated crash boundary was not reached")


def _run_interruption(root: Path, phase: str) -> None:
    process = multiprocessing.get_context("fork").Process(target=_interrupt_deferred_operation, args=(str(root), phase))
    process.start()
    try:
        process.join(5)
        assert not process.is_alive(), "Deferred operation blocked"
        assert process.exitcode == (91 if phase == "publication" else 92)
    finally:
        if process.is_alive():
            process.kill()
        process.join(5)


@pytest.mark.parametrize("phase", ["publication", "cleanup"])
def test_next_backup_reclaims_crash_orphans_without_deleting_a_replacement(deferred_root, phase):
    with storage.backup_guard():
        if phase == "publication":
            _run_interruption(deferred_root, phase)
        else:
            storage.delete("media/example.wav")
    if phase == "cleanup":
        _run_interruption(deferred_root, phase)
    directory = deferred_root / ".kp-backup" / "deferred"
    assert list(directory.glob("*.blob")), "The crash must leave a retained inode"
    # Never leave a published delete pointing at an unpinned inode after interrupted cleanup.
    assert not list(directory.glob("*.json"))
    storage.put_bytes("media/example.wav", b"replacement recording")

    with backup.backup_run():
        pass

    assert list(directory.iterdir()) == []
    assert storage.get_bytes("media/example.wav") == b"replacement recording"


def test_collector_leaves_in_progress_producer_until_metadata_is_published(deferred_root):
    directory = Path(storage.backup_directory()) / "deferred"
    directory.mkdir()
    stem = directory / "in-progress"
    source = storage.local_path("media/example.wav")
    with storage._file_guard("deferred.lock"):
        os.link(source, stem.with_suffix(".blob"))
        stem.with_suffix(".part").write_text("unfinished metadata")

        storage.collect_deferred_deletes()

        assert stem.with_suffix(".blob").read_bytes() == b"original recording"
        assert stem.with_suffix(".part").exists()
        stem.with_suffix(".part").write_text(json.dumps({"key": "media/example.wav"}))
        os.replace(stem.with_suffix(".part"), stem.with_suffix(".json"))

    storage.collect_deferred_deletes()

    assert list(directory.iterdir()) == []
    assert not storage.exists("media/example.wav")


@pytest.mark.parametrize(
    "metadata", [b"{", b"[]", b"{}", b'{"key": null}', b'{"key": 1}', b'{"key": "../outside"}', b"\xff"]
)
def test_corrupt_marker_preserves_its_only_pin_and_does_not_block_other_cleanup_or_backup(
    deferred_root, monkeypatch, caplog, metadata
):
    storage.put_bytes("media/valid.wav", b"obsolete recording")
    with storage.backup_guard():
        storage.delete("media/example.wav")
        storage.delete("media/valid.wav")
    directory = Path(storage.backup_directory()) / "deferred"
    marker = next(
        path for path in directory.glob("*.json") if json.loads(path.read_text())["key"] == "media/example.wav"
    )
    marker.write_bytes(metadata)
    # The pin may be the only recoverable old bytes after another physical deletion.
    os.remove(storage.local_path("media/example.wav"))
    pin = marker.with_suffix(".blob")
    storage.put_bytes("media/current.wav", b"current recording")

    def dump(destination):
        destination.write_bytes(gzip.compress(b"PostgreSQL database dump"))

    monkeypatch.setattr(backup, "dump_database", dump)
    output = io.BytesIO()
    backup.write_pair(output)
    storage.collect_deferred_deletes()

    assert marker.read_bytes() == metadata
    assert pin.read_bytes() == b"original recording"
    assert set(directory.iterdir()) == {marker, pin}
    assert not storage.exists("media/valid.wav")
    assert "retaining marker and pinned blob for inspection" in caplog.text
    with tarfile.open(fileobj=io.BytesIO(output.getvalue())) as transport:
        assert {item.name for item in transport.getmembers()} == {"db.sql.gz", "storage.tar.gz"}

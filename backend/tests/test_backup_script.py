"""Exercise the operator's real Bash publication/retention flow without contacting Docker."""

import gzip
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DUMP = b"-- PostgreSQL database dump\nSELECT 'synthetic fixture';\n"


def tar_bytes(files: dict[str, bytes], *, compressed: bool = False) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz" if compressed else "w") as archive:
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    return output.getvalue()


@pytest.fixture
def backup_shell(tmp_path):
    checkout = tmp_path / "checkout with spaces"
    scripts = checkout / "scripts"
    scripts.mkdir(parents=True)
    for name in ("backup.sh", "lib.sh"):
        shutil.copy2(REPO_ROOT / "scripts" / name, scripts / name)
    env_dir = tmp_path / "station config"
    env_dir.mkdir()
    env_file = env_dir / "deployment.env"
    env_file.write_text("POSTGRES_USER=\"test operator\"\nPOSTGRES_DB='test incident'\nBACKUP_KEEP=2\n")
    backups = tmp_path / "backup pairs"
    backups.mkdir()
    for stamp in ("2000-01-01-000000", "2000-01-02-000000", "2000-01-03-000000"):
        (backups / f"db-{stamp}.sql.gz").write_bytes(gzip.compress(DUMP + stamp.encode()))
        (backups / f"storage-{stamp}.tar.gz").write_bytes(tar_bytes({"old": stamp.encode()}, compressed=True))
    # A historical interrupted pair must neither count towards retention nor get deleted.
    (backups / "db-2099-01-01-000000.sql.gz").write_bytes(b"historical database orphan")
    (backups / "storage-2099-01-02-000000.tar.gz").write_bytes(b"historical storage orphan")
    original = {path.name: path.read_bytes() for path in backups.iterdir()}
    transport = tmp_path / "transport.tar"
    log = tmp_path / "docker.json"
    commands = tmp_path / "bin"
    commands.mkdir()
    docker = commands / "docker"
    docker.write_text(
        f"#!{sys.executable}\n"
        "import json, os, pathlib, sys\n"
        "pathlib.Path(os.environ['KP_TEST_DOCKER_LOG']).write_text(json.dumps({\n"
        "    'args': sys.argv[1:], 'cwd': os.getcwd(),\n"
        "    'user': os.environ.get('POSTGRES_USER'), 'db': os.environ.get('POSTGRES_DB')}))\n"
        "sys.stdout.buffer.write(pathlib.Path(os.environ['KP_TEST_TRANSPORT']).read_bytes())\n"
        "sys.stdout.buffer.flush()\n"
        "sys.exit(int(os.environ['KP_TEST_HELPER_EXIT']))\n"
    )
    docker.chmod(0o700)

    def run(
        payload: bytes,
        *,
        helper_exit: int = 0,
        parent_token: str = "",
        default_env: bool = False,
        bash_path: str | None = None,
        fail_publication: bool = False,
    ):
        transport.write_bytes(payload)
        bash = bash_path or shutil.which("bash")
        assert bash is not None
        if default_env:
            shutil.copy2(env_file, checkout / ".env")
        if fail_publication:
            move = commands / "mv"
            move.write_text(
                f"#!{sys.executable}\n"
                "import os, pathlib, sys\n"
                "if pathlib.Path(sys.argv[1]).name == 'storage.tar.gz':\n"
                "    print('mv: synthetic publication failure', file=sys.stderr)\n"
                "    sys.exit(1)\n"
                "os.rename(sys.argv[1], sys.argv[2])\n"
            )
            move.chmod(0o700)
        env = {key: value for key, value in os.environ.items() if key != "BACKUP_KEEP"}
        env.update(
            PATH=f"{commands}{os.pathsep}{os.environ['PATH']}",
            KP_ENV_FILE=".env" if default_env else str(env_file),
            KP_OPERATION_PARENT_TOKEN=parent_token,
            KP_TEST_DOCKER_LOG=str(log),
            KP_TEST_TRANSPORT=str(transport),
            KP_TEST_HELPER_EXIT=str(helper_exit),
        )
        result = subprocess.run(  # noqa: S603 -- real script in an isolated checkout, fake Docker only
            [bash, str(scripts / "backup.sh"), str(backups)],
            cwd=tmp_path,
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        return result

    return run, backups, original, log, env_file, checkout


def valid_transport() -> bytes:
    return tar_bytes(
        {"db.sql.gz": gzip.compress(DUMP), "storage.tar.gz": tar_bytes({"media/test": b"photo"}, compressed=True)}
    )


@pytest.mark.parametrize(
    "failure",
    [
        "helper-exit",
        "partial-transport",
        "missing-storage",
        "invalid-dump-gzip",
        "invalid-dump",
        "invalid-storage-gzip",
        "invalid-storage-tar",
    ],
)
def test_failed_backup_preserves_every_previous_file_without_publishing_half_a_pair(backup_shell, failure):
    run, backups, original, log, env_file, _checkout = backup_shell
    files = {"db.sql.gz": gzip.compress(DUMP), "storage.tar.gz": tar_bytes({"media/test": b"photo"}, compressed=True)}
    if failure == "missing-storage":
        del files["storage.tar.gz"]
    elif failure == "invalid-dump-gzip":
        files["db.sql.gz"] = b"interrupted gzip"
    elif failure == "invalid-dump":
        files["db.sql.gz"] = gzip.compress(b"database connection failed")
    elif failure == "invalid-storage-gzip":
        files["storage.tar.gz"] = b"interrupted gzip"
    elif failure == "invalid-storage-tar":
        files["storage.tar.gz"] = gzip.compress(b"not a tar archive")
    payload = tar_bytes(files)
    if failure == "partial-transport":
        # Stop in the second member's body, after the database has already extracted.
        payload = payload[: 1536 + len(files["storage.tar.gz"]) // 2]
    result = run(payload, helper_exit=17 if failure == "helper-exit" else 0)
    assert result.returncode != 0
    assert log.exists(), result.stderr
    assert {path.name: path.read_bytes() for path in backups.iterdir()} == original
    assert not (env_file.parent / ".kp-front-operation.lock").exists()


def test_success_publishes_verified_pair_and_retains_whole_pairs_with_paths_and_env_containing_spaces(backup_shell):
    run, backups, original, log, env_file, checkout = backup_shell
    result = run(valid_transport())
    assert result.returncode == 0, result.stderr
    remaining = {path.name: path.read_bytes() for path in backups.iterdir()}
    added = remaining.keys() - original.keys()
    assert len(added) == 2
    database = next(name for name in added if name.startswith("db-"))
    assets = f"storage-{database.removeprefix('db-').removesuffix('.sql.gz')}.tar.gz"
    assert assets in added
    assert gzip.decompress(remaining[database]) == DUMP
    with tarfile.open(fileobj=io.BytesIO(remaining[assets]), mode="r:gz") as archive:
        photo = archive.extractfile("media/test")
        assert photo is not None and photo.read() == b"photo"
    expected_old = {name: data for name, data in original.items() if "2000-01-03" in name or "2099-" in name}
    assert {name: data for name, data in remaining.items() if name not in added} == expected_old
    assert json.loads(log.read_text()) == {
        "args": [
            "compose",
            "--env-file",
            str(env_file),
            "run",
            "--rm",
            "--no-deps",
            "-T",
            "app",
            "uv",
            "run",
            "python",
            "-m",
            "app.backup",
        ],
        "cwd": str(checkout),
        "user": "test operator",
        "db": "test incident",
    }
    assert not (env_file.parent / ".kp-front-operation.lock").exists()


def test_second_publication_failure_removes_first_half_and_does_not_rotate_old_pairs(backup_shell):
    run, backups, original, _log, env_file, _checkout = backup_shell
    result = run(valid_transport(), fail_publication=True)
    assert result.returncode != 0
    assert "synthetic publication failure" in result.stderr
    assert {path.name: path.read_bytes() for path in backups.iterdir()} == original
    assert not (env_file.parent / ".kp-front-operation.lock").exists()


@pytest.mark.parametrize("parent_token", ["", "wrong-token"])
def test_operation_guard_refuses_before_helper_or_retention(backup_shell, parent_token):
    run, backups, original, log, env_file, _checkout = backup_shell
    lock = env_file.parent / ".kp-front-operation.lock"
    lock.mkdir()
    (lock / "token").write_text("restore-owner\n")
    result = run(valid_transport(), parent_token=parent_token)
    assert result.returncode != 0
    assert not log.exists()
    assert {path.name: path.read_bytes() for path in backups.iterdir()} == original
    assert (lock / "token").read_text() == "restore-owner\n"


def test_backup_inherits_restore_guard_without_removing_parent_lock(backup_shell):
    run, _backups, _original, _log, env_file, _checkout = backup_shell
    lock = env_file.parent / ".kp-front-operation.lock"
    lock.mkdir()
    (lock / "token").write_text("restore-owner\n")
    result = run(valid_transport(), parent_token="restore-owner")
    assert result.returncode == 0, result.stderr
    assert (lock / "token").read_text() == "restore-owner\n"


@pytest.mark.parametrize(
    "bash_path",
    list(dict.fromkeys(path for path in (shutil.which("bash"), "/bin/bash") if path and Path(path).exists())),
)
def test_default_env_backup_works_with_host_bash_and_releases_checkout_guard(backup_shell, bash_path):
    run, _backups, _original, log, _env_file, checkout = backup_shell
    result = run(valid_transport(), default_env=True, bash_path=bash_path)
    assert result.returncode == 0, result.stderr
    assert json.loads(log.read_text())["args"][:3] == ["compose", "run", "--rm"]
    assert not (checkout / ".kp-front-operation.lock").exists()


def test_just_completed_pair_is_kept_even_if_an_older_filename_sorts_after_it(backup_shell):
    run, backups, original, _log, _env_file, _checkout = backup_shell
    (backups / "db-9999-01-01.sql.gz").write_bytes(gzip.compress(DUMP))
    (backups / "storage-9999-01-01.tar.gz").write_bytes(tar_bytes({"media/future": b"old"}, compressed=True))
    before = {path.name for path in backups.iterdir()}
    result = run(valid_transport())
    assert result.returncode == 0, result.stderr
    added = {path.name for path in backups.iterdir()} - before
    assert len(added) == 2
    assert sum(path.name.startswith("db-") and "2099-" not in path.name for path in backups.iterdir()) == 2


def test_retention_with_leading_zero_is_decimal(backup_shell):
    run, _backups, _original, _log, env_file, _checkout = backup_shell
    env_file.write_text(env_file.read_text().replace("BACKUP_KEEP=2", "BACKUP_KEEP=08"))
    result = run(valid_transport())
    assert result.returncode == 0, result.stderr
    assert "keeping 8 pairs" in result.stdout
    assert "value too great for base" not in result.stderr

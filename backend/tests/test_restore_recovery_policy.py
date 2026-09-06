"""Recovery must not remigrate a restored database before the operator selects its image."""

import gzip
import io
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def restore_command(tmp_path):
    root = tmp_path / "deployment"
    scripts = root / "scripts"
    scripts.mkdir(parents=True)
    shutil.copyfile(REPO_ROOT / "scripts/restore.sh", scripts / "restore.sh")
    (root / ".env").write_text("KP_FRONT_TAG=current\n")
    (root / "settings file.env").write_text("KP_FRONT_TAG=current\n")
    (root / "docker-compose.yml").write_text("name: isolated-recovery\n")
    # Keep the restore algorithm real, with deterministic infrastructure and readiness seams.
    (scripts / "lib.sh").write_text(
        (REPO_ROOT / "scripts/lib.sh").read_text()
        + """
C_B='' C_0=''
COMPOSE_ARGS=()
say() { printf '%s\\n' "$*"; }
sayf() { printf "$@"; }
step() { say "$*"; }
ok() { say "$*"; }
info() { say "$*"; }
warn() { say "$*" >&2; }
die() { warn "$*"; exit 1; }
preflight() { return 0; }
kp_env_value() { printf '%s' "$2"; }
compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }
probe_ready() { SECONDS=181; [[ "$KP_TEST_RESTORE_FAILURE" != ready ]]; }
roster_count() { echo 2; }
"""
    )
    (scripts / "backup.sh").write_text("""#!/usr/bin/env bash
. "$(dirname "$0")/lib.sh"
kp_operation_lock "$KP_ENV_FILE" backup "$KP_OPERATION_PARENT_TOKEN" || exit 1
[[ "$KP_OPERATION_LOCK_OWNED" == 0 ]] || exit 1
kp_operation_unlock
printf 'backup\\n' >> "$KP_TEST_RESTORE_LOG"
[[ "$KP_TEST_RESTORE_FAILURE" != backup ]]
""")
    (scripts / "backup.sh").chmod(0o700)
    commands = tmp_path / "bin"
    commands.mkdir()
    docker = commands / "docker"
    docker.write_text("""#!/usr/bin/env python3
import json, os, sys
args=sys.argv[1:]
with open(os.environ['KP_TEST_RESTORE_LOG'], 'a') as log:
    log.write(json.dumps(args)+'\\n')
joined=' '.join(args)
failure=os.environ['KP_TEST_RESTORE_FAILURE']
if 'stop app' in joined and failure == 'stop': sys.exit(1)
if 'up -d' in joined and failure == 'start': sys.exit(1)
if args[0] == 'inspect': print('isolated-recovery')
elif 'ps' in args: print('db-fixture')
elif 'psql' in args:
    if '-At' in args:
        if 'server_version_num' in joined:
            print('unknown' if failure == 'version' else os.environ['KP_TEST_PG_VERSION'])
        else: print('abc123' if 'version_num' in joined else '2')
    elif '-c' not in args:
        with open(os.environ['KP_TEST_RESTORE_LOG'], 'a') as log:
            log.write(json.dumps(['restored_sql', sys.stdin.read()])+'\\n')
        if failure == 'sql': sys.exit(1)
elif 'wc -l' in joined: print('1')
elif 'du -sh' in joined: print('4K')
elif 'tar xzf' in joined: sys.stdin.buffer.read()
""")
    docker.chmod(0o700)
    dump = tmp_path / "db-example.sql.gz"
    dump.write_bytes(
        gzip.compress(
            b"-- PostgreSQL database dump\nSET transaction_timeout = 0;\n"
            b"-- Name: alembic_version; Type: TABLE\nCREATE TABLE alembic_version ();\n"
            b"COPY example (value) FROM stdin;\nSET transaction_timeout = 0;\n\\.\n"
            b"SET transaction_timeout = 123;\n"
        )
    )
    with tarfile.open(tmp_path / "storage-example.tar.gz", "w:gz") as archive:
        member = tarfile.TarInfo("media/photo.jpg")
        member.size = 5
        archive.addfile(member, io.BytesIO(b"photo"))
    log = tmp_path / "commands.log"

    def run(*flags, failure="", pg_version="160015"):
        lock = root / ".kp-front-operation.lock"
        if failure == "locked":
            lock.mkdir()
            (lock / "token").write_text("other-owner\n")
        bash = shutil.which("bash")
        assert bash is not None
        result = subprocess.run(  # noqa: S603 -- isolated copy with controlled infrastructure
            [bash, str(scripts / "restore.sh"), "--yes", *flags, str(dump)],
            env={
                **os.environ,
                "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
                "KP_TEST_RESTORE_LOG": str(log),
                "KP_TEST_RESTORE_FAILURE": failure,
                "KP_TEST_PG_VERSION": pg_version,
            },
            cwd=root,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        calls = log.read_text().splitlines() if log.exists() else []
        if failure == "locked":
            assert (lock / "token").read_text() == "other-owner\n"
        else:
            assert not lock.exists(), "restore must release its own host lock on success and failure"
        return result, [line if line == "backup" else " ".join(json.loads(line)) for line in calls]

    return run


@pytest.mark.parametrize("db_only", [False, True])
def test_restore_no_start_leaves_database_at_restored_revision(restore_command, db_only):
    flags = ("--no-start", "--db-only") if db_only else ("--no-start",)
    result, calls = restore_command(*flags)
    assert result.returncode == 0, result.stderr
    assert any("DROP SCHEMA" in call for call in calls)
    assert any("tar xzf" in call for call in calls) is not db_only
    assert not any("up -d" in call or "uv run alembic" in call for call in calls)
    assert calls.index("compose stop app") < calls.index("backup")
    assert "abc123" in result.stdout
    assert "KP_FRONT_TAG" in result.stdout
    assert "stopped" in result.stdout.lower()


@pytest.mark.parametrize("content", [b"not a tar archive", b""])
def test_restore_refuses_invalid_storage_before_any_container_mutation(restore_command, tmp_path, content):
    (tmp_path / "storage-example.tar.gz").write_bytes(gzip.compress(content))
    result, calls = restore_command("--no-start")
    assert result.returncode != 0
    assert "no tar archive" in result.stderr
    # Only the existing read-only project identification is allowed before refusal.
    assert calls == [
        "compose ps -aq db",
        'inspect -f {{index .Config.Labels "com.docker.compose.project"}} db-fixture',
    ]


def test_restore_accepts_empty_storage_volume(restore_command, tmp_path):
    empty_volume = tmp_path / "empty volume"
    empty_volume.mkdir()
    with tarfile.open(tmp_path / "storage-example.tar.gz", "w:gz") as archive:
        archive.add(empty_volume, arcname=".")
    result, calls = restore_command("--no-start")
    assert result.returncode == 0, result.stderr
    assert any("tar xzf" in call for call in calls)


def test_no_start_instructions_keep_custom_environment_selection(restore_command):
    result, _calls = restore_command("--no-start", "--env-file", "settings file.env")
    assert result.returncode == 0, result.stderr
    assert result.stdout.count(r"docker compose --env-file settings\ file.env") == 3


def test_no_start_instructions_preserve_compose_file_and_project(restore_command, monkeypatch):
    monkeypatch.setenv("COMPOSE_FILE", "/srv/custom stack.yml")
    monkeypatch.setenv("COMPOSE_PROJECT_NAME", "recovery-check")
    result, _calls = restore_command("--no-start")
    assert result.returncode == 0, result.stderr
    assert result.stdout.count(r"COMPOSE_FILE=/srv/custom\ stack.yml COMPOSE_PROJECT_NAME=recovery-check ") == 4


def test_stop_failure_never_starts_destructive_restore(restore_command):
    result, calls = restore_command(failure="stop")
    assert result.returncode != 0
    assert not any("DROP SCHEMA" in call or "tar xzf" in call for call in calls)
    assert "backup" not in calls


def test_other_backup_blocks_restore_before_any_container_mutation(restore_command):
    result, calls = restore_command(failure="locked")
    assert result.returncode != 0
    assert calls == []
    assert "stale lock" in result.stderr


def test_failed_safety_backup_stops_before_replacing_any_data(restore_command):
    result, calls = restore_command(failure="backup")
    assert result.returncode != 0
    assert "backup" in calls
    assert not any("DROP SCHEMA" in call or "tar xzf" in call or "up -d" in call for call in calls)
    assert "--skip-safety-copy" in result.stderr


def test_explicit_skip_does_not_attempt_backup_and_warns_before_recovery(restore_command):
    result, calls = restore_command("--skip-safety-copy", "--no-start", failure="backup")
    assert result.returncode == 0, result.stderr
    assert "backup" not in calls
    assert any("DROP SCHEMA" in call for call in calls)
    assert "NO safety copy" in result.stderr
    assert "is taken first" not in result.stdout


@pytest.mark.parametrize("failure", ["start", "ready"])
def test_restore_does_not_report_success_when_restart_fails(restore_command, failure):
    result, _calls = restore_command(failure=failure)
    assert result.returncode != 0


def test_ordinary_restore_still_starts_the_app(restore_command):
    result, calls = restore_command()
    assert result.returncode == 0, result.stderr
    assert "compose up -d" in calls


@pytest.mark.parametrize("pg_version, expected_lines", [("160015", 1), ("170002", 2), ("180000", 2)])
def test_pg16_compatibility_only_removes_exact_preamble_setting(restore_command, pg_version, expected_lines):
    result, calls = restore_command("--no-start", pg_version=pg_version)
    assert result.returncode == 0, result.stderr
    sql = next(call for call in calls if call.startswith("restored_sql "))
    assert sql.count("SET transaction_timeout = 0;") == expected_lines
    assert "COPY example (value) FROM stdin;\nSET transaction_timeout = 0;\n\\." in sql
    assert "SET transaction_timeout = 123;" in sql


def test_unreadable_target_version_refuses_before_backup_or_drop(restore_command):
    result, calls = restore_command(failure="version")
    assert result.returncode != 0
    assert "backup" not in calls
    assert not any("DROP SCHEMA" in call for call in calls)


def test_other_sql_failures_still_abort_restore(restore_command):
    result, calls = restore_command(failure="sql")
    assert result.returncode != 0
    assert not any("tar xzf" in call or "up -d" in call for call in calls)

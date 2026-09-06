"""An unsupported database must not consume the migration backups needed to recover it."""

import gzip
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def startup(tmp_path):
    """Run the real startup shell against controlled command results, never a live database."""
    commands = tmp_path / "bin"
    commands.mkdir()
    log = tmp_path / "commands.log"
    backups = tmp_path / "backups"
    backups.mkdir()
    for index in range(5):
        path = backups / f"pre-migrate-20260901-00000{index}.sql.gz"
        path.write_bytes(gzip.compress(f"original backup {index}".encode()))
        os.utime(path, (index + 1, index + 1))
    original = {path.name: path.read_bytes() for path in backups.iterdir()}
    programs = {
        "uv": """#!/usr/bin/env bash
printf 'uv %s\n' "$*" >> "$KP_TEST_COMMAND_LOG"
case "$*" in
  'run alembic current')
    case "$KP_TEST_MIGRATION_STATE" in
      unknown) echo "Can't locate revision identified by 'newer_revision'" >&2; exit 1 ;;
      unavailable) echo 'Database connection refused' >&2; exit 1 ;;
      empty) exit 0 ;;
      *) echo 'abc123 (head)' ;;
    esac ;;
  'run alembic heads')
    if [[ "$KP_TEST_MIGRATION_STATE" == 'broken-heads' ]]; then exit 1; fi
    echo 'abc123 (head)' ;;
  'run alembic upgrade head')
    if [[ "$KP_TEST_MIGRATION_STATE" == 'unknown' ]]; then exit 1; fi ;;
esac
""",
        "pg_dump": """#!/usr/bin/env bash
if [[ "${1:-}" == '--version' ]]; then
  printf 'pg_dump version probe\n' >> "$KP_TEST_COMMAND_LOG"
  echo 'pg_dump (PostgreSQL) 18.0'; exit
fi
printf 'pg_dump content\n' >> "$KP_TEST_COMMAND_LOG"
echo '-- PostgreSQL database dump'
echo 'dump contents'
""",
        "psql": """#!/usr/bin/env bash
printf 'psql\n' >> "$KP_TEST_COMMAND_LOG"
echo '18.0'
""",
    }
    for name, body in programs.items():
        path = commands / name
        path.write_text(body)
        path.chmod(0o700)

    def run(state: str, *, override: bool = False):
        bash = shutil.which("bash")
        assert bash is not None
        env = {
            **os.environ,
            "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
            "DATABASE_URL": "postgresql+asyncpg://test@unused.invalid/test",
            "MIGRATION_BACKUP_DIR": str(backups),
            "ALLOW_MIGRATION_WITHOUT_BACKUP": "1" if override else "0",
            "KP_TEST_COMMAND_LOG": str(log),
            "KP_TEST_MIGRATION_STATE": state,
        }
        result = subprocess.run(  # noqa: S603 -- fixed script and isolated command fixtures
            [bash, str(REPO_ROOT / "backend/start.sh")],
            env=env,
            cwd=tmp_path,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        return result, log.read_text(), {path.name: path.read_bytes() for path in backups.iterdir()}

    return run, original


@pytest.mark.parametrize("state", ["unknown", "unavailable", "broken-heads"])
@pytest.mark.parametrize("override", [False, True])
def test_unresolved_revision_refuses_before_touching_backups(startup, state, override):
    run, original = startup
    result, calls, remaining = run(state, override=override)
    assert result.returncode != 0
    assert "pg_dump" not in calls
    assert "upgrade head" not in calls
    assert "uvicorn" not in calls
    assert remaining == original
    assert "backup" in result.stderr.lower()


def test_current_revision_starts_without_a_dump(startup):
    run, original = startup
    result, calls, remaining = run("ready")
    assert result.returncode == 0, result.stderr
    assert "pg_dump" not in calls
    assert "uvicorn" in calls
    assert remaining == original


def test_fresh_database_still_takes_a_backup_before_migrating(startup):
    run, _original = startup
    result, calls, remaining = run("empty")
    assert result.returncode == 0, result.stderr
    assert calls.index("pg_dump version probe") < calls.index("pg_dump content")
    assert calls.index("pg_dump content") < calls.index("upgrade head") < calls.index("uvicorn")
    assert len(remaining) == 5
    assert any(b"PostgreSQL database dump" in gzip.decompress(value) for value in remaining.values())

"""Hunt 24.11.2026, ops-integrations F4: a valid database URL with a percent escape stopped
`alembic` (and so the container start) with «invalid interpolation syntax», printing the whole
URL, credentials included. Runs the real `alembic current` against a throw-away SQLite file."""

import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent


def test_alembic_reads_a_percent_escaped_database_url(tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path}/incident%2Dtest.db"
    env = {k: v for k, v in os.environ.items() if k != "KPF_TEST_BASE_DATABASE_URL"} | {"DATABASE_URL": url}
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "current"], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 0, result.stderr[-500:]
    assert "interpolation" not in result.stderr

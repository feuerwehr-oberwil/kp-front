"""Smoke the recovery scripts at the safe, read-only entry points operators use first."""

import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BASH = shutil.which("bash")


def test_restore_help_is_executable_without_a_deployment():
    """The help path must work before Docker, .env, or a backup exists."""
    assert BASH is not None
    result = subprocess.run(  # noqa: S603 -- argv and executable are fixed by this test
        [BASH, "scripts/restore.sh", "--help"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Usage: scripts/restore.sh" in result.stdout
    assert "db: command not found" not in result.stderr


def test_setup_does_not_preseed_write_only_webhook_secrets():
    """An unseen generated value makes intake look configured but cannot be handed off."""
    script = (REPO_ROOT / "scripts/setup.sh").read_text()
    seed_block = script.split("seed_credentials() {", 1)[1].split("# ─── the backup schedule", 1)[0]

    assert "seed_push" in seed_block
    assert "seed_one divera_webhook_secret" not in seed_block
    assert "seed_one alarm_webhook_secret" not in seed_block

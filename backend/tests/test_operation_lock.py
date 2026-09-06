"""The Docker-only host scripts exclude unrelated backups/restores without stale-owner theft."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

LIB = Path(__file__).resolve().parents[2] / "scripts/lib.sh"


@pytest.fixture
def locked_operation(tmp_path):
    bash = shutil.which("bash")
    assert bash is not None
    env_file = tmp_path / ".env"
    env_file.touch()
    env = {**os.environ, "KP_TEST_LIBRARY": str(LIB), "KP_TEST_ENV_FILE": str(env_file)}
    owner = subprocess.Popen(  # noqa: S603 -- fixed shell body, temporary deployment
        [
            bash,
            "-c",
            """
set -eu
. "$KP_TEST_LIBRARY"
kp_operation_lock "$KP_TEST_ENV_FILE" restore
trap kp_operation_unlock EXIT
trap 'exit 143' TERM
echo ready
read -r release
""",
        ],
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert owner.stdout is not None
    assert owner.stdout.readline().strip() == "ready"
    lock = tmp_path / ".kp-front-operation.lock"

    def contender(*, token="", selected_env=env_file):
        return subprocess.run(  # noqa: S603 -- fixed shell body, temporary deployment
            [
                bash,
                "-c",
                """
set -eu
. "$KP_TEST_LIBRARY"
kp_operation_lock "$KP_TEST_ENV_FILE" backup "$KP_TEST_PARENT_TOKEN"
echo "owned=$KP_OPERATION_LOCK_OWNED"
kp_operation_unlock
""",
            ],
            env={**env, "KP_TEST_PARENT_TOKEN": token, "KP_TEST_ENV_FILE": str(selected_env)},
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )

    yield owner, lock, contender, env_file
    if owner.poll() is None:
        owner.communicate("release\n", timeout=5)


def test_only_explicit_parent_token_can_join_without_owning_cleanup(locked_operation):
    _owner, lock, contender, _env_file = locked_operation
    token = (lock / "token").read_text().strip()
    assert contender().returncode != 0
    assert contender(token="wrong-token").returncode != 0
    inherited = contender(token=token)
    assert inherited.returncode == 0, inherited.stderr
    assert inherited.stdout.strip() == "owned=0"
    assert (lock / "token").read_text().strip() == token


def test_symlinked_environment_joins_the_same_exclusion_domain(locked_operation, tmp_path):
    _owner, _lock, contender, env_file = locked_operation
    other = tmp_path / "alias"
    other.mkdir()
    alias = other / ".env"
    alias.symlink_to(env_file)
    assert contender(selected_env=alias).returncode != 0
    assert not (other / ".kp-front-operation.lock").exists()


def test_killed_owner_is_not_auto_stolen(locked_operation):
    owner, lock, contender, _env_file = locked_operation
    owner.kill()
    owner.communicate(timeout=5)
    refused = contender()
    assert refused.returncode != 0
    assert "stale lock" in refused.stderr
    assert lock.exists()


def test_terminated_owner_releases_and_old_token_cannot_recreate_lock(locked_operation):
    owner, lock, contender, _env_file = locked_operation
    token = (lock / "token").read_text().strip()
    owner.terminate()
    owner.communicate(timeout=5)
    assert not lock.exists()
    assert contender(token=token).returncode != 0
    assert not lock.exists()
    assert contender().returncode == 0
    assert not lock.exists()


def test_exit_trap_does_not_remove_a_replaced_owner_token(locked_operation):
    owner, lock, _contender, _env_file = locked_operation
    (lock / "token").write_text("different-owner\n")
    owner.communicate("release\n", timeout=5)
    assert (lock / "token").read_text() == "different-owner\n"

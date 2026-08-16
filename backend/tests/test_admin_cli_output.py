"""What the admin CLIs write to which stream — the contract the setup docs depend on.

Two failures from a real fresh-station install, both of them "the command told the operator
something untrue or unusable":

1. Every ``app.admin_*`` module prints a SECRET_KEY notice at import time, and it went to
   STDOUT. The config-as-code path in ``docs/SETUP.md §3`` opens with a redirect,
   ``uv run python -m app.admin_config example > ~/kp-station/config.json``, so the file
   began with ``🔑 …`` instead of ``{`` and the next documented command died with
   "is not valid JSON: Expecting value: line 1 column 1".
2. The three shipped ``*.manifest.example.json`` templates name files the station supplies, so
   the documented "try it with the template" step failed with a bare ``file not found`` — which
   reads like a broken repo rather than an instruction.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]


def _run(module: str, *args: str) -> subprocess.CompletedProcess:
    """Run one admin CLI in a fresh process with no SECRET_KEY, exactly as an operator would."""
    env = {k: v for k, v in os.environ.items() if k not in {"SECRET_KEY", "ENVIRONMENT", "APP_ENV"}}
    # S603 suppressed: the argv is this test file's own literals plus a tmp_path — the whole
    # point is running the CLI as its own process, because "which stream did it print to" is
    # exactly what an in-process call cannot answer.
    return subprocess.run(  # noqa: S603
        [sys.executable, "-m", module, *args],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


@pytest.mark.parametrize(
    ("module", "command"),
    [
        ("app.admin_config", "example"),
        ("app.admin_config", "schema"),
        ("app.admin_objects", "example"),
        ("app.admin_geodata", "example"),
        ("app.admin_checklists", "example"),
    ],
)
def test_a_pure_stdout_command_emits_nothing_but_json(module: str, command: str):
    """`… > file` has to produce a loadable file. Anything that is not the payload goes to stderr."""
    r = _run(module, command)
    assert r.returncode == 0, r.stderr
    json.loads(r.stdout)  # raises (and fails the test) if a banner got in front of the '{'
    assert "SECRET_KEY" not in r.stdout


def test_the_throwaway_key_notice_lands_on_stderr_and_disowns_the_deployment():
    """It must not read as «we just rotated your SECRET_KEY» — SETUP §7.1 has just warned the
    operator that doing so invalidates every PIN."""
    r = _run("app.admin_config", "example")
    assert "SECRET_KEY" in r.stderr
    assert "throwaway" in r.stderr
    assert "never stored" in r.stderr


@pytest.mark.parametrize(
    ("module", "template"),
    [
        ("app.admin_geodata", "geodata.manifest.example.json"),
        ("app.admin_objects", "objects.manifest.example.json"),
        ("app.admin_checklists", "checklists.manifest.example.json"),
    ],
)
def test_validating_a_shipped_template_says_it_is_a_template(module: str, template: str):
    """It still fails — a template that validated by shipping stub files would be telling the
    operator their data loaded. But it now names itself, and names a manifest that does pass."""
    r = _run(module, "validate", template)
    assert r.returncode != 0
    assert "is a TEMPLATE" in r.stderr, r.stderr
    assert "examples/demo-data/" in r.stderr


def test_a_stations_own_missing_file_gets_the_short_message(tmp_path: Path):
    """The hint is for the shipped templates only — a real manifest's missing export must not
    be told it is an example."""
    manifest = tmp_path / "objects.manifest.json"
    manifest.write_text(
        json.dumps({"objects": [{"key": "wache", "name": "Wache", "plans": [{"module": "modul1", "file": "m1.pdf"}]}]})
    )
    r = _run("app.admin_objects", "validate", str(manifest))
    assert r.returncode != 0
    assert "file not found" in r.stderr
    assert "is a TEMPLATE" not in r.stderr

"""The release version is duplicated across three files – this fails when they drift.

`scripts/release.py` (via `just release X.Y.Z`) bumps all three together; a hand-edit of one
of them would otherwise ship an image whose API reports a different version than the SPA
build stamp shows in the app menu, which is exactly the thing an operator uses to tell two
deployments apart.

Skipped when the repo root isn't present (running inside the production image, where only
backend/ is copied).
"""

import json
import pathlib
import re

import pytest

from app.config import settings

ROOT = pathlib.Path(__file__).resolve().parents[2]
PACKAGE_JSON = ROOT / "package.json"
PYPROJECT = ROOT / "backend" / "pyproject.toml"

pytestmark = pytest.mark.skipif(not PACKAGE_JSON.exists(), reason="repo root not available (running from the image)")


def test_frontend_and_backend_versions_agree():
    frontend = json.loads(PACKAGE_JSON.read_text())["version"]

    m = re.search(r'(?m)^version = "([^"]+)"', PYPROJECT.read_text())
    assert m, "backend/pyproject.toml has no version"
    backend = m.group(1)

    assert frontend == backend == settings.version, (
        f"version drift: package.json={frontend}, pyproject.toml={backend}, "
        f"config.py={settings.version} – bump with `just release X.Y.Z`"
    )


def test_version_is_semver():
    assert re.fullmatch(r"\d+\.\d+\.\d+", settings.version), settings.version


def test_changelog_documents_the_current_version():
    """A released version must have notes; an in-progress bump must not be tagged yet."""
    changelog = (ROOT / "CHANGELOG.md").read_text()
    assert f"## [{settings.version}]" in changelog, f"CHANGELOG.md has no section for {settings.version}"

#!/usr/bin/env python3
"""Bump every place the version lives, and open a CHANGELOG section for it.

    python3 scripts/release.py 0.3.0        # or: just release 0.3.0

Touches six files and NOTHING else – no staging, no commit, no tag (this repo keeps
uncommitted WIP around, so the script never reaches into git). Review the diff, then:

    just release-tag 0.3.0
    git push --follow-tags

The version string is duplicated in package.json, backend/pyproject.toml and
backend/app/config.py because each toolchain wants it in its own file (uv.lock carries a
copy too, refreshed by `uv lock`); the pytest in backend/tests/test_version_consistency.py
fails if the three ever drift apart.

Idempotent: re-running with a version whose CHANGELOG section already exists (the section
was written by hand ahead of the bump) leaves the changelog alone and only bumps the files.
"""

from __future__ import annotations

import datetime
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPO_URL = "https://github.com/feuerwehr-oberwil/kp-front"

PACKAGE_JSON = ROOT / "package.json"
PYPROJECT = ROOT / "backend" / "pyproject.toml"
CONFIG_PY = ROOT / "backend" / "app" / "config.py"
CHANGELOG = ROOT / "CHANGELOG.md"


def fail(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def sub_once(path: pathlib.Path, pattern: str, replacement: str) -> str:
    """Replace the FIRST match of `pattern` in `path`, erroring if it doesn't match exactly once
    where we expect it. A silent no-op here would ship a half-bumped release."""
    text = path.read_text()
    new, count = re.subn(pattern, replacement, text, count=1)
    if count != 1:
        fail(f"{path.relative_to(ROOT)}: no version line matching /{pattern}/")
    if new != text:
        path.write_text(new)
    return text


def current_version() -> str:
    m = re.search(r'"version":\s*"([^"]+)"', PACKAGE_JSON.read_text())
    if not m:
        fail("package.json has no version field")
    return m.group(1)  # type: ignore[union-attr]


def relock() -> None:
    """uv.lock records the project's own version too – re-lock so the next `uv run` doesn't
    quietly rewrite it and leave the release commit trailing a dirty file."""
    if not shutil.which("uv"):
        print("  backend/uv.lock       SKIPPED (uv not on PATH – run `uv lock` in backend/)")
        return
    subprocess.run(["uv", "lock", "--quiet"], cwd=ROOT / "backend", check=True)
    print("  backend/uv.lock       re-locked")


def regenerate_openapi() -> None:
    """The committed contract stamps the version, so a bump drifts it — and
    backend/tests/test_openapi_committed.py would then fail on the release's own CI run,
    after the tag is already pushed. Regenerate here rather than leaving it as a step to
    remember on the one day a year anybody cuts a release."""
    if not shutil.which("uv"):
        print("  docs/openapi.json     SKIPPED (uv not on PATH – run `just openapi` yourself)")
        return
    subprocess.run(
        ["uv", "run", "python", "-m", "app.dump_openapi", "../docs/openapi.json"],
        cwd=ROOT / "backend",
        check=True,
        stdout=subprocess.DEVNULL,
    )
    print("  docs/openapi.json     regenerated")


def bump_changelog(version: str, previous: str) -> None:
    text = CHANGELOG.read_text()

    if f"## [{version}]" in text:
        print(f"  CHANGELOG.md          section [{version}] already written – left as is")
    else:
        if "## [Unreleased]" not in text:
            fail("CHANGELOG.md has no '## [Unreleased]' section")
        body = text.split("## [Unreleased]", 1)[1].split("\n## [", 1)[0].strip()
        if not body:
            fail(
                "CHANGELOG.md '## [Unreleased]' is empty – draft the notes first "
                "(`just changelog`), curate them, then bump"
            )
        today = datetime.date.today().isoformat()
        text = text.replace(
            "## [Unreleased]",
            f"## [Unreleased]\n\n## [{version}] – {today}",
            1,
        )
        print(f"  CHANGELOG.md          [Unreleased] → [{version}]")

    # Compare links at the bottom of the file.
    unreleased_link = f"[Unreleased]: {REPO_URL}/compare/v{version}...HEAD"
    version_link = f"[{version}]: {REPO_URL}/compare/v{previous}...v{version}"
    if f"\n[{version}]: " not in text:
        text = re.sub(
            r"^\[Unreleased\]: .*$",
            f"{unreleased_link}\n{version_link}",
            text,
            count=1,
            flags=re.MULTILINE,
        )
    else:
        text = re.sub(r"^\[Unreleased\]: .*$", unreleased_link, text, count=1, flags=re.MULTILINE)

    CHANGELOG.write_text(text)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: release.py <version>   e.g. release.py 0.3.0")
    version = sys.argv[1].lstrip("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        fail(f"'{version}' is not a MAJOR.MINOR.PATCH version")

    previous = current_version()
    if previous == version:
        print(f"note: version is already {version} – re-running to normalise the other files")

    sub_once(PACKAGE_JSON, r'"version":\s*"[^"]+"', f'"version": "{version}"')
    print(f"  package.json          {previous} → {version}")
    sub_once(PYPROJECT, r'(?m)^version = "[^"]+"', f'version = "{version}"')
    print(f"  backend/pyproject.toml {previous} → {version}")
    sub_once(CONFIG_PY, r'(?m)^(\s*version: str = )"[^"]+"', rf'\g<1>"{version}"')
    print(f"  backend/app/config.py {previous} → {version}")
    relock()
    regenerate_openapi()

    bump_changelog(version, previous)

    print(
        f"\nBumped to {version}. Review the diff, then:\n"
        f"  just release-tag {version}\n"
        f"  git push --follow-tags\n"
        f"\nPushing the tag runs .github/workflows/release.yml: the full CI gate, then the\n"
        f"GHCR image and the GitHub Release (notes taken from the CHANGELOG section)."
    )


if __name__ == "__main__":
    main()

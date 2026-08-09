"""A pinned plan digest is a WRONG-TREE check.

A manifest is published from whichever checkout runs the script, so a stale worktree quietly
republishes whatever PDFs it happens to hold. On 09.08.2026 the public demo went back to
generated placeholders — and to a Modul 6 retired the day before — because a reset ran from a
tree that predated the drawn sheets. Nothing failed. These tests hold the line that made that
silent.
"""

import hashlib
import json
from pathlib import Path

import pytest

from app.admin_objects import _read_manifest, _validate_files

PDF = b"%PDF-1.4\nreal sheet\n"
OTHER = b"%PDF-1.4\ngenerated placeholder\n"


def _manifest(tmp: Path, *, sha: str | None, body: bytes = PDF) -> Path:
    (tmp / "plans").mkdir(parents=True, exist_ok=True)
    (tmp / "plans" / "modul1.pdf").write_bytes(body)
    plan = {"module": "modul1", "file": "plans/modul1.pdf", "title": "Übersicht"}
    if sha is not None:
        plan["sha256"] = sha
    mp = tmp / "objects.manifest.json"
    mp.write_text(
        json.dumps({"objects": [{"id": "d0000000-0000-5000-8000-00000000b077", "name": "Schloss", "plans": [plan]}]})
    )
    return mp


def test_a_pinned_plan_that_matches_passes(tmp_path: Path):
    mp = _manifest(tmp_path, sha=hashlib.sha256(PDF).hexdigest())
    assert _validate_files(mp, _read_manifest(mp)) == 1


def test_the_wrong_pdf_under_a_pinned_module_is_refused(tmp_path: Path):
    """The whole point: same path, same module, different bytes — publishing it would put the
    wrong sheet in front of a crew."""
    mp = _manifest(tmp_path, sha=hashlib.sha256(PDF).hexdigest(), body=OTHER)
    with pytest.raises(SystemExit):
        _validate_files(mp, _read_manifest(mp))


def test_a_plan_with_no_digest_is_still_allowed(tmp_path: Path):
    """Optional on purpose — a library that legitimately changes every week would otherwise be
    re-pinned every week, and a check nobody can keep up with gets deleted."""
    mp = _manifest(tmp_path, sha=None, body=OTHER)
    assert _validate_files(mp, _read_manifest(mp)) == 1


def test_a_digest_that_is_not_a_digest_is_rejected_at_parse_time(tmp_path: Path):
    """Fail on the manifest, not on the bytes: «sha256: TODO» must not read as «unpinned»."""
    mp = _manifest(tmp_path, sha="nope")
    with pytest.raises(SystemExit):
        _read_manifest(mp)


def test_the_shipped_demo_manifest_pins_every_plan(tmp_path: Path):
    """⚠️ The demo is the one library this repo publishes itself, and the one that went stale.
    Its plans stay pinned, and the pins stay true to the PDFs in the tree."""
    mp = Path(__file__).resolve().parents[2] / "examples" / "demo-data" / "objects.manifest.json"
    objects = _read_manifest(mp)
    plans = [p for o in objects for p in o.plans]
    assert plans, "the demo manifest lists no plans"
    assert all(p.sha256 for p in plans), "every demo plan must pin its digest"
    assert _validate_files(mp, objects) == len(plans)

"""The files KP Front and KP Rück share by copy still match `shared/MANIFEST.json`.

Byte-identical in both repositories (it is in the manifest itself). The manifest records the
sha256 of every shared file; this test fails the moment a copy here stops matching it, offline
and without the other repository — an accidental edit, or a deliberate one whose hash was not
re-recorded. What it cannot see is the OTHER repository: edit a file here, run `--update`, and
this stays green while the two copies diverge. CI's «Shared files match KP …» job is what
compares the two checkouts (`scripts/check_shared.py --sibling`). Keep both: this one is fast,
that one is true. How to change a shared file: `shared/README.md`.

The second half exercises the script itself on two throwaway repositories, so the job's
verdicts are tested without the sibling checkout.
"""

import importlib.util
import json
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "check_shared.py"

pytestmark = pytest.mark.skipif(not SCRIPT.exists(), reason="repo root not available (running from the image)")


@pytest.fixture(scope="module")
def check():
    spec = importlib.util.spec_from_file_location("check_shared", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _failures(results) -> list[str]:
    return [f"{'manifest' if item is None else item['id']}: {line}" for item, lines in results for line in lines]


def test_every_shared_file_here_matches_the_manifest(check):
    results, _ = check.run(ROOT, None, None)
    failures = _failures(results)
    assert not failures, (
        "a shared file no longer matches shared/MANIFEST.json:\n  "
        + "\n  ".join(failures)
        + "\nThe file is byte-identical with the other repository. Make the same edit there, run "
        "`python3 scripts/check_shared.py --update` in BOTH, and see shared/README.md. Do NOT just "
        "re-record the hash here."
    )


def test_the_manifest_still_covers_what_matters(check):
    # A guard on the guard: dropping an entry would make a red check go away by no longer
    # asking the question. These are the files whose drift would hurt a station.
    manifest, _ = check.load(ROOT)
    paths = {entry.get("path") for item in manifest["items"] for entry in item["files"]}
    assert {
        "backend/app/telemetry/scrub.py",
        "backend/app/alarm_keywords.py",
        "backend/app/data/alarm_keywords.json",
        "docs/roster-snapshot.schema.json",
        "docs/roster-snapshot-outcome.schema.json",
        "backend/app/roster_snapshot_ingest.py",
        "docs/alarm-intake-conformance.json",
        "scripts/check_shared.py",
    } <= paths


def _pair(tmp_path: Path, check) -> tuple[Path, Path]:
    """Two minimal repositories sharing one file, both in agreement."""
    front, rueck = tmp_path / "front", tmp_path / "rueck"
    manifest = {
        "repos": {
            "kp-front": {"name": "KP Front", "marker": "front.marker"},
            "kp-rueck": {"name": "KP Rück", "marker": "rueck.marker"},
        },
        "items": [
            {
                "id": "vocab",
                "title": "Vocabulary",
                "owner": "kp-front",
                "question": "Same words?",
                "files": [{"kp-front": "data/words.txt", "kp-rueck": "app/words.txt", "sha256": "0" * 64}],
            }
        ],
    }
    for root, marker, rel in ((front, "front.marker", "data/words.txt"), (rueck, "rueck.marker", "app/words.txt")):
        (root / "shared").mkdir(parents=True)
        (root / marker).touch()
        (root / rel).parent.mkdir(parents=True)
        (root / rel).write_text("BRAND\nGASLECK\n", encoding="utf-8")
        (root / check.MANIFEST).write_text(check.canonical(manifest), encoding="utf-8")
    assert check.update(front, None) == 0
    shutil.copy(front / check.MANIFEST, rueck / check.MANIFEST)
    return front, rueck


def test_two_agreeing_repositories_pass(tmp_path, check):
    front, rueck = _pair(tmp_path, check)
    assert _failures(check.run(rueck, None, front)[0]) == []
    assert _failures(check.run(front, None, rueck)[0]) == []


def test_an_edit_on_one_side_fails_in_both_directions_with_a_diff(tmp_path, check):
    front, rueck = _pair(tmp_path, check)
    (rueck / "app/words.txt").write_text("BRAND\nGASLECK\nWASSER\n", encoding="utf-8")
    assert check.update(rueck, None) == 0  # re-recorded on ONE side only: the case the test above cannot see

    from_rueck = _failures(check.run(rueck, None, front)[0])
    assert any("app/words.txt differs from KP Front's data/words.txt" in line for line in from_rueck)
    assert any("+WASSER" in line for line in from_rueck)
    assert any("not byte-identical" in line for line in from_rueck)
    assert _failures(check.run(front, None, rueck)[0]), "the other direction must fail too"


def test_an_edit_without_update_is_caught_offline(tmp_path, check):
    front, _ = _pair(tmp_path, check)
    (front / "data/words.txt").write_text("BRAND\n", encoding="utf-8")
    assert any("still records its old sha256" in line for line in _failures(check.run(front, None, None)[0]))


def test_a_missing_sibling_file_and_a_missing_item_are_reported(tmp_path, check):
    front, rueck = _pair(tmp_path, check)
    (front / "data/words.txt").unlink()
    manifest = json.loads((rueck / check.MANIFEST).read_text(encoding="utf-8"))
    manifest["items"].append({**manifest["items"][0], "id": "extra"})
    (rueck / check.MANIFEST).write_text(check.canonical(manifest), encoding="utf-8")
    failures = _failures(check.run(front, None, rueck)[0])
    assert any("KP Rück shares 'extra'" in line for line in failures)
    assert any("data/words.txt is missing here" in line for line in failures)


def test_the_repository_is_told_apart_by_its_marker(tmp_path, check):
    front, rueck = _pair(tmp_path, check)
    manifest, _ = check.load(front)
    assert check.detect(front, manifest) == "kp-front"
    assert check.detect(rueck, manifest) == "kp-rueck"
    (front / "rueck.marker").touch()
    with pytest.raises(check.ManifestError):
        check.detect(front, manifest)

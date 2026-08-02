"""The shared alarm keyword vocabulary must stay identical to kp-rueck's, and stay wired in.

Both products read the same dispatch system and had independently grown the same two tables —
19 title keywords onto the same categories, 41 priority keywords in the same order — as
literals in their own source. Nothing compared them, so `GASLECK` existed in one and not the
other and no test anywhere could have said so.

There is no shared package and there will not be one: `docs/RUNNING-BOTH.md` promises
self-hosters separate databases, separate images, separate releases, no shared library and no
runtime coupling. So the copies stay copies and this test compares them — the same trick as
`test_telemetry_vendored.py` and the committed `openapi.json`.

**What this test catches.**

* An edit to either vendored file on this side (the checksums).
* The vocabulary being *un*wired — someone pasting the literal back into `divera.py` while the
  JSON sits there unread. That is the failure mode a checksum alone cannot see, and it is the
  one that turns a checked-in file into decoration.
* kp-rueck adding a category to the shared file that kp-front has no German label for. The app
  itself degrades rather than refusing to boot (`divera.category_label`), so this test is the
  only thing that makes that gap loud — without it the new category silently files under
  «Diverse Einsätze» forever.
* A deployment-config vocabulary changing what a station with NO override classifies. The
  shipped file is the default and must keep behaving exactly as it did.

**What it does NOT catch.** It never reads kp-rueck. Edit one repository, update that
repository's own checksum, and both suites stay green while the vocabularies diverge — which
is exactly the drift this file exists to prevent. Only the cross-repo diff job in kp-rueck's
`.github/workflows/ci.yml` actually compares the two checkouts. Keep both: this one is fast
and offline, that one is true.

It also says nothing about *matching*. The two products' matchers genuinely differ (kp-rueck
requires letter boundaries for GAS/VU/LIFT), that difference is recorded as data in the JSON,
and no test here asserts the two classify a given alarm the same way. They may not.

**Nor does it pin a deployment's own vocabulary.** `alarmKeywords` in the deployment config is
per-station data, not a shared contract: it is never checksummed and never compared against
kp-rueck. Only the shipped file is.

**When this fails**, the fix is never to update a hash on its own. Copy the file across, run
both suites, and update the hash in both repositories in the same change.
"""

import hashlib
import json
from pathlib import Path

import pytest

from app import alarm_keywords, divera

APP = Path(alarm_keywords.__file__).resolve().parent

# sha256 of each vendored file, as it exists in feuerwehr-oberwil/kp-front.
# Regenerate with:  shasum -a 256 backend/app/alarm_keywords.py backend/app/data/alarm_keywords.json
VENDORED = {
    "alarm_keywords.py": "0cf503ae3d98d07cc4645890b41d77e93c746e4302282364c50917cb63834cdd",
    "data/alarm_keywords.json": "7cef662c7eb41e54bab668828bad05975339f5d4de8691b1b6ca6ef0bee102de",
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("name", sorted(VENDORED))
def test_vendored_file_matches_the_recorded_hash(name: str):
    path = APP / name
    assert path.exists(), f"{name} is missing — the vendored copy must not be deleted"
    assert _sha256(path) == VENDORED[name], (
        f"app/{name} no longer matches the hash recorded here.\n"
        f"Copy the file across, run BOTH test suites, and update the hash in BOTH repositories "
        f"in the same change. Do NOT just update the hash — see this module's docstring."
    )


def test_both_halves_are_pinned():
    # A guard on the guard: pinning the JSON but not the loader (or the reverse) would leave
    # half of the shared contract free to move.
    assert set(VENDORED) == {"alarm_keywords.py", "data/alarm_keywords.json"}


@pytest.fixture
def raw() -> dict:
    return json.loads((APP / "data" / "alarm_keywords.json").read_text(encoding="utf-8"))


def test_schema_version_is_the_one_this_code_understands(raw):
    # Bumping the shape on one side only is the failure this catches.
    assert raw["schema_version"] == 1
    assert raw["schema"] == "alarm-keywords/1"
    assert alarm_keywords.SCHEMA_VERSION == 1


def test_classification_is_derived_from_the_file_not_retyped(raw):
    """Every shipped keyword must classify as the file says — not as a literal agrees today."""
    for keyword, category in raw["keyword_to_category"]["pairs"]:
        assert divera.detect_type(keyword, vocab=alarm_keywords.SHIPPED) == divera.category_label(category), (
            f"«{keyword}» no longer classifies as data/alarm_keywords.json says. If someone "
            f"re-inlined the map, put it back behind the loaded vocabulary — a checked-in file "
            f"nothing reads is worse than no file."
        )


def test_priority_keywords_are_derived_from_the_file_not_retyped(raw):
    expected = [kw for group in raw["high_priority_keywords"]["groups"] for kw in group["keywords"]]
    assert list(alarm_keywords.HIGH_PRIORITY_KEYWORDS) == expected


def test_every_category_in_the_shared_file_has_a_german_label():
    """The cross-product guard: kp-rueck may add a category, and this side must survive it.

    Without this, a category added on the other side arrives as a KeyError raised at import
    time — on the alarm intake path, in production, at whatever hour the alarm comes in.
    """
    missing = sorted(alarm_keywords.CATEGORY_KEYS - set(divera.CATEGORY_LABELS))
    assert not missing, (
        f"data/alarm_keywords.json routes to categories kp-front has no label for: {missing}. "
        f"Add them to divera.CATEGORY_LABELS in the same change that vendors the file."
    )


def test_the_fallback_is_reachable_and_labelled():
    assert alarm_keywords.FALLBACK_CATEGORY in divera.CATEGORY_LABELS
    assert (
        divera.detect_type("etwas das keinem Stichwort entspricht", vocab=alarm_keywords.SHIPPED) == "Diverse Einsätze"
    )


def test_keywords_are_uppercase_and_unique():
    # The matchers uppercase the title before comparing, so a lowercase entry here would be
    # dead data that silently never fires. `parse()` enforces it at import; this states it.
    keywords = [kw for kw, _ in alarm_keywords.KEYWORD_TO_CATEGORY]
    assert keywords == [kw.upper() for kw in keywords]
    assert len(keywords) == len(set(keywords)), "a duplicate keyword makes the later entry unreachable"
    assert all(alarm_keywords.HIGH_PRIORITY_KEYWORDS), "an empty keyword matches everything"
    assert list(alarm_keywords.HIGH_PRIORITY_KEYWORDS) == [kw.upper() for kw in alarm_keywords.HIGH_PRIORITY_KEYWORDS]


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("Brand Wohnhaus", "Brandbekämpfung"),
        ("FEUER3", "Brandbekämpfung"),
        ("VU Strasse", "Strassenrettung"),
        ("BMA Schulhaus", "BMA / unechte Alarme"),
        ("Ölspur Hauptstrasse", "Ölwehr"),
        ("Tierrettung Katze", "Gerettete Tiere"),
        ("Katzenwäsche", "Diverse Einsätze"),
    ],
)
def test_classification_end_to_end(title: str, expected: str):
    # Proves the file is loaded and matched, not merely present.
    assert divera.detect_type(title, vocab=alarm_keywords.SHIPPED) == expected


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("Wohnungsbrand", "HIGH"),
        ("Person in Lift", "HIGH"),
        ("Gasleck Industriestrasse", "HIGH"),
        ("Wasser im Keller", "LOW"),
    ],
)
def test_priority_end_to_end(title: str, expected: str):
    assert divera.infer_priority(title, vocab=alarm_keywords.SHIPPED) == expected

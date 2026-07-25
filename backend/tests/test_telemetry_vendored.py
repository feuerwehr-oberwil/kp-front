"""The vendored telemetry modules must stay identical to kp-front's.

There is no shared package: a third repository with its own release cycle is a lot of
machinery for one maintainer and ~600 lines, and it would put a publish step in front of
every fix. The trade is that two copies can silently drift, and the one place drift is
genuinely dangerous is the sanitiser — a rule tightened in one app and not the other would
mean one of them quietly leaks what the other strips.

So the copies carry a checksum of themselves, and this test fails when it stops matching.
Same trick as the openapi.json drift test: cheap, obvious, and it fires at the moment the
change is made rather than months later.

**When this fails**, the fix is never to update the hash on its own. Copy the changed file
across, run both suites, then update the hash in both repositories in the same change.

The list is deliberately short. ``consent.py`` is NOT here — it has to talk to whatever table
a given app keeps deployment state in, and those legitimately differ. ``dsn.py`` is not here
either: it holds the app's own ingest project. Everything that decides what a payload
*contains* is here, and that is the part that must never diverge.
"""

import hashlib
from pathlib import Path

import pytest

TELEMETRY = Path(__file__).resolve().parent.parent / "app" / "telemetry"

# sha256 of each vendored file, as it exists in feuerwehr-oberwil/kp-front.
# Regenerate with:  shasum -a 256 backend/app/telemetry/{scrub,envelope,outbox,forwarder}.py
VENDORED = {
    "scrub.py": "f493aa6306e6d90ce527ee49d5279d84c9c3ffb5c1ec51f202d1bfe451269912",
    "envelope.py": "fa581ba2ec4224426ce67750c4e575c6d44a12a5cc63a81498da2e245430995f",
    "outbox.py": "e59113482ba07ff52fcbe4f8cc318d1b3143993e88367298fbccc503facc428a",
    "forwarder.py": "7256d10b5c25c4b9056836b6c53862ece0b2836e41e1684738fa91daf0cfee13",
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("name", sorted(VENDORED))
def test_vendored_file_matches_kp_front(name: str):
    path = TELEMETRY / name
    assert path.exists(), f"{name} is missing — the vendored copy must not be deleted"
    assert _sha256(path) == VENDORED[name], (
        f"app/telemetry/{name} has diverged from the kp-front copy.\n"
        f"Copy the file across, run both test suites, and update the hash in BOTH repositories "
        f"in the same change. Do NOT just update the hash — see this module's docstring."
    )


def test_the_sanitiser_is_the_one_that_matters():
    # A guard on the guard: if someone shortens VENDORED to make a failure go away, this
    # notices that the file which actually decides what leaves the building stopped being
    # checked at all.
    assert "scrub.py" in VENDORED

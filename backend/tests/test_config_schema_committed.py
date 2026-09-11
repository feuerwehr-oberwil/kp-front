"""`docs/config.schema.json` is the committed config-as-code contract – this fails when it drifts.

The config document's JSON Schema was reachable only by running `admin_config schema` on a
machine with the backend installed, which is precisely what the two callers that need it most do
not have: an agent authoring a station's config, and a self-hoster with nothing but Docker.
Committing it makes the contract readable in the repo – and a committed file that nobody
regenerates is worse than none, hence this test. Regenerate with `just config-schema` (or
`just openapi`, which runs it) and commit the result in the same change that touches
`DeploymentConfigIn`.

Skipped when the repo root isn't present (running inside the production image, where only
backend/ is copied).
"""

import json
import pathlib

import pytest

from app.schemas import DeploymentConfigIn

ROOT = pathlib.Path(__file__).resolve().parents[2]
COMMITTED = ROOT / "docs" / "config.schema.json"

pytestmark = pytest.mark.skipif(not COMMITTED.exists(), reason="repo root not available (running from the image)")


def test_committed_config_schema_matches_the_model():
    live = DeploymentConfigIn.model_json_schema()
    committed = json.loads(COMMITTED.read_text(encoding="utf-8"))

    live_sections = set(live.get("properties", {}))
    committed_sections = set(committed.get("properties", {}))
    missing = sorted(live_sections - committed_sections)
    stale = sorted(committed_sections - live_sections)
    assert not missing and not stale, (
        f"docs/config.schema.json is out of date – missing: {missing}, no longer accepted: {stale}. "
        f"Regenerate with `just config-schema` and commit it."
    )

    assert committed == live, (
        "docs/config.schema.json has the right sections but differs in detail (a field, a rule, a "
        "default) – regenerate with `just config-schema` and commit it."
    )

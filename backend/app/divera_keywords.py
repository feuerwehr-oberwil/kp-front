"""Loader for the shared Divera keyword vocabulary — see ``data/divera_keywords.json``.

This module is deliberately dependency-free and pure — no DB, no HTTP, no app imports — so it
can be vendored into kp-rueck byte-for-byte and tested without a stack. That is the same
property, for the same reason, as ``app/telemetry/scrub.py``; ``tests/test_divera_keywords.py``
keeps the copies identical.

It exposes the vocabulary and nothing else. The matcher stays in each app, because the two
matchers are not the same and the JSON says why. Consumers here:

* kp-front  — ``app/divera.py`` builds ``TYPE_LABELS`` by joining these keys onto its own
  German labels, and reads ``HIGH_PRIORITY_KEYWORDS`` directly.
* kp-rueck  — ``app/services/divera_intake.py`` builds ``INCIDENT_TYPE_MAPPING`` by resolving
  these keys to its ``IncidentType`` enum, and reads ``HIGH_PRIORITY_KEYWORDS`` directly.

Read at import, once. The file ships inside the package (not in a repo-root ``data/``, which
kp-front's ``.dockerignore`` excludes) so it is present in both production images; a missing
file is an ImportError at boot rather than a silently empty map, which is the correct failure
for something the alarm intake depends on.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

DATA_PATH = Path(__file__).resolve().parent / "data" / "divera_keywords.json"

_RAW: dict[str, Any] = json.loads(DATA_PATH.read_text(encoding="utf-8"))

#: Bumped only when the *shape* changes. Both apps assert it, so a shape change cannot land
#: on one side alone.
SCHEMA_VERSION: int = _RAW["schema_version"]

#: (keyword, category key) in match order — first hit in an uppercased title wins.
KEYWORD_TO_CATEGORY: tuple[tuple[str, str], ...] = tuple(
    (keyword, category) for keyword, category in _RAW["keyword_to_category"]["pairs"]
)

#: Category key used when no keyword matches.
FALLBACK_CATEGORY: str = _RAW["fallback_category"]

#: Every category key the vocabulary can produce, fallback included.
CATEGORY_KEYS: frozenset[str] = frozenset([c for _, c in KEYWORD_TO_CATEGORY] + [FALLBACK_CATEGORY])

#: Flattened, in file order. Grouping in the JSON is documentation, not semantics — priority
#: inference is an any-match, so order carries no meaning here.
HIGH_PRIORITY_KEYWORDS: tuple[str, ...] = tuple(
    keyword for group in _RAW["high_priority_keywords"]["groups"] for keyword in group["keywords"]
)

#: The keywords kp-rueck matches with letter boundaries and kp-front matches as substrings.
#: Exposed so the divergence is inspectable rather than folklore; neither app is required to
#: act on it. See the JSON's ``known_matcher_divergence`` note.
KP_RUECK_WORD_BOUNDED: frozenset[str] = frozenset(_RAW["known_matcher_divergence"]["kp_rueck_word_bounded"])

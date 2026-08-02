"""Loader for the shared alarm keyword vocabulary — see ``data/alarm_keywords.json``.

This module is deliberately dependency-free and pure — no DB, no HTTP, no app imports — so it
can be vendored into kp-rueck byte-for-byte and tested without a stack. That is the same
property, for the same reason, as ``app/telemetry/scrub.py``; ``tests/test_alarm_keywords.py``
keeps the copies identical.

It exposes the vocabulary and the rule for what counts as one, and nothing else. The matcher
stays in each app, because the two matchers are not the same and the JSON says why. Consumers:

* kp-front  — ``app/divera.py`` matches against the *effective* vocabulary (the deployment's
  own if it set one, else the shipped default) and joins the category keys onto its own German
  labels.
* kp-rueck  — ``app/services/divera_intake.py`` builds ``INCIDENT_TYPE_MAPPING`` by resolving
  these keys to its ``IncidentType`` enum, and reads ``HIGH_PRIORITY_KEYWORDS`` directly.

The shipped file is read at import, once. It ships inside the package (not in a repo-root
``data/``, which kp-front's ``.dockerignore`` excludes) so it is present in both production
images; a missing or malformed file is an ImportError at boot rather than a silently empty map,
which is the correct failure for something the alarm intake depends on.

A DEPLOYMENT'S OWN vocabulary cannot be read here: it lives in the database, and this module
must stay pure and importable before anything is connected. So the file is the *default* and
the app resolves the effective vocabulary at call time — ``parse()`` is exported precisely so
that both paths are accepted by one rule rather than two. See ``divera.active_vocabulary()``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DATA_PATH = Path(__file__).resolve().parent / "data" / "alarm_keywords.json"

#: Bumped only when the *shape* changes. Both apps assert it, so a shape change cannot land on
#: one side alone — and a deployment's own vocabulary states which shape it was written against.
SUPPORTED_SCHEMA_VERSION = 1


class InvalidVocabularyError(ValueError):
    """A vocabulary document that cannot be trusted to classify alarms.

    Raised with a precise ``path: what is wrong`` message. Never swallowed on the way in: a
    vocabulary that is quietly ignored classifies alarms wrongly and says nothing, which is the
    one failure mode this whole mechanism exists to avoid.
    """


@dataclass(frozen=True)
class Vocabulary:
    """One immutable alarm vocabulary — the shipped default or a deployment's own."""

    schema_version: int
    #: (keyword, category key) in match order — first hit in an uppercased title wins.
    keyword_to_category: tuple[tuple[str, str], ...]
    #: Category key used when no keyword matches.
    fallback_category: str
    #: Flattened, in file order. Grouping in the JSON is documentation, not semantics — priority
    #: inference is an any-match, so order carries no meaning here.
    high_priority_keywords: tuple[str, ...]
    #: The keywords kp-rueck matches with letter boundaries and kp-front matches as substrings.
    #: Inspectable rather than folklore; neither app is required to act on it. See the JSON's
    #: ``known_matcher_divergence`` note.
    kp_rueck_word_bounded: frozenset[str]

    @property
    def category_keys(self) -> frozenset[str]:
        """Every category key this vocabulary can produce, fallback included."""
        return frozenset([c for _, c in self.keyword_to_category] + [self.fallback_category])


def _mapping(raw: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(raw, Mapping):
        raise InvalidVocabularyError(f"{path}: expected an object, got {type(raw).__name__}")
    return raw


def _sequence(raw: Any, path: str) -> Sequence[Any]:
    if isinstance(raw, str) or not isinstance(raw, Sequence):
        raise InvalidVocabularyError(f"{path}: expected a list, got {type(raw).__name__}")
    return raw


def _keyword(raw: Any, path: str) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise InvalidVocabularyError(f"{path}: expected a non-empty string")
    # The matchers uppercase the title before comparing, so a lowercase entry would be dead
    # data that silently never fires — the exact kind of quiet wrongness this rejects.
    if raw != raw.upper():
        raise InvalidVocabularyError(f"{path}: keywords must be UPPERCASE (matching uppercases the title); got {raw!r}")
    return raw


def parse(raw: Mapping[str, Any]) -> Vocabulary:
    """Validate a vocabulary document → ``Vocabulary``, or raise ``InvalidVocabularyError``.

    The single acceptance rule, applied to the shipped file at import AND to a deployment's own
    vocabulary before it is stored. One rule, so «valid» cannot mean two things.

    Structural keys only: ``_readme`` and ``schema`` are documentation and are ignored here, so
    a station can copy the shipped file, edit the words and keep the prose.
    """
    doc = _mapping(raw, "(root)")

    version = doc.get("schema_version")
    if version != SUPPORTED_SCHEMA_VERSION:
        raise InvalidVocabularyError(
            f"schema_version: this build understands {SUPPORTED_SCHEMA_VERSION}, the document says {version!r}"
        )

    pairs_raw = _sequence(
        _mapping(doc.get("keyword_to_category"), "keyword_to_category").get("pairs"), "keyword_to_category.pairs"
    )
    if not pairs_raw:
        raise InvalidVocabularyError("keyword_to_category.pairs: at least one keyword is required")
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for i, entry in enumerate(pairs_raw):
        at = f"keyword_to_category.pairs[{i}]"
        items = _sequence(entry, at)
        if len(items) != 2:
            raise InvalidVocabularyError(f"{at}: expected [keyword, category], got {len(items)} item(s)")
        keyword = _keyword(items[0], f"{at}[0]")
        category = items[1]
        if not isinstance(category, str) or not category.strip():
            raise InvalidVocabularyError(f"{at}[1]: expected a non-empty category key")
        if keyword in seen:
            raise InvalidVocabularyError(f"{at}[0]: duplicate keyword {keyword!r} — the later entry is unreachable")
        seen.add(keyword)
        pairs.append((keyword, category))

    fallback = doc.get("fallback_category")
    if not isinstance(fallback, str) or not fallback.strip():
        raise InvalidVocabularyError("fallback_category: expected a non-empty category key")

    groups = _sequence(
        _mapping(doc.get("high_priority_keywords") or {}, "high_priority_keywords").get("groups") or [],
        "high_priority_keywords.groups",
    )
    high: list[str] = []
    for i, group in enumerate(groups):
        at = f"high_priority_keywords.groups[{i}]"
        keywords = _sequence(_mapping(group, at).get("keywords") or [], f"{at}.keywords")
        high.extend(_keyword(kw, f"{at}.keywords[{j}]") for j, kw in enumerate(keywords))

    bounded = _sequence(
        _mapping(doc.get("known_matcher_divergence") or {}, "known_matcher_divergence").get("kp_rueck_word_bounded")
        or [],
        "known_matcher_divergence.kp_rueck_word_bounded",
    )
    for i, kw in enumerate(bounded):
        _keyword(kw, f"known_matcher_divergence.kp_rueck_word_bounded[{i}]")

    return Vocabulary(
        schema_version=SUPPORTED_SCHEMA_VERSION,
        keyword_to_category=tuple(pairs),
        fallback_category=fallback,
        high_priority_keywords=tuple(high),
        kp_rueck_word_bounded=frozenset(str(kw) for kw in bounded),
    )


#: The vocabulary this build ships with — the default for every deployment that sets none.
SHIPPED: Vocabulary = parse(json.loads(DATA_PATH.read_text(encoding="utf-8")))

#: Flat aliases for the shipped vocabulary. kp-rueck reads these directly; kp-front resolves
#: the effective vocabulary per deployment and uses these only as its default.
SCHEMA_VERSION: int = SHIPPED.schema_version
KEYWORD_TO_CATEGORY: tuple[tuple[str, str], ...] = SHIPPED.keyword_to_category
FALLBACK_CATEGORY: str = SHIPPED.fallback_category
CATEGORY_KEYS: frozenset[str] = SHIPPED.category_keys
HIGH_PRIORITY_KEYWORDS: tuple[str, ...] = SHIPPED.high_priority_keywords
KP_RUECK_WORD_BOUNDED: frozenset[str] = SHIPPED.kp_rueck_word_bounded

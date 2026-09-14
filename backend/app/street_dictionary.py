"""Typo-tolerant street correction for the intake autocomplete.

swisstopo's SearchServer is prefix/token based: «haupstrasse 12» (missing t) finds nothing
although «hauptstrasse 12» would. So `geocode.search` keeps a dictionary of the region's
official street names and, when a query comes back empty, swaps a street token that is one
edit away from exactly one known street and asks again.

The dictionary is the official Strassenverzeichnis (`ch.swisstopo.amtliches-strassenverzeichnis`)
read through the geo.admin identify service with the deployment's geocoder bbox as an envelope
– the same `map.geocoder.bboxLv95` the search already biases on. Pages of 200 (the service's
cap), refreshed in the background on first use and then at most weekly; a failed refresh keeps
the previous list. No bbox ⇒ no dictionary ⇒ the search behaves exactly as before.
"""

import asyncio
import logging
import re
import time
import unicodedata

import httpx

logger = logging.getLogger(__name__)

_STREET_LAYER = "ch.swisstopo.amtliches-strassenverzeichnis"
_PAGE = 200  # identify's hard maximum per request
_MAX_PAGES = 100  # 20'000 streets – far beyond any single brigade's region
_REFRESH_AFTER = 7 * 24 * 3600.0
_RETRY_AFTER_FAILURE = 10 * 60.0
_MIN_TOKEN = 4  # shorter street tokens are too ambiguous to correct

# The house number is the first token that starts with a digit; the street is everything
# before it. Anything after a comma is the operator's own locality part.
_HOUSE_NUMBER = re.compile(r"\s+\d")
_FOLD = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})


def fold(s: str) -> str:
    """Case- and umlaut-insensitive key, like the frontend: ä→ae, ß→ss, other diacritics dropped."""
    lowered = s.strip().lower().translate(_FOLD)
    stripped = "".join(c for c in unicodedata.normalize("NFKD", lowered) if not unicodedata.combining(c))
    return " ".join(stripped.split())


def within_one_edit(a: str, b: str) -> bool:
    """Damerau-Levenshtein distance ≤ 1 (one substitution, insertion, deletion or adjacent swap)."""
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    i = 0
    while i < min(la, lb) and a[i] == b[i]:
        i += 1
    if la == lb:  # one substitution at i, or the adjacent pair at i swapped
        if a[i + 1 :] == b[i + 1 :]:
            return True
        return i + 1 < la and a[i] == b[i + 1] and a[i + 1] == b[i] and a[i + 2 :] == b[i + 2 :]
    short, long = (a, b) if la < lb else (b, a)  # one insertion/deletion at i
    return short[i:] == long[i + 1 :]


def split_street(query: str) -> tuple[str, str]:
    """(street part, remainder) of a typed query: «haupstrasse 12, 4104» → («haupstrasse», « 12, 4104»)."""
    head = query.split(",", 1)[0]
    m = _HOUSE_NUMBER.search(head)
    cut = m.start() if m else len(head)
    return query[:cut], query[cut:]


def correct_street(street: str, streets: dict[str, str]) -> str | None:
    """The one official street within a single edit of `street`, or None.

    `streets` maps folded name → official spelling. None when the token is too short, already
    a known street (the miss was not a typo), or when more than one street is equally close.
    """
    key = fold(street)
    if len(key) < _MIN_TOKEN or key in streets:
        return None
    candidates = [official for folded, official in streets.items() if within_one_edit(key, folded)]
    return candidates[0] if len(candidates) == 1 else None


def correct_query(query: str, streets: dict[str, str]) -> str | None:
    """The query with its street token corrected, or None when there is nothing to correct."""
    street, rest = split_street(query)
    fixed = correct_street(street, streets)
    return f"{fixed}{rest}" if fixed else None


class StreetDictionary:
    """In-process cache of the region's street names, refreshed in the background.

    `get(bbox)` never waits: it returns the current list (possibly stale, possibly None on
    first use) and schedules a refresh when the list is missing, older than a week, or was
    built for another bbox. One refresh runs at a time; a failure keeps the old list and backs
    off before trying again.
    """

    def __init__(self, identify_url: str) -> None:
        self._identify_url = identify_url
        self._streets: dict[str, str] | None = None
        self._bbox = ""
        self._fetched_at = 0.0
        self._next_attempt = 0.0
        self._task: asyncio.Task[None] | None = None

    def get(self, bbox: str) -> dict[str, str] | None:
        if not bbox:
            return None
        now = time.monotonic()
        current = self._streets if self._bbox == bbox else None
        stale = current is None or now - self._fetched_at > _REFRESH_AFTER
        if stale and now >= self._next_attempt and (self._task is None or self._task.done()):
            self._task = asyncio.create_task(self._refresh(bbox))
        return current

    async def _refresh(self, bbox: str) -> None:
        self._next_attempt = time.monotonic() + _RETRY_AFTER_FAILURE
        try:
            streets = await fetch_streets(self._identify_url, bbox)
        except (httpx.HTTPError, ValueError) as e:
            logger.warning("Street dictionary refresh failed; keeping the previous list: %s", e)
            return
        self._streets, self._bbox, self._fetched_at = streets, bbox, time.monotonic()
        logger.info("Street dictionary refreshed: %d streets in bbox %s", len(streets), bbox)


async def fetch_streets(identify_url: str, bbox: str) -> dict[str, str]:
    """Every official street name inside the LV95 bbox, keyed by its folded form.

    Pages through the identify service (200 per page); raises httpx/ValueError on failure so
    the caller can keep its previous list.
    """
    base = {
        "geometry": bbox,
        "geometryType": "esriGeometryEnvelope",
        "sr": "2056",
        "tolerance": "0",
        "layers": f"all:{_STREET_LAYER}",
        "returnGeometry": "false",
        "lang": "de",
        "limit": str(_PAGE),
    }
    streets: dict[str, str] = {}
    async with httpx.AsyncClient(timeout=10.0) as client:
        for page in range(_MAX_PAGES):
            r = await client.get(identify_url, params={**base, "offset": str(page * _PAGE)})
            r.raise_for_status()
            results = r.json().get("results", [])
            for feat in results:
                name = str((feat.get("attributes") or {}).get("stn_label") or "").strip()
                if name:
                    streets.setdefault(fold(name), name)
            if len(results) < _PAGE:
                break
    return streets

"""Divera Rückmeldungen — who answered the alarm «komme» / «komme nicht», read-only.

The answers are already IN the response the fallback poll fetches (``GET /api/v2/alarms``,
``app.divera.fetch_and_upsert``): each alarm carries

    ucr_addressed      [ucr, …]                                  (Divera's own spec spells it ucr_adressed)
    ucr_answered       {"<status id>": {"<ucr>": {"ts": …, "note": "…"}}}
    ucr_answeredcount  {"<status id>": n}
    ucr_read           [ucr, …]

The Swagger schema calls ``ucr_answered`` an ``int[]``; every client that actually reads it agrees
on the dict above, and an alarm with no answers yet sends ``[]`` — so anything that is not a dict
reads as «no answers», never as an error. Nothing here makes a NEW Divera call for the answers.

What a status MEANS is per Einheit: each one configures its own Rückmelde-Status («Komme»,
«Komme in 10 min», «Komme nicht», …), and an answer is filed under the id the member pressed. The
names (and ``time``, the minutes «Komme in N min» promises) come from ``/pull/all`` →
``cluster.status``, which the Mannschaft sync fetches anyway; it is cached here and fetched on its
own at most every :data:`CATALOGUE_TTL_SECONDS`, and only once an alarm has answers to name.

:func:`classify` turns a status into ``coming`` / ``not_coming`` / ``other``: the station's
``roster.diveraResponses`` override (by id or by name) first, then a default read off the NAME —
«nicht» first, because «Komme nicht» also contains «komme». docs/divera-connector.md §
«Rückmeldungen» is the operator's description, and kp-rueck implements the same rules.

⚠️ A Divera answer is never presence. The Anwesenheit shows who SAID they are coming; somebody is
present only when a person on the scene taps them in. Nothing in this module writes to an
incident's workspace.

YES / NO, AND NOTHING ELSE (owner, 09.10.2026: «just yes/no is enough»). What is kept per alarm is
which of OUR people said «kommt» and which «kommt nicht», plus how many answers came from somebody
not on the Mannschaftsliste — no status, no answer time, no note, no ETA, no «andere». The UCR id
under ``ucr_answered`` is the key of ``cluster.consumer``, i.e. the ``divera`` external identity
the Mannschaft sync stores; it is mapped onto our personnel id when the poll stores the answer and
never kept itself.
"""

from __future__ import annotations

import logging
import re
import time
import unicodedata
from typing import Any, Literal

logger = logging.getLogger(__name__)

Kind = Literal["coming", "not_coming", "other"]
KINDS: tuple[Kind, ...] = ("coming", "not_coming", "other")

#: How long a fetched status catalogue is reused. A Rückmelde-Status is renamed perhaps once a
#: year; asking Divera every poll would be the polling storm the connector promises not to be.
CATALOGUE_TTL_SECONDS = 6 * 3600
#: …and how long a FAILED catalogue fetch — or a refetch for a status id the catalogue does not
#: know yet — waits before it is tried again (a key that cannot read /pull/all must not turn every
#: poll into a second, failing call).
CATALOGUE_RETRY_SECONDS = 15 * 60
#: The catalogue fetch runs inside the alarm poll; it gets its own short bound so a slow Divera
#: cannot hold the alarm intake behind a list of status names.
CATALOGUE_TIMEOUT_SECONDS = 5.0


#: How long an alarm's answers count for «Anrückend». After a few hours they describe a dispatch
#: that is over — somebody who said «komme» at 19:00 and never came is not «anrückend» at 02:00,
#: and a Nachalarm the next day must not inherit the first night's answers.
RESPONSES_MAX_AGE_SECONDS = 6 * 3600
#: How long they are KEPT at all. «Who said they would come» is about one dispatch; nothing after
#: the Einsatz reads it (it never reaches the workspace, an export or the Rapport), so it is
#: cleared once the Einsatz is closed, and in any case this long after the alarm (PRIVACY.md).
RESPONSES_RETENTION_SECONDS = 48 * 3600


# --- the default classification ---------------------------------------------------------

#: Checked FIRST: «Komme nicht» contains «komme». Word-bounded where a bare substring would
#: misfire («no» in «Notfall», «pas» in «Passerelle»).
_NOT_COMING = re.compile(
    r"\b(nicht|not|no|nein|kein\w*|pas|non)\b|abwesend|verhindert|absent|indisponible|unavailable|ferien|urlaub|krank|"
    r"assente|non disponibile"
)
_COMING = re.compile(
    r"komm|unterwegs|anfahrt|auf dem weg|einsatzbereit|verfugbar|\bja\b|coming|on my way|\byes\b|viens|"
    r"j'arrive|arrive|en route|disponible|vengo|arrivo|in arrivo|sto arrivando|\d+\s*min"
)


def fold(text: str) -> str:
    """Lower-case, diacritics off, whitespace collapsed — «Rückruf» and «ruckruf» are one name."""
    t = unicodedata.normalize("NFD", text or "")
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return " ".join(t.lower().split())


def default_kind(name: str, minutes: int = 0) -> Kind:
    """What a status most likely means, read off its name (and its promised minutes)."""
    n = fold(name)
    if n and _NOT_COMING.search(n):
        return "not_coming"
    if n and _COMING.search(n):
        return "coming"
    return "coming" if minutes > 0 else "other"


def normalise_overrides(raw: Any) -> tuple[dict[str, Kind], dict[str, Kind]]:
    """``roster.diveraResponses`` as (by id, by folded name). Unknown values are dropped."""
    by_id: dict[str, Kind] = {}
    by_name: dict[str, Kind] = {}
    if not isinstance(raw, dict):
        return by_id, by_name
    for key, value in raw.items():
        if value not in KINDS:
            continue
        k = str(key).strip()
        if k.isdigit():
            by_id[k] = value
        elif k:
            by_name[fold(k)] = value
    return by_id, by_name


def classify(status_id: str, status: dict | None, overrides: tuple[dict[str, Kind], dict[str, Kind]]) -> Kind:
    """coming / not_coming / other for one status: override by id, by name, then the default."""
    by_id, by_name = overrides
    if status_id in by_id:
        return by_id[status_id]
    name = (status or {}).get("name") or ""
    folded = fold(name)
    if folded and folded in by_name:
        return by_name[folded]
    if not status:
        return "other"
    return default_kind(name, _minutes(status))


def _minutes(status: dict | None) -> int:
    try:
        return max(0, int((status or {}).get("time") or 0))
    except (TypeError, ValueError):
        return 0


# --- parsing the alarm ------------------------------------------------------------------


def _int_list(value: Any) -> list[int]:
    out: list[int] = []
    if not isinstance(value, list):
        return out
    for v in value:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            continue
    return out


def _ts(value: Any) -> int | None:
    try:
        ts = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    # a stamp no calendar can render (Divera junk, a ms value) is no stamp
    return ts if 0 < ts < 32503680000 else None


def parse_alarm_answers(item: dict) -> dict[str, str]:
    """One Divera alarm's answers as {ucr: status id} — the LATEST answer per person if Divera ever
    files one under two statuses. Only what the classification needs; the time is used to pick
    the latest and then dropped, the note is never read."""
    best: dict[str, tuple[str, int]] = {}
    raw = item.get("ucr_answered") if isinstance(item, dict) else None
    if not isinstance(raw, dict):
        return {}
    for sid, people in raw.items():
        sid_s = str(sid).strip()
        if not sid_s.isdigit() or not isinstance(people, dict):
            continue
        for ucr, answer in people.items():
            ucr_s = str(ucr).strip()
            if not ucr_s.isdigit():
                continue
            ts = _ts((answer if isinstance(answer, dict) else {}).get("ts")) or 0
            if ucr_s not in best or ts >= best[ucr_s][1]:
                best[ucr_s] = (sid_s, ts)
    return {ucr: sid for ucr, (sid, _ts_) in best.items()}


def parse_responses_by_alarm(data: dict) -> dict[int, dict[str, str]]:
    """Divera ``/alarms`` → {divera alarm id: {ucr: status id}} for every alarm with answers.
    Closed alarms included: an answer given before the alarm was closed is still an answer."""
    out: dict[int, dict[str, str]] = {}
    if not isinstance(data, dict) or not data.get("success"):
        return out
    items = (data.get("data") or {}).get("items") or {}
    if isinstance(items, dict):
        items = list(items.values())
    if not isinstance(items, list):
        return out
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            alarm_id = int(item.get("id", 0))
        except (TypeError, ValueError):
            continue
        answers = parse_alarm_answers(item)
        if alarm_id > 0 and answers:
            out[alarm_id] = answers
    return out


# --- the status catalogue ---------------------------------------------------------------


def parse_status_catalogue(pull_all: dict) -> dict | None:
    """``/pull/all`` → {"status": {id: {name, time}}, "order": [id, …]}, or None if absent."""
    if not isinstance(pull_all, dict):
        return None
    cluster = (pull_all.get("data") or {}).get("cluster") or {}
    raw = cluster.get("status")
    if not isinstance(raw, dict) or not raw:
        return None
    status: dict[str, dict] = {}
    for sid, s in raw.items():
        sid_s = str(sid).strip()
        if not sid_s.isdigit() or not isinstance(s, dict):
            continue
        status[sid_s] = {"name": str(s.get("name") or "").strip(), "time": _minutes(s)}
    order = [str(i) for i in _int_list(cluster.get("statussorting_alarm")) if str(i) in status]
    return {"status": status, "order": order} if status else None


_catalogue: tuple[float, dict] | None = None
_catalogue_failed_at: float | None = None


def _now() -> float:
    return time.monotonic()


def remember_catalogue(pull_all: dict) -> None:
    """Keep the status catalogue out of a /pull/all somebody fetched anyway (the Mannschaft sync)."""
    global _catalogue, _catalogue_failed_at
    parsed = parse_status_catalogue(pull_all)
    if parsed is not None:
        _catalogue = (_now(), parsed)
        _catalogue_failed_at = None


def cached_catalogue() -> dict | None:
    return _catalogue[1] if _catalogue else None


def reset_catalogue_cache() -> None:
    global _catalogue, _catalogue_failed_at
    _catalogue = None
    _catalogue_failed_at = None


async def ensure_catalogue(needed: set[str] | frozenset[str] = frozenset()) -> dict | None:
    """The status catalogue, fetched only when it is missing, stale (6 h), or does not know a
    status id an answer was filed under (`needed` — the Einheit added a status since).

    A fetch at most every :data:`CATALOGUE_RETRY_SECONDS` for the last two reasons. Never raises: a failed fetch is logged WITHOUT the URL (the key travels in it) and waits
    :data:`CATALOGUE_RETRY_SECONDS` before the next try. The answers are stored either way; a
    status nobody could name reads «Status 13» and counts as «other».
    """
    global _catalogue_failed_at
    now = _now()
    if _catalogue is not None and now - _catalogue[0] < CATALOGUE_TTL_SECONDS:
        missing = set(needed) - set(_catalogue[1].get("status") or {})
        if not missing or now - _catalogue[0] < CATALOGUE_RETRY_SECONDS:
            return _catalogue[1]
    if _catalogue_failed_at is not None and now - _catalogue_failed_at < CATALOGUE_RETRY_SECONDS:
        return cached_catalogue()
    import httpx

    from .credentials import get as credential
    from .divera import check_response
    from .personnel import DIVERA_PULL_BASE_URL

    key = credential("divera_personnel_access_key") or credential("divera_access_key")
    if not key:
        return cached_catalogue()
    try:
        async with httpx.AsyncClient(timeout=CATALOGUE_TIMEOUT_SECONDS) as client:
            r = await client.get(f"{DIVERA_PULL_BASE_URL}/pull/all", params={"accesskey": key})
            check_response(r)
            data = r.json()
    except Exception as e:  # noqa: BLE001 — the answers do not depend on the names
        _catalogue_failed_at = now
        # Only our own URL-free error is printed: an httpx error's message can carry the request
        # URL, and the URL carries the key (divera.DiveraApiError).
        from .divera import DiveraApiError

        logger.warning(
            "Divera status catalogue fetch failed: %s", e if isinstance(e, DiveraApiError) else type(e).__name__
        )
        return cached_catalogue()
    before = _catalogue
    remember_catalogue(data)
    if _catalogue is before:  # nothing usable came back — back off like a failure
        _catalogue_failed_at = now
    return cached_catalogue()


# --- what is stored, and what the Anwesenheit reads -------------------------------------


def resolvable(answers: dict[str, str], catalogue: dict | None, overrides: Any) -> bool:
    """Every status id the answers use can be classified — by a name in the catalogue, or by a
    station override on the id. When not (a restart whose first /pull/all failed), the poll keeps
    what it stored before rather than reading every answer as «other» and losing it."""
    by_id, _by_name = normalise_overrides(overrides)
    known = set(((catalogue or {}).get("status") or {}).keys()) | set(by_id)
    return set(answers.values()) <= known


def classify_answers(
    answers: dict[str, str], catalogue: dict | None, overrides: Any, person_by_ucr: dict[str, str]
) -> dict | None:
    """What ``divera_emergencies.responses_json`` stores for one alarm — or None if nothing.

        {"coming": [personnel id, …], "not_coming": [personnel id, …],
         "unmapped": {"coming": n, "not_coming": n}}

    «andere» answers («Rückruf erbeten») are dropped, not counted. A person not on the
    Mannschaftsliste is a number in ``unmapped``; their Divera id is not kept.
    """
    ov = normalise_overrides(overrides)
    status = (catalogue or {}).get("status") or {}
    out: dict[str, list[str]] = {"coming": [], "not_coming": []}
    unmapped = {"coming": 0, "not_coming": 0}
    for ucr, sid in answers.items():
        kind = classify(sid, status.get(sid), ov)
        if kind == "other":
            continue
        person = person_by_ucr.get(str(ucr))
        if person is None:
            unmapped[kind] += 1
        else:
            out[kind].append(person)
    if not out["coming"] and not out["not_coming"] and not any(unmapped.values()):
        return None
    return {"coming": sorted(out["coming"]), "not_coming": sorted(out["not_coming"]), "unmapped": unmapped}


def summarise(stored: list[dict]) -> dict:
    """Merge the stored yes/no of an incident's alarm(s), OLDEST alarm first, into what the
    Anwesenheit shows. A newer alarm's answer replaces an older one for the same person (a
    Nachalarm: «komme nicht» at 19:00, «komme» at 19:20). The unmapped count is the newest alarm's
    — the same unknown person answering twice must not count twice.
    """
    kind_of: dict[str, str] = {}
    unmapped = {"coming": 0, "not_coming": 0}
    for blob in stored:
        if not isinstance(blob, dict):
            continue
        for kind in ("coming", "not_coming"):
            for person in blob.get(kind) or []:
                kind_of[str(person)] = kind
        u = blob.get("unmapped")
        if isinstance(u, dict):
            unmapped = {k: _count(u.get(k)) for k in ("coming", "not_coming")}
    coming = sorted(p for p, k in kind_of.items() if k == "coming")
    not_coming = sorted(p for p, k in kind_of.items() if k == "not_coming")
    if not coming and not not_coming and not any(unmapped.values()):
        return {"available": False, "reason": "no_data"}
    return {
        "available": True,
        "coming": coming,
        "not_coming": not_coming,
        "counts": {
            "coming": len(coming) + unmapped["coming"],
            "not_coming": len(not_coming) + unmapped["not_coming"],
            "unmapped": unmapped["coming"] + unmapped["not_coming"],
        },
    }


def _count(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0

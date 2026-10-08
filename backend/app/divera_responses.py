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

The UCR id under ``ucr_answered`` is the key of ``cluster.consumer`` — the id the Mannschaft sync
stores as the ``divera`` external identity. The person mapping is therefore the roster's own, and
it happens on the device that already holds the roster; this module hands out UCR ids only.
"""

from __future__ import annotations

import logging
import re
import time
import unicodedata
from datetime import UTC, datetime
from typing import Any, Literal

logger = logging.getLogger(__name__)

Kind = Literal["coming", "not_coming", "other"]
KINDS: tuple[Kind, ...] = ("coming", "not_coming", "other")

#: A Divera free-text note is one line beside a name, not a message.
NOTE_MAX = 80

#: How long a fetched status catalogue is reused. A Rückmelde-Status is renamed perhaps once a
#: year; asking Divera every poll would be the polling storm the connector promises not to be.
CATALOGUE_TTL_SECONDS = 6 * 3600
#: …and how long a FAILED catalogue fetch waits before it is tried again (a key that cannot read
#: /pull/all must not turn every poll into a second, failing call).
CATALOGUE_RETRY_SECONDS = 30 * 60


# --- the default classification ---------------------------------------------------------

#: Checked FIRST: «Komme nicht» contains «komme». Word-bounded where a bare substring would
#: misfire («no» in «Notfall», «pas» in «Passerelle»).
_NOT_COMING = re.compile(
    r"\b(nicht|not|no|nein|kein\w*|pas|non)\b|abwesend|verhindert|absent|indisponible|unavailable|ferien|urlaub|krank"
)
_COMING = re.compile(
    r"komm|unterwegs|anfahrt|auf dem weg|einsatzbereit|verfugbar|\bja\b|coming|on my way|\byes\b|viens|"
    r"j'arrive|arrive|en route|disponible|\d+\s*min"
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
    except (TypeError, ValueError):
        return None
    return ts if ts > 0 else None


def parse_alarm_responses(item: dict) -> dict | None:
    """The answer half of one Divera alarm, compact and JSON-safe — or None when it has none.

    Shape (what ``divera_emergencies.responses_json`` stores)::

        {"answered": {"<status id>": {"<ucr>": {"ts": int, "note": str}}},
         "addressed": [ucr, …], "read": int, "recipients": int}

    «None» means «nothing to record»: no answers AND nobody addressed. An alarm that was sent to
    30 people of whom nobody answered yet is still worth recording (0 of 30).
    """
    if not isinstance(item, dict):
        return None
    answered: dict[str, dict[str, dict]] = {}
    raw = item.get("ucr_answered")
    if isinstance(raw, dict):
        for sid, people in raw.items():
            if not isinstance(people, dict):
                continue
            sid_s = str(sid).strip()
            if not sid_s.isdigit():
                continue
            bucket: dict[str, dict] = {}
            for ucr, answer in people.items():
                ucr_s = str(ucr).strip()
                if not ucr_s.isdigit():
                    continue
                a = answer if isinstance(answer, dict) else {}
                note = " ".join(str(a.get("note") or "").split())[:NOTE_MAX]
                bucket[ucr_s] = {"ts": _ts(a.get("ts")), "note": note}
            if bucket:
                answered[sid_s] = bucket
    # Divera's own spec spells it «adressed»; real payloads have been seen with both
    addressed = _int_list(item.get("ucr_addressed") if "ucr_addressed" in item else item.get("ucr_adressed"))
    read = _int_list(item.get("ucr_read"))
    if not answered and not addressed:
        return None
    try:
        recipients = int(item.get("count_recipients") or len(addressed))
    except (TypeError, ValueError):
        recipients = len(addressed)
    try:
        read_count = int(item.get("count_read") or len(read))
    except (TypeError, ValueError):
        read_count = len(read)
    return {"answered": answered, "addressed": sorted(set(addressed)), "read": read_count, "recipients": recipients}


def parse_responses_by_alarm(data: dict) -> dict[int, dict]:
    """Divera ``/alarms`` → {divera alarm id: parsed responses}. Closed alarms included: an
    answer given before the alarm was closed in Divera is still an answer."""
    out: dict[int, dict] = {}
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
        if alarm_id <= 0:
            continue
        parsed = parse_alarm_responses(item)
        if parsed is not None:
            out[alarm_id] = parsed
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


async def ensure_catalogue() -> dict | None:
    """The status catalogue, fetched only when it is missing or stale (≤ one call per 6 h).

    Never raises: a failed fetch is logged WITHOUT the URL (the key travels in it) and waits
    :data:`CATALOGUE_RETRY_SECONDS` before the next try. The answers are stored either way; a
    status nobody could name reads «Status 13» and counts as «other».
    """
    global _catalogue_failed_at
    now = _now()
    if _catalogue is not None and now - _catalogue[0] < CATALOGUE_TTL_SECONDS:
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
        async with httpx.AsyncClient(timeout=20.0) as client:
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
    remember_catalogue(data)
    if _catalogue is None:
        _catalogue_failed_at = now
    return cached_catalogue()


# --- what the Anwesenheit reads ---------------------------------------------------------


def _iso(ts: int | None) -> str | None:
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(ts, tz=UTC).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def summarise(stored: list[dict], overrides: Any = None) -> dict:
    """Merge the stored responses of an incident's alarm(s) into what the Anwesenheit shows.

    ``stored`` is a list of ``responses_json`` blobs (one per Divera alarm on the incident — a
    Nachalarm attached to it is one more). Per UCR the LATEST answer wins, across statuses and
    across alarms. The catalogue each blob carries (``statuses``) names the ids; the newest blob's
    name for an id wins.
    """
    ov = normalise_overrides(overrides)
    catalogue: dict[str, dict] = {}
    order: list[str] = []
    latest: dict[str, tuple[str, int | None, str]] = {}
    addressed: set[int] = set()
    read = 0
    recipients = 0
    updated: str | None = None
    for blob in stored:
        if not isinstance(blob, dict):
            continue
        for sid, st in (blob.get("statuses") or {}).items():
            if isinstance(st, dict):
                catalogue[str(sid)] = st
        for sid in blob.get("order") or []:
            if str(sid) not in order:
                order.append(str(sid))
        for sid, people in (blob.get("answered") or {}).items():
            for ucr, a in (people or {}).items():
                ts = (a or {}).get("ts")
                prev = latest.get(ucr)
                if prev is None or (ts or 0) >= (prev[1] or 0):
                    latest[ucr] = (str(sid), ts, (a or {}).get("note") or "")
        addressed.update(_int_list(blob.get("addressed")))
        read = max(read, int(blob.get("read") or 0))
        recipients = max(recipients, int(blob.get("recipients") or 0))
        at = blob.get("updated_at")
        if at and (updated is None or at > updated):
            updated = at

    kinds = {sid: classify(sid, catalogue.get(sid), ov) for sid in {s for s, _, _ in latest.values()} | set(catalogue)}
    counts = dict.fromkeys(KINDS, 0)
    per_status: dict[str, int] = {}
    answers = []
    for ucr, (sid, ts, note) in latest.items():
        kind = kinds.get(sid, "other")
        counts[kind] += 1
        per_status[sid] = per_status.get(sid, 0) + 1
        minutes = _minutes(catalogue.get(sid))
        eta = ts + minutes * 60 if kind == "coming" and minutes > 0 and ts else None
        answers.append(
            {
                "ucr_id": int(ucr),
                "status_id": int(sid),
                "kind": kind,
                "answered_at": _iso(ts),
                "eta": _iso(eta),
                "note": note,
            }
        )
    answers.sort(key=lambda a: (a["answered_at"] or "", a["ucr_id"]))

    def _status_rank(sid: str) -> tuple[int, int]:
        return (order.index(sid) if sid in order else len(order), int(sid))

    statuses = [
        {
            "id": int(sid),
            "name": (catalogue.get(sid) or {}).get("name") or "",
            "kind": kinds.get(sid, "other"),
            "minutes": _minutes(catalogue.get(sid)),
            "count": n,
        }
        for sid, n in sorted(per_status.items(), key=lambda kv: _status_rank(kv[0]))
    ]
    answered = len(latest)
    addressed_n = max(len(addressed), recipients, answered)
    return {
        "available": bool(answered or addressed_n),
        "updated_at": updated,
        "counts": {
            **counts,
            "answered": answered,
            "addressed": addressed_n,
            "unanswered": max(0, addressed_n - answered),
            "read": read,
        },
        "statuses": statuses,
        "answers": answers,
    }


def with_catalogue(parsed: dict, catalogue: dict | None, now: datetime) -> dict:
    """The blob to store: the parsed answers plus the names of exactly the statuses they use (so
    a stored Einsatz still reads «Komme nicht» after the Einheit renames it, and the read never
    needs the live catalogue), stamped with when it was seen."""
    blob = dict(parsed)
    used = set((parsed.get("answered") or {}).keys())
    status = (catalogue or {}).get("status") or {}
    blob["statuses"] = {sid: status[sid] for sid in sorted(used) if sid in status}
    blob["order"] = [sid for sid in (catalogue or {}).get("order") or [] if sid in used]
    blob["updated_at"] = now.isoformat()
    return blob


def same_answers(a: dict | None, b: dict | None) -> bool:
    """True when two stored blobs say the same thing (the stamp aside) — no write for a no-op poll."""
    if not a or not b:
        return a == b
    keys = ("answered", "addressed", "read", "recipients", "statuses")
    return all(a.get(k) == b.get(k) for k in keys)

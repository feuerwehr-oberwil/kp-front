"""The post-Einsatz check — run it the morning after every Übung and every real alarm, even if
nobody complains.

Run from ``backend/`` via ``uv run python -m app.admin_postcheck <incident-id|latest>``. It is
READ-ONLY: it connects with its own engine whose sessions start read-only, switches the
connection to ``default_transaction_read_only`` (Postgres) or ``query_only`` (SQLite) and reads
the setting back before the first SELECT. Nothing here ever writes.

    <incident>              an incident id, a unique id prefix (≥ 8 characters) or ``latest``
    --logs app.jsonl        the Railway app log (``railway logs <deployment> --json``)
    --http http.jsonl       the Railway HTTP log (``railway logs <deployment> --http --json``)
    --dump DIR              read the incident's tables from a JSON dump instead of a database
    --since / --until       the window the logs are read in (default: the incident ± 15 min)
    --json                  the report as one JSON document instead of text

Why it exists: the post-mortem of the Übung on 23.09.2026 took a whole night of hand-written
queries, and two of its worst findings — the client clock jumping back three days and edits of
other devices being lost — had been reported by nobody. Every section below is one of those
queries, run the same way every time:

- Devices seen: a device is one User-Agent in the HTTP log that touched this incident (the IPs
  it used are listed — a phone on a mobile network changes IP, so an IP is not a device). That
  is a LOWER bound: two identical phones are one «device» here. Without logs: the accounts.
- Crashes and render storms per device (``kpfront.clienterror`` lines of the app log).
- HTTP errors ≥ 400 per device and path, with the 409 conflicts on ``PUT …/workspace`` and
  their retry pattern.
- Clock jumps: a Verlauf row's own ``at`` against the server's ``created_at``, and a client
  audit event's ``occurred_at`` against ``recorded_at``.
- Duplicate events: the same audit event or Verlauf row, under different ids, within seconds.
- PIN prompts and expired sessions in the field (the auth endpoints in the HTTP log).
- Vehicles: the «vor Ort / verlassen» Verlauf rows and the Zeiten grid beside the GPS truth
  in ``vehicle_samples``, read with the client's own state machine.

Exit code: 0 when there is nothing to look at, 1 when there are findings (so a cron or CI job
can tell), 2 when the check itself could not run — including a crash of the check, and a log
that has nothing in the window: «OK» must mean something was read.
"""

from __future__ import annotations

import argparse
import asyncio
import bisect
import json
import math
import re
import sys
from collections import Counter, defaultdict
from collections.abc import AsyncIterator, Iterable, Iterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, NoReturn

from .admin_cli import fail as _cli_fail

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

#: Exit codes — the contract a cron job reads.
EXIT_CLEAN = 0
EXIT_FINDINGS = 1
EXIT_ERROR = 2

#: The Fahrzeug presence rings of the client (src/lib/useVehiclePresenceLog.ts). Kept equal to
#: the client's on purpose: the question is «did the app write what the GPS said», so the GPS
#: has to be read with the app's own rule.
AT_SCENE_M = 150.0
LEFT_M = 300.0
PRESENCE_SETTLE_S = 90.0

#: How far around the incident the logs are read when no --since/--until is given.
WINDOW_MARGIN = timedelta(minutes=15)

#: A stored row carries its transaction's START (Postgres `now()`), the HTTP log the moment the
#: response left, and the request's duration — so the request that stored a row began before it
#: and answered after it. Measured on 23.09.2026 (edge log vs database, 563 rows): every row
#: fits a request with 5 ms of slack for the two clocks (4 of them two requests), while 0.5 s
#: made a third of them ambiguous.
_ATTRIBUTION_EPS_S = 0.005
#: …and when nothing fits that tightly, a looser fit is still offered, marked «?».
_ATTRIBUTION_LOOSE_S = 0.5

#: A GET …/journal that took this long was a long-poll (Railway logs the path without its
#: query string, so `wait=1` is not visible there).
_LONG_POLL_MS = 5000

#: A Railway log page is capped at 5000 lines; a file of exactly that many is probably cut.
_RAILWAY_PAGE = 5000
#: How much of the window a log may leave uncovered at either end before the check says so.
_COVERAGE_SLACK = timedelta(minutes=10)

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
_ISO_IN_TEXT = re.compile(r"\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?")
_FRACTION = re.compile(r"(\.\d{1,6})\d*")
#: `newId` (src/lib/ids.ts): `<prefix><ms>-<seq:2><rand:3>` — the `seq` is a per-tab counter.
_NEW_ID = re.compile(r"^[a-z]+(\d{13})-([0-9a-z]{2})[0-9a-z]{3}(?:-[a-z])?$")
#: `vp-<n>-<zone>-<vehicle>` — the derived presence row id (since 24.09.2026).
_PRESENCE_ID = re.compile(r"^vp-(\d+)-(scene|away)-(.+)$")
#: A row the audio player wrote (src/lib/ids.ts · isPlayerRowId): Durchhören and
#: Nachdokumentation stamp what was SAID at the moment it was said, i.e. backdated on purpose.
_PLAYER_ROW = re.compile(r"^e\d+-(?:p\d{1,3}|[0-9a-z]+-p)$")
#: The presence rows' text in the four shipped locales (appConfig.copy.contextPanel), for the
#: rows written before the derived ids existed.
_ARRIVED_SUFFIXES = (" vor Ort", " on scene", " sur place", " sul posto")
_LEFT_SUFFIXES = (
    " hat den Einsatzort verlassen",
    " has left the scene",
    " a quitté les lieux",
    " ha lasciato il luogo",
)

#: A 409 is «resolved» when the same device's next successful save comes within this. The retry
#: backs off by up to 1.5 s a step (workspaceSync · conflictBackoffMs), but a burst of six is one
#: merge fight, and it ends with the save after the LAST of them.
_CONFLICT_RESOLVE_S = 120.0

#: `incident_events.source` values whose `occurred_at` is a DEVICE clock (a tablet, an el
#: session, an Atemschutz-Link phone). `status`, `divera`, `units` and `gps` are stamped by the
#: server or an alarm system and say nothing about a device's clock.
_CLIENT_SOURCES = frozenset({"client", "el", "atemschutz-link"})

_AUTH_PATHS = ("/api/auth/", "/api/incident-link/session", "/api/incident-link/terminal-session")

#: Whether times print with their date — set per report when its window spans days.
_WITH_DATE: ContextVar[bool] = ContextVar("postcheck_with_date", default=False)


# ── small helpers ─────────────────────────────────────────────────────────────────────────


def fail(message: str) -> NoReturn:
    """The shared refusal, with exit code 2: 1 is taken by «findings»."""
    _cli_fail(message, code=EXIT_ERROR)


def parse_ts(value: Any) -> datetime | None:
    """Any timestamp this tool meets, as an aware UTC datetime — or None.

    Railway writes nine fractional digits and a ``Z``, a JSON dump of a Postgres row a space
    and ``+00:00``, the client an ``…Z`` with milliseconds. A naive value is read as UTC."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if not isinstance(value, str) or not value.strip():
        return None
    s = value.strip().replace("Z", "+00:00")
    s = _FRACTION.sub(lambda m: m.group(1), s, count=1)
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=UTC)).astimezone(UTC)


def _db_ts(value: Any) -> datetime:
    """A NOT NULL timestamp column — a None here is a broken row, and the check says so."""
    ts = parse_ts(value)
    if ts is None:
        fail(f"ERROR: unreadable timestamp in the database: {value!r}")
    return ts


def _hms(dt: datetime | None) -> str:
    if dt is None:
        return "?"
    return dt.astimezone(UTC).strftime("%d.%m. %H:%M:%S" if _WITH_DATE.get() else "%H:%M:%S")


def _stamp(dt: datetime | None) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%SZ") if dt else "?"


def _span(seconds: float) -> str:
    """A signed duration a human reads at a glance: «+45 s», «−12 min 3 s», «−3 d 2 h»."""
    sign = "−" if seconds < 0 else "+"
    s = abs(round(seconds))
    if s < 60:
        return f"{sign}{s} s"
    if s < 3600:
        return f"{sign}{s // 60} min {s % 60} s"
    if s < 86400:
        return f"{sign}{s // 3600} h {s % 3600 // 60} min"
    return f"{sign}{s // 86400} d {s % 86400 // 3600} h"


def _short(text: Any, limit: int = 70) -> str:
    t = " ".join(str(text or "").split())
    return t if len(t) <= limit else t[: limit - 1] + "…"


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def is_location(lat: float | None, lng: float | None) -> bool:
    """0/0 is «no location» (the client's own reading, IncidentWorkspace · incidentView.center),
    not a point in the Gulf of Guinea to measure a fire engine against."""
    return lat is not None and lng is not None and not (lat == 0 and lng == 0)


def _as_dict(value: Any) -> dict:
    """A JSONB column as a dict — a dump carries it as a JSON string."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            loaded = json.loads(value)
        except ValueError:
            return {}
        return loaded if isinstance(loaded, dict) else {}
    return {}


def path_template(path: str, incident_id: str) -> str:
    """``/api/incidents/<this>/workspace?x`` → ``/api/incidents/{incident}/workspace``: one row
    per ENDPOINT in the error table, not one per id."""
    p = path.split("?", 1)[0].replace(incident_id, "{incident}")
    p = _UUID.sub("{uuid}", p)
    return re.sub(r"/\d{3,}(?=/|$)", "/{n}", p)


def _duration_ms(value: Any) -> int:
    """Railway's ``totalDuration`` — an int in every export seen so far, but a float or a string
    must not end the check."""
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return 0


def _tag_no(tag: str) -> int:
    return int(tag[1:]) if tag[1:].isdigit() else 0


# ── the evidence ─────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class IncidentInfo:
    id: str
    title: str = "?"
    status: str = "?"
    is_exercise: bool | None = None
    started_at: datetime | None = None
    closed_at: datetime | None = None
    lat: float | None = None
    lng: float | None = None


@dataclass(frozen=True)
class JournalRow:
    client_id: str
    seq: int
    row: dict
    created_at: datetime

    @property
    def at(self) -> datetime | None:
        return parse_ts(self.row.get("at"))

    @property
    def when(self) -> datetime:
        """The time the row STATES, or the server's when it states none."""
        return self.at or self.created_at

    @property
    def row_id(self) -> str:
        return str(self.row.get("id") or self.client_id)


@dataclass(frozen=True)
class EventRow:
    id: str
    client_id: str | None
    seq: int
    source: str
    user_id: str | None
    op_type: str
    payload: dict
    occurred_at: datetime
    recorded_at: datetime


@dataclass(frozen=True)
class Sample:
    device_id: int
    ts: datetime
    lat: float
    lng: float


@dataclass
class Evidence:
    incident: IncidentInfo
    journal: list[JournalRow]
    events: list[EventRow]
    samples: list[Sample]
    workspace: dict | None
    #: user id → (username, role); the username is unknown in a dump that kept roles only
    users: dict[str, tuple[str | None, str | None]] = field(default_factory=dict)
    #: fleet vehicle id → label (config `fleet.vehicles`) — names the Zeiten grid's rows
    fleet: dict[str, str] | None = None
    origin: str = "database"


@dataclass(frozen=True)
class HttpLine:
    ts: datetime
    method: str
    path: str
    status: int
    ua: str
    ip: str
    duration_ms: int = 0


@dataclass(frozen=True)
class CrashLine:
    ts: datetime
    kind: str
    build: str
    message: str
    ua: str
    surface: str | None = None
    repeat: int = 1
    server_build: str | None = None


@dataclass
class LogStats:
    """What a log file actually held — «OK» from a file that covered nothing is a lie."""

    flag: str
    path: Path
    lines: int = 0  # non-empty lines
    usable: int = 0  # lines with a timestamp (the HTTP log: and a status)
    in_window: int = 0
    repeated: int = 0  # page-boundary lines dropped
    first: datetime | None = None
    last: datetime | None = None

    def note(self, ts: datetime) -> None:
        self.usable += 1
        self.first = ts if self.first is None or ts < self.first else self.first
        self.last = ts if self.last is None or ts > self.last else self.last

    def describe(self) -> str:
        span = f"{_stamp(self.first)} → {_stamp(self.last)}" if self.first else "no timestamps"
        rep = f", {self.repeated} repeated dropped" if self.repeated else ""
        return (
            f"{self.flag} {self.path.name}: {self.lines} lines read, {self.usable} usable, "
            f"{self.in_window} in the window{rep} · covers {span}"
        )

    def warnings(self, since: datetime, until: datetime) -> list[str]:
        out = []
        if self.lines == _RAILWAY_PAGE:
            out.append(
                f"{self.flag} has exactly {_RAILWAY_PAGE} lines — one Railway page; the export is probably cut. "
                "Page back with --until and concatenate."
            )
        if self.first and self.last and (self.first > since + _COVERAGE_SLACK or self.last < until - _COVERAGE_SLACK):
            out.append(
                f"{self.flag} covers {_stamp(self.first)} → {_stamp(self.last)}, the window is "
                f"{_stamp(since)} → {_stamp(until)}: what happened outside it was not checked."
            )
        return out

    def as_json(self) -> dict[str, Any]:
        return {
            "flag": self.flag,
            "file": str(self.path),
            "lines": self.lines,
            "usable": self.usable,
            "inWindow": self.in_window,
            "repeatedDropped": self.repeated,
            "first": self.first.isoformat() if self.first else None,
            "last": self.last.isoformat() if self.last else None,
        }


# ── reading the logs ─────────────────────────────────────────────────────────────────────


def _log_records(path: Path, stats: LogStats) -> Iterator[tuple[datetime | None, dict | None, str]]:
    """Each line as (timestamp, parsed JSON or None, raw text). Railway writes JSON lines; a
    plain line (``docker compose logs -t``) is read for the first ISO timestamp in it."""
    with path.open(encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            stats.lines += 1
            obj: dict | None = None
            if line.startswith("{"):
                try:
                    loaded = json.loads(line)
                    obj = loaded if isinstance(loaded, dict) else None
                except ValueError:
                    obj = None
            if obj is not None:
                yield parse_ts(obj.get("timestamp")), obj, str(obj.get("message", ""))
            else:
                m = _ISO_IN_TEXT.search(line)
                yield (parse_ts(m.group(0)) if m else None), None, line


_CRASH_HEAD = re.compile(r"client-error (?P<head>.*?) ua=(?P<ua>.*?)(?: :: (?P<rest>.*))?$")


def parse_crash_message(ts: datetime, message: str) -> CrashLine | None:
    """One ``kpfront.clienterror`` line → a CrashLine. Reads the format before 24.09.2026
    (``kind build path ua :: message``) and the one since (``srv=``, ``surface=``,
    ``repeat=×N since= last=``, `` :: stack: …``)."""
    if "client-error" not in message:
        return None
    m = _CRASH_HEAD.search(message)
    if not m:
        return None
    head = m.group("head")
    fields = dict(re.findall(r"(\w+)=(\S+)", head))
    rep = re.search(r"repeat=×(\d+)", head)
    rest = m.group("rest") or ""
    text = re.split(r" :: (?:stack|componentStack): ", rest, maxsplit=1)[0]
    return CrashLine(
        ts=ts,
        kind=fields.get("kind", "?"),
        build=fields.get("build", "?"),
        message=text.strip(),
        ua=m.group("ua").strip(),
        surface=fields.get("surface"),
        repeat=int(rep.group(1)) if rep else 1,
        server_build=fields.get("srv"),
    )


def read_crashes(path: Path, since: datetime, until: datetime) -> tuple[list[CrashLine], LogStats]:
    stats = LogStats("--logs", path)
    out: list[CrashLine] = []
    seen: set[tuple[datetime, str]] = set()
    for ts, _obj, message in _log_records(path, stats):
        if ts is None:
            continue
        # the export is paged back with --until = the oldest line of the page before, so the
        # boundary line comes twice; an app log line has no request id, its time and text are it
        if (ts, message) in seen:
            stats.repeated += 1
            continue
        seen.add((ts, message))
        stats.note(ts)
        if not since <= ts <= until:
            continue
        stats.in_window += 1
        if "kpfront.clienterror" in message and (crash := parse_crash_message(ts, message)):
            out.append(crash)
    return sorted(out, key=lambda c: c.ts), stats


def read_http(path: Path, since: datetime, until: datetime) -> tuple[list[HttpLine], LogStats]:
    stats = LogStats("--http", path)
    out: list[HttpLine] = []
    seen: set[str] = set()
    for ts, obj, _message in _log_records(path, stats):
        if ts is None or obj is None or "httpStatus" not in obj:
            continue
        rid = obj.get("requestId")
        if rid:  # the export is paged; an overlapping page must not count a request twice
            if rid in seen:
                stats.repeated += 1
                continue
            seen.add(rid)
        try:
            status = int(float(obj.get("httpStatus") or 0))
        except (TypeError, ValueError):
            continue
        stats.note(ts)
        if not since <= ts <= until:
            continue
        stats.in_window += 1
        out.append(
            HttpLine(
                ts=ts,
                method=str(obj.get("method", "?")),
                path=str(obj.get("path", "")),
                status=status,
                ua=str(obj.get("clientUa") or "?"),
                ip=str(obj.get("srcIp") or "?"),
                duration_ms=_duration_ms(obj.get("totalDuration")),
            )
        )
    return sorted(out, key=lambda h: h.ts), stats


# ── devices ──────────────────────────────────────────────────────────────────────────────


def ua_key(ua: str) -> str:
    """The server logs a crash's User-Agent cut at 300 characters; the HTTP log keeps it whole."""
    return ua.strip()[:300]


def ua_label(ua: str) -> str:
    """«Android Chrome 130 phone», «iPhone Safari 18.0», «iPad/Mac Safari 18.0».

    An iPad asks for the desktop site and reports as a Mac — the label says both rather than
    guessing. Android without «Mobile» is a tablet (Chrome drops the token there)."""
    if "iPhone" in ua:
        system = "iPhone"
    elif "iPad" in ua:
        system = "iPad"
    elif "Android" in ua:
        system = "Android"
    elif "Macintosh" in ua:
        system = "Mac" if ("Chrome/" in ua or "Firefox/" in ua) else "iPad/Mac"
    elif "Windows" in ua:
        system = "Windows"
    elif "Linux" in ua:
        system = "Linux"
    else:
        return _short(ua, 40)
    for pattern, name in (
        (r"SamsungBrowser/([\d.]+)", "Samsung Internet"),
        (r"EdgA?/(\d+)", "Edge"),
        (r"(?:Firefox|FxiOS)/(\d+)", "Firefox"),
        (r"CriOS/(\d+)", "Chrome"),
        (r"Chrome/(\d+)", "Chrome"),
        (r"Version/([\d.]+).*Safari", "Safari"),
    ):
        m = re.search(pattern, ua)
        if m:
            browser = f"{name} {m.group(1)}"
            break
    else:
        browser = "browser"
    form = ""
    if system == "Android":
        form = " phone" if "Mobile" in ua else " tablet"
    return f"{system} {browser}{form}"


@dataclass
class Device:
    tag: str
    ua: str
    label: str
    ips: Counter[str] = field(default_factory=Counter)
    requests: int = 0
    first: datetime | None = None
    last: datetime | None = None
    accounts: Counter[str] = field(default_factory=Counter)
    #: 2xx answers, sorted — «was it online then?»
    ok_times: list[float] = field(default_factory=list)
    #: its first request about this incident — a PIN before it is the start, one after is mid-Einsatz
    first_incident: datetime | None = None
    #: the most Verlauf long-polls this User-Agent had open at once: ≥ 2 is ≥ 2 browsers
    concurrent_polls: int = 0

    @property
    def name(self) -> str:
        return f"{self.tag} {self.label}"

    def online(self, a: float, b: float) -> bool:
        """A successful answer anywhere in [a, b] (epoch seconds)."""
        i = bisect.bisect_left(self.ok_times, a)
        return i < len(self.ok_times) and self.ok_times[i] <= b


@dataclass(frozen=True)
class Attribution:
    """Which device's request stored a row. ``others`` are devices whose requests could have
    stored it just as well — then the honest answer is «D2|D5?», not a guess."""

    device: Device | None = None
    others: tuple[Device, ...] = ()
    loose: bool = False

    @property
    def label(self) -> str:
        if self.others:
            tags = sorted({d.tag for d in (self.device, *self.others) if d is not None}, key=_tag_no)
            return "|".join(tags) + "?"
        if self.device is not None:
            return self.device.name + ("?" if self.loose else "")
        return "device ?"

    @property
    def known(self) -> bool:
        return self.device is not None


class DeviceBook:
    """The devices of one incident and what they wrote.

    A device is a User-Agent that made at least one request carrying this incident's id in the
    window. Its other requests (auth, the crash sink, reference data) count too — they are the
    same browser. What never touched this incident is kept apart as ``foreign``."""

    def __init__(self, http: list[HttpLine], incident_id: str) -> None:
        self.incident_id = incident_id
        touching = {ua_key(h.ua) for h in http if incident_id in h.path}
        self.http = [h for h in http if ua_key(h.ua) in touching]
        self.foreign = [h for h in http if ua_key(h.ua) not in touching]
        by_key: dict[str, Device] = {}
        base = f"/api/incidents/{incident_id}"
        polls: dict[str, list[tuple[float, int]]] = defaultdict(list)
        for h in self.http:
            key = ua_key(h.ua)
            dev = by_key.get(key)
            if dev is None:
                dev = by_key[key] = Device(tag="", ua=h.ua, label=ua_label(h.ua))
            dev.ips[h.ip] += 1
            dev.requests += 1
            dev.first = dev.first or h.ts
            dev.last = h.ts
            if dev.first_incident is None and incident_id in h.path:
                dev.first_incident = h.ts
            if 200 <= h.status < 300:
                dev.ok_times.append(h.ts.timestamp())
            p = h.path.split("?")[0]
            if h.method == "GET" and p == f"{base}/journal" and (h.duration_ms >= _LONG_POLL_MS or "wait=1" in h.path):
                end = h.ts.timestamp()
                polls[key] += [(end - h.duration_ms / 1000.0, 1), (end, -1)]
        for key, edges in polls.items():
            live = peak = 0
            for _t, step in sorted(edges, key=lambda e: (e[0], e[1])):
                live += step
                peak = max(peak, live)
            by_key[key].concurrent_polls = peak
        self.devices = sorted(by_key.values(), key=lambda d: d.first or datetime.max.replace(tzinfo=UTC))
        for i, dev in enumerate(self.devices, 1):
            dev.tag = f"D{i}"
        self._by_key = by_key
        self._writes: dict[str, list[tuple[float, float, Device]]] = {"events": [], "journal": [], "workspace": []}
        for h in self.http:
            if not 200 <= h.status < 300:
                continue
            p = h.path.split("?")[0]
            if h.method == "POST" and p == f"{base}/events":
                kind = "events"
            elif h.method == "POST" and p == f"{base}/journal":
                kind = "journal"
            elif h.method == "PUT" and p.startswith(f"{base}/workspace"):
                kind = "workspace"
            else:
                continue
            self._writes[kind].append((h.ts.timestamp(), h.duration_ms / 1000.0, by_key[ua_key(h.ua)]))
        for lst in self._writes.values():
            lst.sort(key=lambda t: t[0])
        self._attr: dict[str, dict[datetime, Attribution]] = {"events": {}, "journal": {}, "workspace": {}}

    def of(self, ua: str) -> Device | None:
        return self._by_key.get(ua_key(ua))

    def first_incident_request(self) -> datetime | None:
        return min((d.first_incident for d in self.devices if d.first_incident), default=None)

    def _covering(self, kind: str, t: float, eps: float) -> list[int]:
        """Indexes of the requests that could have stored a row stamped ``t``: begun before it,
        answered after it, ± ``eps`` for the two clocks. Sorted by answer time."""
        lst = self._writes[kind]
        i = bisect.bisect_left(lst, t - eps, key=lambda x: x[0])
        out = []
        while i < len(lst) and lst[i][0] <= t + 300:
            ts, dur, _dev = lst[i]
            if ts - dur - eps <= t <= ts + eps:
                out.append(i)
            i += 1
        return out

    def assign(self, kind: str, stamps: Iterable[datetime]) -> None:
        """Match stored rows to the requests that stored them — EXCLUSIVELY.

        Rows stored by one request share its transaction's start, so they are one group, and
        one request stores one group. Groups are taken in time order and each gets the earliest-
        answered request that covers it and is still free. That matters under contention: two
        devices' appends queue on the incident row's lock, so both requests cover both rows —
        «first response covering t» handed both rows to the lock holder and the other device
        vanished (23.09.2026, 18:36:16). Exclusive, both devices keep a row each; and because
        either could have stored either, both rows print «D2|D5?»."""
        used: set[int] = set()
        lst = self._writes[kind]
        for stamp in sorted(set(stamps)):
            t = stamp.timestamp()
            cover = self._covering(kind, t, _ATTRIBUTION_EPS_S)
            loose = False
            if not cover:
                cover = self._covering(kind, t, _ATTRIBUTION_LOOSE_S)
                loose = bool(cover)
            free = [i for i in cover if i not in used]
            devices = {id(lst[i][2]): lst[i][2] for i in cover}
            if free:
                used.add(free[0])
                device: Device | None = lst[free[0]][2]
            elif len(devices) == 1:
                device = next(iter(devices.values()))
            else:
                device = None
            others = tuple(sorted((d for d in devices.values() if d is not device), key=lambda d: _tag_no(d.tag)))
            self._attr[kind][stamp] = Attribution(device, others, loose)

    def writer(self, kind: str, stored_at: datetime) -> Attribution:
        return self._attr[kind].get(stored_at, Attribution())

    def online_devices(self, a: float, b: float) -> list[Device]:
        return [d for d in self.devices if d.online(a, b)]

    def online_between(self, dev: Device | None, a: datetime, b: datetime) -> bool:
        """Did ``dev`` get a successful answer well inside (a, b)? Then a row it stamped at ``a``
        and delivered at ``b`` was probably not held offline — its clock was wrong."""
        if dev is None:
            return False
        lo, hi = min(a, b).timestamp() + 30, max(a, b).timestamp() - 30
        return hi > lo and dev.online(lo, hi)


# ── the report ───────────────────────────────────────────────────────────────────────────


@dataclass
class Section:
    key: str
    title: str
    lines: list[str] = field(default_factory=list)
    findings: list[str] = field(default_factory=list)
    data: dict[str, Any] = field(default_factory=dict)
    skipped: str | None = None

    def finding(self, line: str, short: str | None = None) -> None:
        """A line worth a human look: printed with a «!» and counted in the summary."""
        self.lines.append(f"! {line}")
        self.findings.append(short or line)


@dataclass(frozen=True)
class Options:
    skew_s: float = 120.0
    dup_s: float = 10.0
    burst: int = 5
    vehicle_lag_s: float = 300.0
    center: tuple[float, float] | None = None


def _release(build: str) -> str:
    """``v1.2.0+abc1234`` → ``1.2.0``: the server logs its release, the client release+commit."""
    return build.lstrip("v").split("+", 1)[0]


def section_devices(ev: Evidence, book: DeviceBook | None, crashes: list[CrashLine] | None) -> Section:
    sec = Section("devices", "Devices seen")
    accounts: Counter[str] = Counter(e.user_id for e in ev.events if e.user_id)

    def account_name(uid: str) -> str:
        username, role = ev.users.get(uid, (None, None))
        name = username or uid[:8]
        return f"{name} ({role})" if role else name

    if book is not None:
        for e in ev.events:
            if e.user_id and e.source in _CLIENT_SOURCES:
                att = book.writer("workspace" if e.op_type == "workspace.save" else "events", e.recorded_at)
                if att.device:
                    att.device.accounts[account_name(e.user_id)] += 1
        sec.lines.append(
            "(a device is one User-Agent: a LOWER bound — two identical phones on one browser version are one here)"
        )
        if not book.devices:
            sec.lines.append("no browser in the HTTP log touched this incident in the window")
        for dev in book.devices:
            ips = ", ".join(f"{ip} ({n})" for ip, n in dev.ips.most_common(4))
            more = f" +{len(dev.ips) - 4} more" if len(dev.ips) > 4 else ""
            sec.lines.append(
                f"{dev.tag:<4}{dev.label:<32} {dev.requests:>6} requests  {_hms(dev.first)}–{_hms(dev.last)}  IP {ips}{more}"
            )
            if dev.concurrent_polls >= 2:
                sec.lines.append(
                    f"      ≥{dev.concurrent_polls} browsers behind {dev.tag}: that many Verlauf long-polls were open at once"
                )
            if dev.accounts:
                sec.lines.append("      wrote as " + ", ".join(f"{a} ×{n}" for a, n in dev.accounts.most_common()))
        sec.data["devices"] = [
            {
                "tag": d.tag,
                "label": d.label,
                "userAgent": d.ua,
                "ips": dict(d.ips),
                "requests": d.requests,
                "first": d.first.isoformat() if d.first else None,
                "last": d.last.isoformat() if d.last else None,
                "accounts": dict(d.accounts),
                "concurrentLongPolls": d.concurrent_polls,
            }
            for d in book.devices
        ]
        if book.foreign:
            sec.lines.append(
                f"({len(book.foreign)} requests in the window from browsers that never opened this incident — "
                "their errors are listed as information below)"
            )
    else:
        sec.lines.append("no HTTP log given (--http) — what follows are ACCOUNTS, not devices")
        browsers = sorted({ua_label(c.ua) for c in crashes or []})
        if browsers:
            sec.lines.append("Browsers in the crash reports: " + ", ".join(browsers))

    if accounts:
        sec.lines.append(
            "Accounts in the audit log: " + ", ".join(f"{account_name(u)} ×{n}" for u, n in accounts.most_common())
        )
        sec.data["accounts"] = {account_name(u): n for u, n in accounts.items()}
        if book is not None and book.http:
            # the real answer: which devices each login wrote from (attributed above)
            per_account: dict[str, list[str]] = defaultdict(list)
            for dev in book.devices:
                for acc in dev.accounts:
                    per_account[acc].append(dev.tag)
            for acc, tags in sorted(per_account.items()):
                if len(tags) > 1:
                    sec.lines.append(
                        f"  {acc} wrote from {len(tags)} devices ({', '.join(tags)}) — one login, several devices"
                    )
            sec.data["devicesPerAccount"] = dict(per_account)
        else:
            sessions = concurrent_tab_sessions(ev.events)
            for uid, n in sorted(sessions.items(), key=lambda kv: -kv[1]):
                if n > 1:
                    sec.lines.append(
                        f"  {account_name(uid)}: about {n} app sessions wrote at the same time "
                        "(rough estimate from the per-tab id counter) — one login on several devices"
                    )
            sec.data["concurrentSessions"] = {account_name(u): n for u, n in sessions.items()}
    return sec


def concurrent_tab_sessions(events: Iterable[EventRow]) -> dict[str, int]:
    """Per account, roughly how many app sessions minted audit ids at the same time.

    Only used without an HTTP log, which knows the devices far better. `newId`
    (src/lib/ids.ts) is ``<prefix><ms>-<seq:2><rand:3>`` and ``seq`` is a counter per page
    load: consecutive ids of one tab step it forward by a few, while two tabs count on their
    own. So ids are chained by counter continuity and the most chains alive at once is the
    estimate. It is ROUGH in both directions — two counters running side by side merge, and a
    tab that minted 80 ids between two audit events starts a second chain (on 23.09.2026 it
    said 6 where the HTTP log shows 4 devices) — so it answers «one device or several», not
    «how many»."""
    per_user: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for e in events:
        m = _NEW_ID.match(e.client_id or "")
        if not m or not e.user_id or e.client_id is None or not e.client_id.startswith("audit"):
            continue
        per_user[e.user_id].append((int(m.group(1)), int(m.group(2), 36)))
    out: dict[str, int] = {}
    for uid, ids in per_user.items():
        chains: list[list[int]] = []  # [counter, first ms, last ms]
        for ms, counter in sorted(ids):
            best = None
            for ch in chains:
                d = (counter - ch[0]) % 1296
                if 0 < d < 80 and (best is None or d < best[1]):
                    best = (ch, d)
            if best:
                best[0][0], best[0][2] = counter, ms
            else:
                chains.append([counter, ms, ms])
        edges = sorted([(c[1], 1) for c in chains] + [(c[2], -1) for c in chains], key=lambda x: (x[0], -x[1]))
        live = peak = 0
        for _t, step in edges:
            live += step
            peak = max(peak, live)
        out[uid] = peak
    return out


def _crash_groups(crashes: list[CrashLine], who: Any) -> dict[tuple[str, str, str, str], list[CrashLine]]:
    groups: dict[tuple[str, str, str, str], list[CrashLine]] = defaultdict(list)
    for c in crashes:
        groups[(who(c), c.kind, c.message[:200], c.build)].append(c)
    return groups


def section_crashes(book: DeviceBook | None, crashes: list[CrashLine] | None) -> Section:
    sec = Section("crashes", "Crashes and render storms")
    if crashes is None:
        sec.skipped = "no --logs"
        return sec
    mine = [c for c in crashes if book is None or not book.http or book.of(c.ua) is not None]
    foreign = [c for c in crashes if c not in mine]

    def who(c: CrashLine) -> str:
        dev = book.of(c.ua) if book else None
        return dev.name if dev else ua_label(c.ua)

    groups = _crash_groups(mine, who)
    if not groups:
        sec.lines.append("no client crash reports from this incident's devices in the window")
    items = []
    for (name, kind, message, build), lst in sorted(groups.items(), key=lambda kv: kv[1][0].ts):
        count = sum(c.repeat for c in lst)
        storm = kind in ("render-storm", "surface-recrash") or "render storm" in message.lower()
        mark = "SURFACE RECRASH" if kind == "surface-recrash" else ("RENDER STORM" if storm else kind)
        hint = " (React #185: maximum update depth — a render loop)" if "#185" in message else ""
        surfaces = sorted({c.surface for c in lst if c.surface})
        where = f" surface={','.join(surfaces)}" if surfaces else ""
        stale = sorted({c.server_build for c in lst if c.server_build and _release(c.server_build) != _release(build)})
        stale_note = f" · server ran {', '.join(stale)} (a client on an older release)" if stale else ""
        sec.finding(
            f"{name}: [{mark}] {_short(message, 90)}{hint} ×{count} {_hms(lst[0].ts)}–{_hms(lst[-1].ts)}"
            f" build {build}{where}{stale_note}",
            f"{name}: {mark} {_short(message, 60)} ×{count}",
        )
        items.append(
            {
                "device": name,
                "kind": kind,
                "highlight": mark if mark != kind else None,
                "message": message,
                "build": build,
                "count": count,
                "first": lst[0].ts.isoformat(),
                "last": lst[-1].ts.isoformat(),
            }
        )
    foreign_out = []
    if foreign:
        # a browser that crashes before it ever opens an incident — a boot crash loop — never
        # shows up above; it is still something to look at, just not this incident's finding
        sec.lines.append("From browsers that never opened this incident (information, not counted):")
        for (name, kind, message, _build), lst in sorted(
            _crash_groups(foreign, lambda c: ua_label(c.ua)).items(), key=lambda kv: kv[1][0].ts
        ):
            count = sum(c.repeat for c in lst)
            sec.lines.append(
                f"    {name}: [{kind}] {_short(message, 80)} ×{count} {_hms(lst[0].ts)}–{_hms(lst[-1].ts)}"
            )
            foreign_out.append({"browser": name, "kind": kind, "message": message, "count": count})
    sec.data.update({"groups": items, "foreign": foreign_out})
    return sec


#: What an error on one of these endpoints means for the Einsatz — the part a reader would
#: otherwise have to look up.
_HTTP_HINTS = {
    (403, "POST", "/api/diag/client-error"): " — a crash report that never reached the log",
    (
        403,
        "POST",
        "/api/incidents/{incident}/events",
    ): " — audit events this role may not write (the outbox parks them)",
    (409, "PUT", "/api/incidents/{incident}/workspace/record"): (
        " — an el record save (Anwesenheit, Mittel, Rapport …) met a concurrent save"
    ),
    (413, "PUT", "/api/incidents/{incident}/workspace"): " — the workspace outgrew the request limit",
}


def _max_in_window(times: list[float], width: float) -> tuple[int, float]:
    """The most events in any ``width``-second window, and where that window starts."""
    best, start, j = 0, times[0] if times else 0.0, 0
    for i, t in enumerate(times):
        while t - times[j] >= width:
            j += 1
        if i - j + 1 > best:
            best, start = i - j + 1, times[j]
    return best, start


def section_http(book: DeviceBook | None, opts: Options) -> Section:
    sec = Section("http", "HTTP errors (≥ 400)")
    if book is None:
        sec.skipped = "no --http"
        return sec
    inc = book.incident_id
    workspace_put = f"/api/incidents/{inc}/workspace"
    groups: dict[tuple[str, int, str, str], list[HttpLine]] = defaultdict(list)
    aborted: Counter[str] = Counter()
    conflicts: dict[str, list[HttpLine]] = defaultdict(list)
    for h in book.http:
        if h.status < 400:
            continue
        dev = book.of(h.ua)
        tag = dev.tag if dev else "?"
        if h.status == 499:
            aborted[tag] += 1
            continue
        if h.status == 401:
            continue  # the auth section reads these
        if h.status == 409 and h.method == "PUT" and h.path.split("?")[0] == workspace_put:
            conflicts[tag].append(h)
            continue
        groups[(tag, h.status, h.method, path_template(h.path, inc))].append(h)

    names = {d.tag: d.name for d in book.devices}
    rows = []
    for (tag, status, method, path), lst in sorted(groups.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][3])):
        hint = _HTTP_HINTS.get((status, method, path), "")
        sec.finding(
            f"{names.get(tag, tag)}: {status} {method} {path} ×{len(lst)} {_hms(lst[0].ts)}–{_hms(lst[-1].ts)}{hint}",
            f"{names.get(tag, tag)}: {status} {method} {path} ×{len(lst)}",
        )
        rows.append(
            {"device": names.get(tag, tag), "status": status, "method": method, "path": path, "count": len(lst)}
        )
    if not groups and not conflicts:
        sec.lines.append("no HTTP errors from this incident's devices")

    # 409 on the full workspace PUT: the multi-device merge at work. One is normal; what matters
    # is whether a device retried in bursts (lock-step, no jitter) and whether each conflict was
    # resolved by a later save. Bursts are counted over a SLIDING 60 s, not per clock minute —
    # six conflicts across 17:59:40–18:00:20 are one burst, not two of three.
    total = sum(len(v) for v in conflicts.values())
    conflict_data = {}
    if total:
        sec.lines.append(f"409 on PUT …/workspace: {total} (the merge retry — one now and then is normal)")
    for tag, lst in sorted(conflicts.items()):
        dev = next((d for d in book.devices if d.tag == tag), None)
        ok_puts = sorted(
            h.ts.timestamp()
            for h in book.http
            if dev is not None and book.of(h.ua) is dev and h.method == "PUT" and h.path.split("?")[0] == workspace_put
            if 200 <= h.status < 300
        )
        unresolved = 0
        for h in lst:
            i = bisect.bisect_right(ok_puts, h.ts.timestamp())
            if i >= len(ok_puts) or ok_puts[i] - h.ts.timestamp() > _CONFLICT_RESOLVE_S:
                unresolved += 1
        times = [h.ts.timestamp() for h in lst]
        worst, worst_start = _max_in_window(times, 60.0)
        bursts: list[list[float]] = []
        for t in times:
            if bursts and t - bursts[-1][-1] <= 60:
                bursts[-1].append(t)
            else:
                bursts.append([t])
        shown = [
            f"{_hms(datetime.fromtimestamp(b[0], UTC))} ×{len(b)} over {round(b[-1] - b[0])} s"
            for b in bursts
            if len(b) >= 2
        ]
        line = (
            f"{names.get(tag, tag)}: ×{len(lst)}, {len(lst) - unresolved} resolved by a save within 2 min, "
            f"worst 60 s ×{worst} from {_hms(datetime.fromtimestamp(worst_start, UTC))}"
        )
        if worst >= opts.burst or unresolved:
            why = []
            if worst >= opts.burst:
                why.append(f"≥ {opts.burst} within 60 s")
            if unresolved:
                why.append(f"{unresolved} never followed by a successful save")
            sec.finding(f"{line} ({'; '.join(why)})", f"{names.get(tag, tag)}: 409 on workspace ×{len(lst)}")
        else:
            sec.lines.append(f"  {line}")
        if shown:
            sec.lines.append(
                "    bursts: " + ", ".join(shown[:12]) + (f", … {len(shown) - 12} more" if len(shown) > 12 else "")
            )
        conflict_data[names.get(tag, tag)] = {"count": len(lst), "unresolved": unresolved, "worst60s": worst}
    if aborted:
        sec.lines.append(
            "499 (the app itself cancelled a request, usually a long-poll — not an error): "
            + ", ".join(f"{names.get(t, t)} ×{n}" for t, n in sorted(aborted.items()))
        )
    foreign: dict[tuple[str, int, str], list[HttpLine]] = defaultdict(list)
    for h in book.foreign:
        if h.status == 404 or h.status >= 500:
            foreign[(ua_label(h.ua), h.status, path_template(h.path, inc))].append(h)
    if foreign:
        sec.lines.append("From browsers that never opened this incident (information, not counted):")
        for (label, status, path), lst in sorted(foreign.items(), key=lambda kv: kv[1][0].ts):
            sec.lines.append(f"    {label}: {status} {path} ×{len(lst)} {_hms(lst[0].ts)}–{_hms(lst[-1].ts)}")
    sec.data.update(
        {
            "errors": rows,
            "workspaceConflicts": conflict_data,
            "aborted499": dict(aborted),
            "foreign": [{"browser": k[0], "status": k[1], "path": k[2], "count": len(v)} for k, v in foreign.items()],
        }
    )
    return sec


def section_clock(ev: Evidence, book: DeviceBook | None, opts: Options) -> Section:
    sec = Section("clock", f"Clock jumps (stated time vs server receipt, > {int(opts.skew_s)} s)")
    items = []
    played = 0
    for r in sorted(ev.journal, key=lambda r: r.created_at):
        at = r.at
        if at is None:
            continue
        skew = (at - r.created_at).total_seconds()
        if abs(skew) <= opts.skew_s:
            continue
        if _PLAYER_ROW.match(r.row_id):
            played += 1  # Durchhören / Nachdokumentation: stamped when it was SAID, on purpose
            continue
        att = book.writer("journal", r.created_at) if book else Attribution()
        if skew > 0:
            why = "stamped AHEAD of the server — a client clock running fast"
        elif book is not None and book.online_between(att.device, at, r.created_at):
            why = "the device was online in between — probably its clock, not an offline queue"
        else:
            why = "a clock behind, or a row held offline that long"
        who = f" {att.label}" if book else ""
        sec.finding(
            f"Verlauf {_hms(r.created_at)} received, stamped {_stamp(at)} ({_span(skew)}){who}"
            f" «{_short(r.row.get('text'), 60)}» — {why}",
            f"Verlauf row stamped {_span(skew)} off: «{_short(r.row.get('text'), 40)}»",
        )
        items.append(
            {
                "table": "journal_entries",
                "clientId": r.client_id,
                "createdAt": r.created_at.isoformat(),
                "at": at.isoformat(),
                "skewSeconds": round(skew, 1),
                "device": att.label if book else None,
                "text": r.row.get("text"),
            }
        )
    for e in sorted(ev.events, key=lambda e: e.recorded_at):
        if e.source not in _CLIENT_SOURCES:
            continue
        skew = (e.occurred_at - e.recorded_at).total_seconds()
        if abs(skew) <= opts.skew_s:
            continue
        att = book.writer("events", e.recorded_at) if book else Attribution()
        who = f" {att.label}" if book else ""
        sec.finding(
            f"audit {e.op_type} {_hms(e.recorded_at)} received, occurred_at {_stamp(e.occurred_at)} ({_span(skew)}){who}",
            f"audit {e.op_type} occurred_at {_span(skew)} off",
        )
        items.append(
            {
                "table": "incident_events",
                "clientId": e.client_id,
                "createdAt": e.recorded_at.isoformat(),
                "at": e.occurred_at.isoformat(),
                "skewSeconds": round(skew, 1),
                "device": att.label if book else None,
                "text": e.op_type,
            }
        )
    if played:
        sec.lines.append(f"({played} Durchhören/Nachdokumentation rows are backdated on purpose — not counted)")
    if not items:
        sec.lines.append(f"no row or event more than {int(opts.skew_s)} s off the server clock")
    sec.data.update({"rows": items, "playerRowsSkipped": played})
    return sec


def _chains(items: list[tuple[datetime, Any]], window_s: float) -> list[list[tuple[datetime, Any]]]:
    """Group time-sorted items where each is within ``window_s`` of the one before."""
    out: list[list[tuple[datetime, Any]]] = []
    for item in sorted(items, key=lambda x: x[0]):
        if out and (item[0] - out[-1][-1][0]).total_seconds() <= window_s:
            out[-1].append(item)
        else:
            out.append([item])
    return out


def duplicate_copies(events: list[EventRow]) -> bool:
    """Whether a chain of same-content events holds copies that should not both exist.

    An OBSERVED event (`obs-<fact>@<actor>`, lib/eventScope · observedEventId, since
    24.09.2026) is scoped per actor on purpose: every account that saw an Atemschutz alarm
    records it once. So one per (fact, actor) is right — with one login per role, «the alarm
    ×3» is three roles, not a fault. What is wrong: the same fact twice for one actor, and
    any two copies under ordinary ids (each device minted its own)."""
    per_actor: Counter[tuple[str, str]] = Counter()
    plain_by_actor: Counter[str] = Counter()
    plain = 0
    for e in events:
        cid = e.client_id or e.id
        if cid.startswith("obs-"):
            fact, _sep, actor = cid.partition("@")
            per_actor[(fact, actor or e.user_id or "?")] += 1
        else:
            plain += 1
            plain_by_actor[e.user_id or "?"] += 1
    if plain >= 2 or any(n > 1 for n in per_actor.values()):
        return True
    # an ordinary copy beside an observed one by the same actor: an old and a new client
    return any(actor in plain_by_actor for _fact, actor in per_actor)


_ROW_VOLATILE = frozenset({"id", "t", "at"})


def section_duplicates(ev: Evidence, book: DeviceBook | None, opts: Options) -> Section:
    sec = Section("duplicates", f"Duplicate events (same content, different ids, within {int(opts.dup_s)} s)")
    found: list[tuple[datetime, str, str, dict[str, Any]]] = []  # (first, line, short, data)

    by_event: dict[tuple[str, str], list[tuple[datetime, EventRow]]] = defaultdict(list)
    for e in ev.events:
        if e.source not in _CLIENT_SOURCES or e.op_type == "workspace.save":
            continue
        by_event[(e.op_type, json.dumps(e.payload, sort_keys=True, ensure_ascii=False))].append((e.occurred_at, e))
    for (op, payload), events in by_event.items():
        for chain in _chains(events, opts.dup_s):
            evs = [e for _t, e in chain]
            ids = {e.client_id or e.id for e in evs}
            if len(ids) < 2 or not duplicate_copies(evs):
                continue
            devs = sorted({book.writer("events", e.recorded_at).label for e in evs}) if book else []
            on = f" from {', '.join(devs)}" if devs else ""
            found.append(
                (
                    chain[0][0],
                    f"audit {op} ×{len(chain)} {_hms(chain[0][0])}–{_hms(chain[-1][0])}{on} {_short(payload, 70)}",
                    f"audit {op} ×{len(chain)} at {_hms(chain[0][0])}",
                    {"table": "incident_events", "kind": op, "payload": json.loads(payload), "ids": sorted(ids)}
                    | {"times": [t.isoformat() for t, _e in chain], "devices": devs},
                )
            )

    # A row is the same FACT when everything but its id and its two clocks matches: two lines
    # drawn a few seconds apart both read «Linie auf Plan gezeichnet» but name two `annoId`s.
    by_row: dict[tuple[str, str], list[tuple[datetime, JournalRow]]] = defaultdict(list)
    for r in ev.journal:
        text = str(r.row.get("text") or "").strip()
        if text:
            fact = {k: v for k, v in r.row.items() if k not in _ROW_VOLATILE}
            by_row[(text, json.dumps(fact, sort_keys=True, ensure_ascii=False))].append((r.when, r))
    for (text, _fact), rows in by_row.items():
        for chain in _chains(rows, opts.dup_s):
            ids = {r.client_id for _t, r in chain}
            if len(ids) < 2:
                continue
            devs = sorted({book.writer("journal", r.created_at).label for _t, r in chain}) if book else []
            on = f" from {', '.join(devs)}" if devs else ""
            found.append(
                (
                    chain[0][0],
                    f"Verlauf «{_short(text, 60)}» ×{len(chain)} at {', '.join(_hms(t) for t, _r in chain)}{on}",
                    f"Verlauf «{_short(text, 40)}» ×{len(chain)}",
                    {"table": "journal_entries", "kind": "row", "text": text, "ids": sorted(ids)}
                    | {"times": [t.isoformat() for t, _r in chain], "devices": devs},
                )
            )
    for _first, line, short, _data in sorted(found, key=lambda f: f[0]):
        sec.finding(line, short)
    if not found:
        sec.lines.append("no duplicates")
    sec.data["groups"] = [data for _first, _line, _short, data in sorted(found, key=lambda f: f[0])]
    return sec


def section_auth(book: DeviceBook | None) -> Section:
    sec = Section("auth", "PIN prompts and expired sessions")
    if book is None:
        sec.skipped = "no --http"
        return sec
    per_dev: dict[str, list[HttpLine]] = defaultdict(list)
    for h in book.http:
        p = h.path.split("?")[0]
        if h.status == 401 or p.startswith(_AUTH_PATHS):
            dev = book.of(h.ua)
            per_dev[dev.tag if dev else "?"].append(h)
    by_tag = {d.tag: d for d in book.devices}
    episodes_out = []
    renewals: Counter[str] = Counter()
    for tag, lst in sorted(per_dev.items()):
        episodes: list[list[HttpLine]] = []
        for h in lst:
            if episodes and (h.ts - episodes[-1][-1].ts).total_seconds() <= 60:
                episodes[-1].append(h)
            else:
                episodes.append([h])
        dev = by_tag.get(tag)
        who = dev.name if dev else tag
        for ep in episodes:
            paths = [(h.method, h.path.split("?")[0], h.status) for h in ep]
            logins = [s for m, p, s in paths if m == "POST" and p == "/api/auth/login"]
            refresh_fail = [s for _m, p, s in paths if p == "/api/auth/refresh" and s >= 400]
            refresh_ok = any(p == "/api/auth/refresh" and 200 <= s < 300 for _m, p, s in paths)
            link_fail = [s for _m, p, s in paths if p.startswith("/api/incident-link/") and s >= 400]
            unauth = sum(1 for _m, _p, s in paths if s == 401)
            when = f"{_hms(ep[0].ts)}–{_hms(ep[-1].ts)}" if len(ep) > 1 else _hms(ep[0].ts)
            if logins:
                ok = any(200 <= s < 300 for s in logins)
                before = dev is not None and dev.first_incident is not None and ep[-1].ts <= dev.first_incident
                result = "succeeded" if ok else f"failed {logins[-1]}"
                expired = (
                    f" after the session expired (refresh {refresh_fail[0]} ×{len(refresh_fail)})"
                    if refresh_fail
                    else ""
                )
                if before and not refresh_fail:
                    # logging in to START work on the incident is how a device joins — not a finding
                    what = f"logged in before opening the incident (login {result})"
                    sec.lines.append(f"{who} {when}: {what}")
                elif before:
                    # …but a session that had EXPIRED on the station device cost a PIN at the
                    # scene before the device could even open the Einsatz (process follow-up:
                    # open every device once after a deploy, and an expiring session shows early)
                    what = (
                        f"session had expired (refresh {refresh_fail[0]} ×{len(refresh_fail)}) — PIN needed "
                        f"before the device could open the incident (login {result})"
                    )
                    sec.finding(f"{who} {when}: {what}", f"{who} {when}: expired session at the start")
                else:
                    what = f"PIN entered mid-Einsatz (login {result}){expired}"
                    sec.finding(f"{who} {when}: {what}", f"{who} {when}: PIN prompt")
            elif refresh_fail:
                what = "session expired"
                sec.finding(
                    f"{who} {when}: session expired (refresh {refresh_fail[0]} ×{len(refresh_fail)}), no login followed",
                    f"{who} {when}: session expired",
                )
            elif link_fail:
                what = "link refused"
                sec.finding(f"{who} {when}: Einsatz-Link refused ({link_fail[0]})", f"{who} {when}: link refused")
            elif unauth and not refresh_ok:
                what = "401 without renewal"
                sec.finding(f"{who} {when}: 401 ×{unauth} with no renewal", f"{who} {when}: 401 without renewal")
            else:
                if unauth:
                    renewals[who] += 1
                continue
            episodes_out.append(
                {"device": who, "from": ep[0].ts.isoformat(), "to": ep[-1].ts.isoformat(), "what": what}
            )
    if renewals:
        sec.lines.append(
            "silent renewals (401 → refresh 200, the user saw nothing): "
            + ", ".join(f"{who} ×{n}" for who, n in sorted(renewals.items()))
        )
    if not episodes_out and not renewals:
        sec.lines.append("no auth traffic besides normal use")
    sec.data.update({"episodes": episodes_out, "silentRenewals": dict(renewals)})
    return sec


def _presence_zone(row: dict) -> str | None:
    m = _PRESENCE_ID.match(str(row.get("id") or ""))
    if m:
        return m.group(2)
    text = str(row.get("text") or "")
    if text.endswith(_ARRIVED_SUFFIXES):
        return "scene"
    if text.endswith(_LEFT_SUFFIXES):
        return "away"
    return None


def _presence_name(text: str) -> str:
    for suffix in _ARRIVED_SUFFIXES + _LEFT_SUFFIXES:
        if text.endswith(suffix):
            return text[: -len(suffix)]
    return text


@dataclass(frozen=True)
class Transition:
    """A change the client's presence log writes: the first fix in the new zone (its `since`),
    and the moment a device watching the feed writes the row (`since` + 90 s)."""

    gps: datetime
    due: datetime
    zone: str
    distance: float
    baseline: bool = False


def presence_transitions(samples: list[Sample], center: tuple[float, float]) -> list[Transition]:
    """The GPS truth under the client's own state machine, fix by fix — exactly
    src/lib/useVehiclePresenceLog.ts: inside 150 m is «scene», beyond 300 m «away»; the band
    between clears a pending change (it neither starts a state nor ends one), and so does a
    reading back in the written zone; a pending zone is written once it has held 90 s.

    One difference is the feed itself: the client re-reads the vehicle every poll, and the
    vehicle keeps its last position between two fixes (samples are only stored on a move).
    So a pending zone that has held 90 s before the next fix arrives was written at `since` +
    90 s. The first zone is the BASELINE — the app never writes a first sighting."""
    out: list[Transition] = []
    written: str | None = None
    pending: str | None = None
    since: datetime | None = None
    since_d = 0.0
    settle = timedelta(seconds=PRESENCE_SETTLE_S)
    for s in samples:
        if not is_location(s.lat, s.lng):
            continue
        if pending is not None and since is not None and s.ts - since >= settle:
            out.append(Transition(since, since + settle, pending, since_d))
            written, pending = pending, None
        d = haversine_m(center[0], center[1], s.lat, s.lng)
        zone = "scene" if d <= AT_SCENE_M else ("away" if d >= LEFT_M else None)
        if zone is None:
            pending = None
            continue
        if written is None:
            written = zone
            out.append(Transition(s.ts, s.ts, zone, d, baseline=True))
            continue
        if zone == written:
            pending = None
            continue
        if pending != zone:
            pending, since, since_d = zone, s.ts, d
    if pending is not None and since is not None:
        out.append(Transition(since, since + settle, pending, since_d))
    return out


@dataclass
class _PresenceRow:
    vehicle: str
    row: JournalRow
    zone: str
    when: datetime
    by_created: bool
    att: Attribution
    trans: Transition | None = None
    online: bool | None = None

    @property
    def lag(self) -> float:
        return (self.when - self.trans.gps).total_seconds() if self.trans else 0.0


def section_vehicles(ev: Evidence, book: DeviceBook | None, opts: Options) -> Section:
    sec = Section("vehicles", "Vehicles: «vor Ort / verlassen» against the GPS")
    center = opts.center
    if center is None and is_location(ev.incident.lat, ev.incident.lng):
        center = (ev.incident.lat, ev.incident.lng)  # type: ignore[assignment]
    by_dev: dict[int, list[Sample]] = defaultdict(list)
    for s in ev.samples:
        if is_location(s.lat, s.lng):
            by_dev[s.device_id].append(s)
    rows_by_entity: dict[str, list[JournalRow]] = defaultdict(list)
    names: dict[str, str] = {}
    for r in ev.journal:
        entity = str(r.row.get("entityId") or "")
        if _presence_zone(r.row) and entity.startswith("gps-"):
            rows_by_entity[entity].append(r)
            names.setdefault(entity, _presence_name(str(r.row.get("text") or "")))
    if center is None or not is_location(*center):
        sec.skipped = "no Einsatzort (the incident has no coordinates or 0/0; pass --center LAT,LNG)"
        return sec
    if not by_dev and not rows_by_entity:
        sec.lines.append("no vehicle samples and no presence rows")
        return sec
    sec.lines.append(f"Einsatzort {center[0]:.6f}, {center[1]:.6f} · rings {int(AT_SCENE_M)} m / {int(LEFT_M)} m")
    # a row is only owed once some device had the incident open
    app_open = (book.first_incident_request() if book and book.http else None) or min(
        (r.created_at for r in ev.journal), default=None
    )
    per_vehicle: list[tuple[str, str, list[Sample], list[Transition], list[_PresenceRow]]] = []
    for entity in sorted(set(rows_by_entity) | {f"gps-{d}" for d in by_dev}, key=lambda e: (len(e), e)):
        dev_id = int(entity[4:]) if entity[4:].isdigit() else None
        samples = sorted(by_dev.get(dev_id, []) if dev_id is not None else [], key=lambda s: s.ts)
        name = names.get(entity) or f"GPS device {dev_id}"
        trans = presence_transitions(samples, center)
        real = [t for t in trans if not t.baseline]
        prs = []
        for r in sorted(rows_by_entity.get(entity, []), key=lambda r: r.when):
            zone = _presence_zone(r.row) or "?"
            at = r.at
            # a row whose own clock is off is placed where the server received it
            by_created = at is None or abs((at - r.created_at).total_seconds()) > opts.skew_s
            when = r.created_at if by_created or at is None else at
            att = book.writer("journal", r.created_at) if book else Attribution()
            pr = _PresenceRow(name, r, zone, when, by_created, att)
            cand = [t for t in real if t.zone == zone and t.gps <= when + timedelta(seconds=30)]
            if cand:
                pr.trans = cand[-1]
                if att.device is not None:
                    pr.online = att.device.online(pr.trans.gps.timestamp() - 30, pr.trans.due.timestamp() + 60)
            prs.append(pr)
        per_vehicle.append((entity, name, samples, trans, prs))

    # rows one device wrote in the same second are ONE catch-up (a tablet waking, a device
    # opening the incident) — one finding for the batch, not one per vehicle
    def batch_key(pr: _PresenceRow) -> tuple[str, int]:
        return (pr.att.device.tag if pr.att.device else "?", int(pr.row.created_at.timestamp()))

    late = [pr for *_x, prs in per_vehicle for pr in prs if pr.trans and pr.lag > opts.vehicle_lag_s]
    batches: dict[tuple[str, int], list[_PresenceRow]] = defaultdict(list)
    for pr in late:
        batches[batch_key(pr)].append(pr)

    def detail(pr: _PresenceRow) -> str:
        t = pr.trans
        if t is None:
            return "no GPS change"
        stated = f"stated {_hms(pr.row.at)}" if pr.row.at else "states no time"
        online = (
            f"{pr.att.label} online at the GPS change: {'yes' if pr.online else 'no'}"
            if pr.att.device
            else "writer unknown; online then: "
            + (", ".join(d.tag for d in book.online_devices(t.gps.timestamp() - 30, t.due.timestamp() + 60)) or "none")
            if book
            else "no HTTP log"
        )
        return (
            f"GPS {_hms(t.gps)} → expected ≈ {_hms(t.due)} (GPS + 90 s), row {stated} / received "
            f"{_hms(pr.row.created_at)} ({_span(pr.lag)}{', placed by receipt' if pr.by_created else ''}) · {online}"
        )

    vehicles_out = []
    first_arrival: dict[str, datetime] = {}
    for entity, name, samples, trans, prs in per_vehicle:
        head = f"{name} ({entity}) · {len(samples)} fixes"
        if samples:
            head += f" {_hms(samples[0].ts)}–{_hms(samples[-1].ts)}"
        sec.lines.append(head)
        inside = next((t for t in trans if t.zone == "scene"), None)
        beyond = next((t for t in trans if t.zone == "away" and inside and t.gps > inside.gps), None)
        if inside:
            first_arrival[name.lower()] = inside.gps
        sec.lines.append(
            "    GPS  first fix inside 150 m "
            + (f"{_hms(inside.gps)} ({inside.distance:.0f} m)" if inside else "never")
            + " · first fix beyond 300 m after that "
            + (f"{_hms(beyond.gps)} ({beyond.distance:.0f} m)" if beyond else "never")
        )
        if trans:
            steps = " → ".join(f"{t.zone} {_hms(t.gps)}" for t in trans)
            sec.lines.append(f"    GPS  {steps} (the first is the baseline, never written)")
        used: dict[int, list[_PresenceRow]] = defaultdict(list)
        rows_out = []
        for pr in prs:
            label = f"«{_short(pr.row.row.get('text'), 50)}»"
            by = f" · {pr.att.label}" if book else ""
            if not samples:
                sec.lines.append(f"    row  {label} {_hms(pr.when)}: no GPS fixes recorded for this vehicle{by}")
            elif pr.trans is None:
                sec.finding(
                    f"{label} {_hms(pr.when)}: no GPS change to «{pr.zone}» before it{by}",
                    f"{name}: row «{pr.zone}» at {_hms(pr.when)} without a GPS change",
                )
            else:
                used[id(pr.trans)].append(pr)
                if pr.lag <= opts.vehicle_lag_s:
                    sec.lines.append(f"    row  {label} {_hms(pr.when)}: {_span(pr.lag)} after the GPS{by}")
                elif len(batches[batch_key(pr)]) > 1:
                    sec.lines.append(
                        f"    late {label}: {_span(pr.lag)} after the GPS — part of "
                        f"{batch_key(pr)[0]}'s batch received {_hms(pr.row.created_at)} (below)"
                    )
                else:
                    sec.finding(f"{label}: {detail(pr)}", f"{name}: row {_span(pr.lag)} after the GPS")
            rows_out.append(
                {
                    "text": pr.row.row.get("text"),
                    "at": pr.when.isoformat(),
                    "receivedAt": pr.row.created_at.isoformat(),
                    "gps": pr.trans.gps.isoformat() if pr.trans else None,
                    "lagSeconds": pr.lag if pr.trans else None,
                    "device": pr.att.label if book else None,
                }
            )
        by_id = {id(t): t for t in trans}
        for tid, lst in used.items():
            if len(lst) > 1:
                sec.finding(
                    f"{name}: {len(lst)} rows for the one GPS change at {_hms(by_id[tid].gps)} "
                    f"({', '.join(pr.row.client_id for pr in lst)})",
                    f"{name}: {len(lst)} rows for one change",
                )
        for t in trans:
            if t.baseline or id(t) in used or app_open is None or t.due < app_open:
                continue
            sec.finding(
                f"{name}: GPS says {'arrived' if t.zone == 'scene' else 'left'} at {_hms(t.gps)} "
                f"(row due ≈ {_hms(t.due)}), no Verlauf row",
                f"{name}: no row for {'arrival' if t.zone == 'scene' else 'departure'} at {_hms(t.gps)}",
            )
        vehicles_out.append(
            {
                "entity": entity,
                "name": name,
                "fixes": len(samples),
                "firstInside": inside.gps.isoformat() if inside else None,
                "firstBeyondAfter": beyond.gps.isoformat() if beyond else None,
                "transitions": [
                    {"gps": t.gps.isoformat(), "due": t.due.isoformat(), "zone": t.zone, "baseline": t.baseline}
                    for t in trans
                ],
                "rows": rows_out,
            }
        )
    for (tag, _second), lst in sorted(batches.items(), key=lambda kv: kv[0][1]):
        if len(lst) < 2:
            continue
        rows_said = "; ".join(f"«{_short(pr.row.row.get('text'), 40)}» {detail(pr)}" for pr in lst)
        sec.finding(
            f"{tag} wrote {len(lst)} late presence rows in one go (received {_hms(lst[0].row.created_at)}) — "
            f"one catch-up, one cause: {rows_said}",
            f"{tag}: {len(lst)} late presence rows at {_hms(lst[0].row.created_at)}",
        )

    grid = (ev.workspace or {}).get("reportMeta", {}) or {}
    fahrzeuge = grid.get("fahrzeuge") if isinstance(grid, dict) else None
    grid_out = []
    if isinstance(fahrzeuge, list) and fahrzeuge:
        sec.lines.append("Zeiten grid (Rapport · Fahrzeugzeiten):")
        if ev.fleet is None:
            sec.lines.append(
                "    (fleet labels unknown — a dump without config.json: grid ids are compared to GPS names as they are)"
            )
        for f in fahrzeuge:
            if not isinstance(f, dict):
                continue
            vid = str(f.get("id") or "?")
            label = (ev.fleet or {}).get(vid, vid)
            parts = []
            for key in ("ausgerueckt", "vorOrt", "zurueck"):
                val = f.get(key)
                ts = parse_ts(val)
                parts.append(f"{key} {_hms(ts) if ts else (val or '–')}")
            gps = first_arrival.get(label.lower()) or first_arrival.get(vid.lower())
            vor = parse_ts(f.get("vorOrt"))
            if gps and vor:
                cmp = f" · GPS inside 150 m {_hms(gps)} ({_span((vor - gps).total_seconds())})"
            elif vor:
                cmp = f" · no GPS vehicle named «{label}» to compare with"
            else:
                cmp = ""
            manual = " (typed)" if f.get("manual") else ""
            sec.lines.append(f"    {label}: {' · '.join(parts)}{manual}{cmp}")
            grid_out.append({"id": vid, "label": label, **{k: f.get(k) for k in ("ausgerueckt", "vorOrt", "zurueck")}})
    else:
        sec.lines.append("Zeiten grid: no Fahrzeugzeiten recorded")
    sec.data.update({"vehicles": vehicles_out, "zeiten": grid_out})
    return sec


@dataclass
class Report:
    incident: IncidentInfo
    origin: str
    since: datetime
    until: datetime
    sections: list[Section]
    inputs: list[LogStats] = field(default_factory=list)

    @property
    def findings(self) -> int:
        return sum(len(s.findings) for s in self.sections)

    @property
    def exit_code(self) -> int:
        return EXIT_FINDINGS if self.findings else EXIT_CLEAN

    @property
    def warnings(self) -> list[str]:
        return [w for s in self.inputs for w in s.warnings(self.since, self.until)]

    def summary(self) -> str:
        """One line a cron mail can carry. «OK» names what it did NOT look at — a database-only
        run has not seen a single crash report, and must not read like one that has."""
        if self.findings:
            per = ", ".join(f"{s.key} {len(s.findings)}" for s in self.sections if s.findings)
            out = f"FINDINGS: {self.findings} ({per})."
        else:
            out = "OK: no findings."
        skipped = [f"{s.key} ({s.skipped})" for s in self.sections if s.skipped]
        if skipped:
            out += f" Not checked: {', '.join(skipped)}."
        if self.warnings:
            out += f" Input warnings: {len(self.warnings)} (see Inputs)."
        return out

    def text(self) -> str:
        inc = self.incident
        kind = "Übung" if inc.is_exercise else ("Einsatz" if inc.is_exercise is False else "incident")
        out = [
            f"Post-Einsatz check · {inc.title} ({kind}) · {inc.id}",
            f"  started {_stamp(inc.started_at)} · {inc.status}"
            + (f", closed {_stamp(inc.closed_at)}" if inc.closed_at else "")
            + f" · read from {self.origin}",
            f"  window {_stamp(self.since)} → {_stamp(self.until)} · all times UTC",
        ]
        if self.inputs:
            out += ["", "Inputs"]
            out += [f"  {s.describe()}" for s in self.inputs]
            out += [f"  warning: {w}" for w in self.warnings]
        for s in self.sections:
            count = f" — {len(s.findings)} finding{'s' if len(s.findings) != 1 else ''}" if s.findings else ""
            out += ["", f"{s.title}{count}"]
            if s.skipped:
                out.append(f"  skipped: {s.skipped}")
            out += [f"  {line}" for line in s.lines]
        out += ["", self.summary()]
        return "\n".join(out)

    def as_json(self) -> dict[str, Any]:
        inc = self.incident
        return {
            "incident": {
                "id": inc.id,
                "title": inc.title,
                "status": inc.status,
                "isExercise": inc.is_exercise,
                "startedAt": inc.started_at.isoformat() if inc.started_at else None,
                "closedAt": inc.closed_at.isoformat() if inc.closed_at else None,
            },
            "origin": self.origin,
            "window": {"since": self.since.isoformat(), "until": self.until.isoformat()},
            "inputs": [s.as_json() for s in self.inputs],
            "warnings": self.warnings,
            "findings": self.findings,
            "summary": self.summary(),
            "sections": {
                s.key: {"title": s.title, "skipped": s.skipped, "findings": s.findings, **s.data} for s in self.sections
            },
        }


def default_window(ev: Evidence) -> tuple[datetime | None, datetime | None]:
    """The incident and 15 min either side: from the alarm (or the first record) to the close
    (or the last record — an Einsatz left open still ends somewhere). None where neither exists."""
    times = [r.created_at for r in ev.journal] + [e.recorded_at for e in ev.events]
    start = ev.incident.started_at or min(times, default=None)
    ends = [t for t in (ev.incident.closed_at, max(times, default=None)) if t is not None]
    return (start - WINDOW_MARGIN if start else None), (max(ends) + WINDOW_MARGIN if ends else None)


def build_report(
    ev: Evidence,
    *,
    http: list[HttpLine] | None,
    crashes: list[CrashLine] | None,
    since: datetime,
    until: datetime,
    opts: Options,
    inputs: list[LogStats] | None = None,
) -> Report:
    token = _WITH_DATE.set(since.date() != until.date())
    try:
        book = DeviceBook(http, ev.incident.id) if http is not None else None
        if book is not None:
            client = [e for e in ev.events if e.source in _CLIENT_SOURCES]
            book.assign("events", [e.recorded_at for e in client if e.op_type != "workspace.save"])
            book.assign("workspace", [e.recorded_at for e in client if e.op_type == "workspace.save"])
            book.assign("journal", [r.created_at for r in ev.journal])
        sections = [
            section_devices(ev, book, crashes),
            section_crashes(book, crashes),
            section_http(book, opts),
            section_clock(ev, book, opts),
            section_duplicates(ev, book, opts),
            section_auth(book),
            section_vehicles(ev, book, opts),
        ]
    finally:
        _WITH_DATE.reset(token)
    return Report(ev.incident, ev.origin, since, until, sections, inputs or [])


# ── loading: a JSON dump ─────────────────────────────────────────────────────────────────


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        fail(f"ERROR: cannot read {path}: {exc}")


def _read_table(path: Path) -> list[dict]:
    """A dumped table: a JSON ARRAY of row objects. Anything else is refused — a `{"rows": …}`
    wrapper or a `null` would otherwise read as an empty table, and an empty table is «OK»."""
    loaded = _read_json(path)
    if not isinstance(loaded, list) or not all(isinstance(r, dict) for r in loaded):
        found = type(loaded).__name__ if not isinstance(loaded, list) else "an array with non-object entries"
        fail(f"ERROR: {path} is not a JSON array of rows (it holds {found}) — dump each table as [{{…}}, …].")
    return loaded


def _read_object(path: Path) -> dict:
    loaded = _read_json(path)
    if isinstance(loaded, str):  # a JSONB column dumped as its text
        loaded = _as_dict(loaded) or loaded
    if not isinstance(loaded, dict):
        fail(f"ERROR: {path} is not a JSON object (it holds {type(loaded).__name__}).")
    return loaded


def _first_file(directory: Path, *names: str) -> Path | None:
    return next((directory / n for n in names if (directory / n).is_file()), None)


def _incident_from_row(row: dict) -> IncidentInfo:
    def num(v: Any) -> float | None:
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    return IncidentInfo(
        id=str(row.get("id")),
        title=str(row.get("title") or "?"),
        status=str(row.get("status") or "?"),
        is_exercise=row.get("is_exercise"),
        started_at=parse_ts(row.get("started_at")),
        closed_at=parse_ts(row.get("closed_at")),
        lat=num(row.get("lat")),
        lng=num(row.get("lng")),
    )


def _fleet(cfg: dict | None) -> dict[str, str]:
    out = {}
    for v in ((cfg or {}).get("fleet") or {}).get("vehicles") or []:
        if isinstance(v, dict) and v.get("id"):
            out[str(v["id"])] = str(v.get("label") or v["id"])
    return out


def _check_ref(ref: str) -> None:
    if ref != "latest" and len(ref) < 8:
        fail("ERROR: give the incident id, a prefix of at least 8 characters, or «latest».")


def load_dump(directory: Path, ref: str) -> Evidence:
    """The incident's tables from a directory of JSON exports — one array of row objects per
    table, as ``json.dumps`` of the SELECTs a post-mortem takes. Recognised files:
    ``journal_entries.json`` (or ``journal.json``), ``incident_events.json`` (``events.json``),
    ``vehicle_samples.json``, ``workspace.json`` (``incidents.map_workspace_json``),
    ``incident.json`` / ``incidents.json`` (the incident row), ``users.json`` and
    ``config.json`` (the deployment config, e.g. ``admin_config show``: names the fleet)."""
    _check_ref(ref)
    if not directory.is_dir():
        fail(f"ERROR: --dump {directory} is not a directory.")
    journal_f = _first_file(directory, "journal_entries.json", "journal.json")
    events_f = _first_file(directory, "incident_events.json", "events.json")
    if journal_f is None and events_f is None:
        fail(f"ERROR: {directory} holds neither journal_entries.json nor incident_events.json.")
    incident_row: dict | None = None
    inc_f = _first_file(directory, "incident.json", "incidents.json")
    if inc_f:
        loaded = _read_json(inc_f)
        rows = loaded if isinstance(loaded, list) else [loaded]
        if not all(isinstance(r, dict) for r in rows):
            fail(f"ERROR: {inc_f} is neither an incident row nor an array of them.")
        matching = [r for r in rows if ref == "latest" or str(r.get("id", "")).startswith(ref)]
        if len(matching) > 1 and ref == "latest":
            matching = sorted(
                matching, key=lambda r: parse_ts(r.get("started_at")) or datetime.min.replace(tzinfo=UTC)
            )[-1:]
        incident_row = matching[0] if len(matching) == 1 else None

    raw_journal = _read_table(journal_f) if journal_f else []
    raw_events = _read_table(events_f) if events_f else []
    ids = {str(r.get("incident_id")) for r in [*raw_journal, *raw_events] if r.get("incident_id")}
    if incident_row is not None:
        incident_id = str(incident_row["id"])
    elif ref != "latest":
        hits = [i for i in ids if i.startswith(ref)]
        if len(hits) != 1:
            fail(
                f"ERROR: the dump holds no single incident matching {ref!r} (it holds: {', '.join(sorted(ids)) or 'none'})."
            )
        incident_id = hits[0]
    elif len(ids) == 1:
        incident_id = next(iter(ids))
    else:
        fail(f"ERROR: the dump holds {len(ids)} incidents — name one: {', '.join(sorted(ids))}.")

    def mine(r: dict) -> bool:
        return str(r.get("incident_id", incident_id)) == incident_id

    journal = [
        JournalRow(
            client_id=str(r.get("client_id") or ""),
            seq=int(r.get("seq") or 0),
            row=_as_dict(r.get("row_json")),
            created_at=ts,
        )
        for r in raw_journal
        if mine(r) and (ts := parse_ts(r.get("created_at")))
    ]
    events = [
        EventRow(
            id=str(r.get("id")),
            client_id=r.get("client_id"),
            seq=int(r.get("seq") or 0),
            source=str(r.get("source") or "?"),
            user_id=str(r["user_id"]) if r.get("user_id") else None,
            op_type=str(r.get("op_type") or "?"),
            payload=_as_dict(r.get("payload_json")),
            occurred_at=occ,
            recorded_at=rec,
        )
        for r in raw_events
        if mine(r) and (occ := parse_ts(r.get("occurred_at"))) and (rec := parse_ts(r.get("recorded_at")))
    ]
    samples_f = _first_file(directory, "vehicle_samples.json")
    samples = [
        Sample(device_id=int(r["device_id"]), ts=ts, lat=float(r["lat"]), lng=float(r["lng"]))
        for r in (_read_table(samples_f) if samples_f else [])
        if mine(r) and (ts := parse_ts(r.get("ts"))) and r.get("lat") is not None and r.get("lng") is not None
    ]
    workspace_f = _first_file(directory, "workspace.json")
    workspace = _read_object(workspace_f) if workspace_f else None
    if workspace is None and incident_row is not None:
        workspace = _as_dict(incident_row.get("map_workspace_json")) or None
    users: dict[str, tuple[str | None, str | None]] = {}
    users_f = _first_file(directory, "users.json")
    for u in _read_table(users_f) if users_f else []:
        if u.get("id"):
            users[str(u["id"])] = (u.get("username"), u.get("role"))
    config_f = _first_file(directory, "config.json")
    incident = _incident_from_row(incident_row) if incident_row else IncidentInfo(id=incident_id)
    return Evidence(
        incident=incident,
        journal=journal,
        events=events,
        samples=samples,
        workspace=workspace,
        users=users,
        fleet=_fleet(_read_object(config_f)) if config_f else None,
        origin=f"dump {directory}",
    )


# ── loading: the database, read-only ─────────────────────────────────────────────────────


def readonly_engine(url: str) -> AsyncEngine:
    """This command's own engine — never the app's pool. No pooling, and on Postgres every
    session STARTS read-only (asyncpg ``server_settings``), before any statement of ours."""
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    connect_args: dict[str, Any] = {}
    if url.startswith("postgresql+asyncpg"):
        connect_args["server_settings"] = {"default_transaction_read_only": "on"}
    return create_async_engine(url, poolclass=NullPool, connect_args=connect_args)


@asynccontextmanager
async def readonly_connection(engine: AsyncEngine) -> AsyncIterator[AsyncConnection]:
    """A connection that CANNOT write, checked before it is handed out.

    Postgres: ``SET default_transaction_read_only = on`` applies from the NEXT transaction, so
    the one it ran in is committed first and the state is read back — a connection that does
    not say ``on`` is refused. The connection is invalidated afterwards rather than returned
    to a pool with the setting still on it. SQLite (the test suite): ``PRAGMA query_only``,
    read back the same way, and switched off again on the way out because the tests share one
    connection."""
    from sqlalchemy import text

    async with engine.connect() as conn:
        dialect = conn.dialect.name
        if dialect == "postgresql":
            await conn.execute(text("SET default_transaction_read_only = on"))
            await conn.commit()
            state = (await conn.execute(text("SHOW transaction_read_only"))).scalar()
            if state != "on":
                await conn.invalidate()
                fail(f"ERROR: could not make the database session read-only (transaction_read_only={state}).")
        elif dialect == "sqlite":
            await conn.execute(text("PRAGMA query_only = ON"))
            await conn.commit()
            state = (await conn.execute(text("PRAGMA query_only"))).scalar()
            if state != 1:
                fail(f"ERROR: could not make the SQLite connection read-only (query_only={state}).")
        else:
            fail(f"ERROR: read-only mode is not known for the {dialect} dialect — refusing to connect.")
        try:
            yield conn
        finally:
            await conn.rollback()
            if dialect == "postgresql":
                await conn.invalidate()
            else:
                await conn.execute(text("PRAGMA query_only = OFF"))
                await conn.commit()


async def load_db(engine: AsyncEngine, ref: str) -> Evidence:
    """The incident's tables, read through ``readonly_connection``."""
    from sqlalchemy import String, cast, select

    from .models import DeploymentConfig, Incident, IncidentEvent, JournalEntry, User, VehicleSample

    _check_ref(ref)
    async with readonly_connection(engine) as conn:
        if ref == "latest":
            q = select(Incident.id).order_by(Incident.started_at.desc()).limit(1)
            hits = list((await conn.execute(q)).scalars())
            if not hits:
                fail("ERROR: there is no incident in this database.")
        else:
            q = select(Incident.id).where(cast(Incident.id, String).like(f"{ref.lower()}%")).limit(3)
            hits = list((await conn.execute(q)).scalars())
            if len(hits) != 1:
                fail(f"ERROR: {len(hits) or 'no'} incident{'s' if len(hits) != 1 else ''} match {ref!r}.")
        inc_id = hits[0]
        inc = (
            await conn.execute(
                select(
                    Incident.id,
                    Incident.title,
                    Incident.status,
                    Incident.is_exercise,
                    Incident.started_at,
                    Incident.closed_at,
                    Incident.lat,
                    Incident.lng,
                    Incident.map_workspace_json,
                ).where(Incident.id == inc_id)
            )
        ).one()
        journal = [
            JournalRow(client_id=r.client_id, seq=int(r.seq), row=_as_dict(r.row_json), created_at=_db_ts(r.created_at))
            for r in await conn.execute(
                select(JournalEntry.client_id, JournalEntry.seq, JournalEntry.row_json, JournalEntry.created_at)
                .where(JournalEntry.incident_id == inc_id)
                .order_by(JournalEntry.seq)
            )
        ]
        events = [
            EventRow(
                id=str(r.id),
                client_id=r.client_id,
                seq=int(r.seq),
                source=r.source,
                user_id=str(r.user_id) if r.user_id else None,
                op_type=r.op_type,
                payload=_as_dict(r.payload_json),
                occurred_at=_db_ts(r.occurred_at),
                recorded_at=_db_ts(r.recorded_at),
            )
            for r in await conn.execute(
                select(
                    IncidentEvent.id,
                    IncidentEvent.client_id,
                    IncidentEvent.seq,
                    IncidentEvent.source,
                    IncidentEvent.user_id,
                    IncidentEvent.op_type,
                    IncidentEvent.payload_json,
                    IncidentEvent.occurred_at,
                    IncidentEvent.recorded_at,
                )
                .where(IncidentEvent.incident_id == inc_id)
                .order_by(IncidentEvent.seq)
            )
        ]
        samples = [
            Sample(device_id=int(r.device_id), ts=_db_ts(r.ts), lat=float(r.lat), lng=float(r.lng))
            for r in await conn.execute(
                select(VehicleSample.device_id, VehicleSample.ts, VehicleSample.lat, VehicleSample.lng)
                .where(VehicleSample.incident_id == inc_id)
                .order_by(VehicleSample.ts)
            )
        ]
        users = {str(r.id): (r.username, r.role) for r in await conn.execute(select(User.id, User.username, User.role))}
        cfg = (await conn.execute(select(DeploymentConfig.config_json).where(DeploymentConfig.id == 1))).scalar()
    return Evidence(
        incident=IncidentInfo(
            id=str(inc.id),
            title=inc.title,
            status=inc.status,
            is_exercise=inc.is_exercise,
            started_at=parse_ts(inc.started_at),
            closed_at=parse_ts(inc.closed_at),
            lat=float(inc.lat) if inc.lat is not None else None,
            lng=float(inc.lng) if inc.lng is not None else None,
        ),
        journal=journal,
        events=events,
        samples=samples,
        workspace=_as_dict(inc.map_workspace_json) or None,
        users=users,
        fleet=_fleet(_as_dict(cfg)),
    )


async def _load_readonly(url: str, ref: str) -> Evidence:
    engine = readonly_engine(url)
    try:
        return await load_db(engine, ref)
    finally:
        await engine.dispose()


# ── the command ──────────────────────────────────────────────────────────────────────────


def _parse_when(value: str) -> datetime:
    ts = parse_ts(value)
    if ts is None:
        raise argparse.ArgumentTypeError(f"not an ISO time: {value!r} (e.g. 2026-09-23T17:00Z)")
    return ts


def _parse_center(value: str) -> tuple[float, float]:
    try:
        lat, lng = (float(x) for x in value.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError(f"not LAT,LNG: {value!r}") from None
    return lat, lng


def _parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="admin_postcheck",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("incident", nargs="?", default="latest", help="incident id, id prefix (≥ 8) or «latest» (default)")
    ap.add_argument("--logs", type=Path, help="Railway app log, JSON lines (railway logs <deployment> --json)")
    ap.add_argument("--http", type=Path, help="Railway HTTP log, JSON lines (railway logs <deployment> --http --json)")
    ap.add_argument("--dump", type=Path, help="read the tables from a directory of JSON dumps instead of DATABASE_URL")
    ap.add_argument("--since", type=_parse_when, help="window start for the logs (default: the incident − 15 min)")
    ap.add_argument("--until", type=_parse_when, help="window end for the logs (default: its end + 15 min)")
    ap.add_argument("--center", type=_parse_center, help="Einsatzort LAT,LNG when the incident row has none")
    ap.add_argument("--clock-skew", type=float, default=120.0, help="seconds a stated time may differ (default 120)")
    ap.add_argument("--dup-window", type=float, default=10.0, help="seconds between duplicates (default 10)")
    ap.add_argument("--burst", type=int, default=5, help="409s within 60 s from one device that count (default 5)")
    ap.add_argument(
        "--vehicle-lag", type=float, default=300.0, help="seconds a presence row may trail the GPS (default 300)"
    )
    ap.add_argument("--json", action="store_true", help="print the report as JSON")
    return ap


def run(argv: list[str], *, engine: AsyncEngine | None = None) -> tuple[Report, bool]:
    """Parse, load, read the logs and build the report; the flag says whether JSON was asked
    for. ``engine`` is for tests — the command builds its own read-only one on DATABASE_URL."""
    args = _parser().parse_args(argv)
    _check_ref(args.incident)
    for flag in ("logs", "http"):
        p = getattr(args, flag)
        if p is not None and not p.is_file():
            fail(f"ERROR: --{flag} {p}: no such file.")
    if args.dump is not None:
        ev = load_dump(args.dump, args.incident)
    elif engine is not None:
        ev = asyncio.run(load_db(engine, args.incident))
    else:
        from .config import settings

        ev = asyncio.run(_load_readonly(settings.database_url, args.incident))
    default_since, default_until = default_window(ev)
    since, until = args.since or default_since, args.until or default_until
    if since is None or until is None:
        fail("ERROR: the incident has no start time and no records — pass --since and --until.")
    if since >= until:
        fail("ERROR: --since is not before --until.")
    opts = Options(
        skew_s=args.clock_skew,
        dup_s=args.dup_window,
        burst=args.burst,
        vehicle_lag_s=args.vehicle_lag,
        center=args.center,
    )
    inputs: list[LogStats] = []
    http = crashes = None
    if args.http:
        http, stats = read_http(args.http, since, until)
        inputs.append(stats)
    if args.logs:
        crashes, stats = read_crashes(args.logs, since, until)
        inputs.append(stats)
    for stats in inputs:
        if stats.in_window == 0:
            covered = (
                f"it covers {_stamp(stats.first)} → {_stamp(stats.last)}" if stats.first else "no line has a timestamp"
            )
            fail(
                f"ERROR: {stats.flag} {stats.path}: none of its {stats.lines} lines falls in the window "
                f"{_stamp(since)} → {_stamp(until)} ({covered}). Wrong deployment, wrong window, or the wrong file?"
            )
    report = build_report(ev, http=http, crashes=crashes, since=since, until=until, opts=opts, inputs=inputs)
    return report, args.json


def main() -> None:
    try:
        report, as_json = run(sys.argv[1:])
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — a crash of the CHECK is not a finding: exit 2, never 1
        print(f"ERROR: the check could not run: {type(exc).__name__}: {_short(exc, 300)}", file=sys.stderr)
        sys.exit(EXIT_ERROR)
    if as_json:
        print(json.dumps(report.as_json(), ensure_ascii=False, indent=2))
    else:
        print(report.text())
    sys.exit(report.exit_code)


if __name__ == "__main__":
    main()

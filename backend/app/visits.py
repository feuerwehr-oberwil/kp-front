"""Visit statistics for the public demo and the landing page — off unless VISIT_STATS=true.

WHAT THIS ANSWERS. How many people looked at kp-front.ch, how many opened the demo, and
which parts of the demo they actually used. Nothing else. There is no per-hit table, no
session, no cookie, no localStorage, no geo lookup and no third party: two aggregate tables
(``visit_stats`` — the record — and ``visit_hashes``, a day's scratch space for deduping
uniques) written by this module and read by ``app/admin_visits.py``.

⚠️ TWO GATES, AND BOTH ARE LOAD-BEARING.

1. ``VISIT_STATS`` is off by default. Stations run this exact code; analytics must never be
   silently on for them, so «unset» has to mean «record nothing», not «record locally». Only
   the demo's Railway project sets the flag. The landing beacon posts to the DEMO host, so a
   station's own deployment is not involved in the landing figures at all.
2. The landing beacon is only accepted from :data:`BEACON_ORIGINS`. A hit posted from
   anywhere else is dropped without a counter moving.

HOW A UNIQUE IS COUNTED WITHOUT IDENTIFYING ANYBODY. ``HMAC(SECRET_KEY, "visit-salt" +
YYYY-MM-DD)`` over ``IP ‖ User-Agent``. The salt rotates at midnight UTC and is never
written down, so the same visitor on two days produces two unrelated hashes — cross-day
tracking is not something this system declines to do, it is something it cannot do. The raw
IP and User-Agent exist only as locals inside :func:`_visitor`; neither is stored and
neither is logged (uvicorn's access log does not carry the UA, and see main.py's
``RedactSecretsInUrls`` for what does reach a log line).

WHY THE WRITE IS INLINE. One INSERT … ON CONFLICT into each table per counted request, on a
box that serves a handful of visitors an hour. A background queue would be more machinery
than the thing it batches. Failures are swallowed: a counter must never turn into a 500 on
a page the visitor came to read.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
from datetime import UTC, date, datetime, timedelta
from typing import Any, cast

from sqlalchemy import Delete, delete, select
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .config import settings
from .database import async_session_maker, execute_dml
from .models import VisitHash, VisitStat

logger = logging.getLogger(__name__)

#: How long the per-day dedup rows survive. They are inert after their own day (the salt is
#: gone), so this is housekeeping, not a privacy control — ``visit_stats`` is the record and
#: is never pruned.
RETAIN_DAYS = 90

#: Origins whose landing beacon is accepted. The published site and its local preview; a
#: self-hoster's copy of the page counts nothing anywhere, which is the intended behaviour.
BEACON_ORIGINS = ("https://kp-front.ch", "https://www.kp-front.ch", "http://localhost:4173")

#: Which landing page was read. One key per built locale (site/content/config.json) plus the
#: shared 404. A closed set: the beacon names a key, and a key that is not in here is dropped.
PAGE_KEYS = frozenset({"de", "fr", "it", "en", "404"})

#: The demo's main surfaces, as the app itself names them (IncidentWorkspace · `mode`), plus
#: the entry screens the SPA reaches before an Einsatz is open. Closed set, same rule.
FEATURE_KEYS = frozenset(
    {
        # rail surfaces — the beacon from the demo SPA
        "lage",
        "plan",
        "checklisten",
        "atemschutz",
        "anwesenheit",
        "mittel",
        "rapport",
        # server-visible buckets — the middleware below
        "adresssuche",
        "ansicht-teilen",
        "drucken",
        "erfassung",
        "fahrzeuge",
        "objektplaene",
        "personal",
        "rapport-pdf",
        "referenzdaten",
        "replay",
        "sicherung",
        "sprachnotiz",
        "standort-teilen",
        "transkription",
        "umrisse",
        "verlauf",
        "verwaltung",
        "wetter",
        "zeitplan-pdf",
    }
)

#: Path fragment → bucket, checked in order, first match wins; everything else counts
#: nothing. Deliberately coarse and deliberately partial: this map exists to say which
#: FEATURES got used, so the alarm intakes, the health probes, the admin login, the audit
#: event firehose and the stats export are all absent on purpose rather than by oversight.
#: Matched against the path with ``/api`` already stripped.
_ROUTE_BUCKETS: tuple[tuple[str, str], ...] = (
    # Router prefixes first: a capture-surface journal write is «somebody used Erfassung»,
    # not «somebody used the Verlauf», so the surface has to win over the suffix below.
    ("/capture", "erfassung"),
    ("/incident-link", "ansicht-teilen"),
    ("/traccar", "fahrzeuge"),
    ("/overpass", "umrisse"),
    ("/weather", "wetter"),
    ("/geocode", "adresssuche"),
    ("/objects", "objektplaene"),
    ("/personnel", "personal"),
    ("/reference", "referenzdaten"),
    ("/station-workbook", "sicherung"),
    ("/plan-scales", "verwaltung"),
    ("/branding", "verwaltung"),
    ("/integrations", "verwaltung"),
    ("/system", "verwaltung"),
    # …then the suffixes that hang off /incidents/{id} and /media/{id}.
    ("/report/pdf", "rapport-pdf"),
    ("/zeitplan/pdf", "zeitplan-pdf"),
    ("/report/print", "drucken"),
    ("/zeitplan/print", "drucken"),
    ("/transcribe", "transkription"),
    ("/transcription", "transkription"),
    ("/media", "sprachnotiz"),
    ("/journal", "verlauf"),
    ("/positions", "standort-teilen"),
    ("/snapshot", "replay"),
    ("/state", "replay"),
    ("/samples", "replay"),
)

#: A referrer is the one value a visitor controls, so it is clamped to a plausible hostname
#: before it can become a key. Anything else is dropped rather than truncated — half a
#: hostname is not a fact.
_HOSTNAME = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,62}[a-z0-9])?$")

#: …and even a well-formed hostname is only counted while the day still has room, so a
#: script cannot turn the referrer bucket into free-text storage by inventing subdomains.
#: In-memory and per process, which is enough: a restart forgets the count, not the cap.
_MAX_REFERRERS_PER_DAY = 200
_referrer_seen: dict[date, set[str]] = {}

#: Overridable so the tests (and only the tests) can point the middleware at their own
#: database — it writes outside the request's ``get_db`` session, the same way the token
#: blocklist does.
_session_factory: async_sessionmaker[AsyncSession] = async_session_maker


def enabled() -> bool:
    """The first gate. Read per call, so a test's ``monkeypatch.setattr`` takes effect."""
    return settings.visit_stats


def today() -> date:
    return datetime.now(UTC).date()


def _salt(day: date) -> bytes:
    """The day's salt. Derived, never stored, and gone the moment the date rolls over."""
    return hmac.new(
        settings.secret_key.encode(),
        f"visit-salt{day.isoformat()}".encode(),
        hashlib.sha256,
    ).digest()


def _client_ip(request) -> str:
    """The visitor's address as this deployment can best see it.

    Behind Railway's edge (and any other reverse proxy) the socket peer is the proxy, so the
    left-most ``X-Forwarded-For`` entry is the visitor. It is spoofable — which for a counter
    means somebody could inflate their own uniques, and nothing worse. The value never leaves
    this function; it goes into a hash and is dropped.
    """
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "") or "-"


def _visitor(request, day: date) -> str:
    """IP + User-Agent under the day's salt, truncated. Neither input survives this call."""
    material = f"{_client_ip(request)}\n{request.headers.get('user-agent', '')[:200]}"
    return hmac.new(_salt(day), material.encode(), hashlib.sha256).hexdigest()[:32]


def bucket_for(path: str) -> str | None:
    """The feature bucket an API path belongs to, or None for the majority that count nothing."""
    if not path.startswith(f"{settings.api_prefix}/"):
        return None
    rest = path[len(settings.api_prefix) :]
    for fragment, key in _ROUTE_BUCKETS:
        if fragment in rest:
            return key
    return None


def clamp_referrer(referrer: str | None) -> str | None:
    """A referring URL reduced to its bare hostname, or None if it is not one.

    ``https://news.example.org/2026/artikel?x=1`` → ``news.example.org``. The path and query
    are where a referrer carries something about the person who followed the link, so they
    never reach the database; our own origins are dropped too (they are navigation, not a
    referral).
    """
    if not referrer:
        return None
    host = referrer.strip().lower()
    if "://" in host:
        # Only the web schemes. `android-app://com.example/` and friends leave something
        # dot-shaped behind that is a package name, not a host — counting it as one would put
        # a wrong fact in the table.
        scheme, _, host = host.partition("://")
        if scheme not in {"http", "https"}:
            return None
    host = host.split("/")[0].split("?")[0].split("@")[-1].split(":")[0]
    if not _HOSTNAME.match(host) or "." not in host:
        return None
    if host in {"kp-front.ch", "www.kp-front.ch", "demo.kp-front.ch"}:
        return None
    return host


def referrer_allowed(day: date, host: str) -> bool:
    """Whether this day still has room for a new referring host (see _MAX_REFERRERS_PER_DAY)."""
    seen = _referrer_seen.setdefault(day, set())
    if host in seen:
        return True
    if len(seen) >= _MAX_REFERRERS_PER_DAY:
        return False
    seen.add(host)
    return True


def _dialect_insert(dialect: str) -> Any:
    """The dialect's own ``insert`` — ``ON CONFLICT`` is not in core SQLAlchemy, and the suite
    runs on SQLite when no Postgres is around and on Postgres in CI. Both spell it the same."""
    if dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as sqlite_insert

        return sqlite_insert
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    return pg_insert


async def record(kind: str, key: str, request, *, day: date | None = None) -> None:
    """Count one hit. Never raises — a counter is not allowed to break a page.

    ``uniques`` is incremented exactly when the visitor's hash was new for this day, key and
    kind, which is decided by whether the ``visit_hashes`` insert actually inserted a row.
    That keeps the figure exact without a read-time join and without ``visit_hashes`` having
    to survive: pruning it later cannot change a number already counted.
    """
    if not enabled():
        return
    day = day or today()
    try:
        visitor = _visitor(request, day)
        async with _session_factory() as db:
            insert = _dialect_insert(db.bind.dialect.name if db.bind is not None else "postgresql")
            claim = (
                insert(VisitHash)
                .values(day=day, kind=kind, key=key, visitor=visitor)
                .on_conflict_do_nothing(index_elements=["day", "kind", "key", "visitor"])
            )
            is_new = cast("CursorResult[Any]", await db.execute(claim)).rowcount == 1
            await db.execute(
                insert(VisitStat)
                .values(day=day, kind=kind, key=key, hits=1, uniques=1 if is_new else 0)
                .on_conflict_do_update(
                    index_elements=["day", "kind", "key"],
                    set_={
                        "hits": VisitStat.__table__.c.hits + 1,
                        "uniques": VisitStat.__table__.c.uniques + (1 if is_new else 0),
                    },
                )
            )
            await db.commit()
    except Exception:  # noqa: BLE001 — a statistic is never worth a failed request
        logger.warning("visit stats: recording %s/%s failed", kind, key, exc_info=True)


def prune_statement(before: date | None = None) -> Delete:
    """DELETE for the dedup rows that are past :data:`RETAIN_DAYS`. ``visit_stats`` stays."""
    cutoff = before or (today() - timedelta(days=RETAIN_DAYS))
    return delete(VisitHash).where(VisitHash.day < cutoff)


async def prune(db: AsyncSession) -> int:
    result = await execute_dml(db, prune_statement())
    _referrer_seen.clear()
    return result.rowcount or 0


async def read(db: AsyncSession, days: int = 30) -> list[VisitStat]:
    """The aggregates for the last ``days`` days, newest day first, then kind and key."""
    since = today() - timedelta(days=max(1, days) - 1)
    rows = await db.execute(
        select(VisitStat).where(VisitStat.day >= since).order_by(VisitStat.day.desc(), VisitStat.kind, VisitStat.key)
    )
    return list(rows.scalars().all())

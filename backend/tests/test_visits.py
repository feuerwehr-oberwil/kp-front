"""Visit statistics: the flag, the beacon's allowlists, and what a unique actually is.

The load-bearing test in here is `test_flag_off_records_nothing` — stations run this same
code, so «off» has to mean «not a single row», not «a smaller number».
"""

from datetime import date, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import select

from app import visits
from app.config import settings
from app.models import VisitHash, VisitStat


class _FakeRequest:
    """Just the two headers `visits` reads, plus a client address."""

    def __init__(self, ip: str = "198.51.100.7", ua: str = "Mozilla/5.0 (Test)") -> None:
        self.headers = {"user-agent": ua}
        self.client = type("C", (), {"host": ip})()


@pytest_asyncio.fixture
async def counting(session_factory, monkeypatch):
    """VISIT_STATS on, and the recorder pointed at the test database."""
    monkeypatch.setattr(settings, "visit_stats", True)
    monkeypatch.setattr(visits, "_session_factory", session_factory)
    visits._referrer_seen.clear()
    yield
    visits._referrer_seen.clear()


async def _rows(db, model=VisitStat) -> list:
    return list((await db.execute(select(model))).scalars().all())


# --- the flag -------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_flag_off_records_nothing(session_factory, monkeypatch, db_session):
    """The default. A station's deployment must not write a single row."""
    monkeypatch.setattr(settings, "visit_stats", False)
    monkeypatch.setattr(visits, "_session_factory", session_factory)

    await visits.record("demo", "app", _FakeRequest())

    assert await _rows(db_session) == []
    assert await _rows(db_session, VisitHash) == []


@pytest.mark.asyncio
async def test_beacon_is_a_noop_while_the_flag_is_off(client, session_factory, monkeypatch, db_session):
    monkeypatch.setattr(settings, "visit_stats", False)
    monkeypatch.setattr(visits, "_session_factory", session_factory)

    r = await client.post("/api/hit", content=b'{"kind":"page","key":"de"}')

    assert r.status_code == 204  # never a message, on or off
    assert await _rows(db_session) == []


# --- hits vs uniques ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_one_client_reloading_is_many_hits_and_one_unique(counting, db_session):
    """The acceptance criterion from the plan: 50 reloads = 50 hits / 1 unique."""
    for _ in range(50):
        await visits.record("demo", "app", _FakeRequest())

    (row,) = await _rows(db_session)
    assert (row.kind, row.key, row.hits, row.uniques) == ("demo", "app", 50, 1)


@pytest.mark.asyncio
async def test_a_second_client_is_a_second_unique(counting, db_session):
    await visits.record("demo", "app", _FakeRequest(ip="198.51.100.7"))
    await visits.record("demo", "app", _FakeRequest(ip="203.0.113.9"))
    await visits.record("demo", "app", _FakeRequest(ip="198.51.100.7", ua="Other/1.0"))

    (row,) = await _rows(db_session)
    assert (row.hits, row.uniques) == (3, 3)


@pytest.mark.asyncio
async def test_the_salt_rotates_daily(counting, db_session):
    """Yesterday's hash and today's are unrelated — which is what makes cross-day tracking
    impossible rather than merely unimplemented."""
    today, yesterday = visits.today(), visits.today() - timedelta(days=1)
    request = _FakeRequest()

    assert visits._visitor(request, today) != visits._visitor(request, yesterday)

    await visits.record("demo", "app", request, day=yesterday)
    await visits.record("demo", "app", request, day=today)

    rows = await _rows(db_session)
    assert sorted((r.day, r.uniques) for r in rows) == [(yesterday, 1), (today, 1)]


@pytest.mark.asyncio
async def test_uniques_survive_pruning_the_hashes(counting, db_session):
    """The counter is the record. Sweeping the dedup rows cannot change a counted number."""
    old = visits.today() - timedelta(days=visits.RETAIN_DAYS + 1)
    await visits.record("demo", "app", _FakeRequest(), day=old)

    removed = await visits.prune(db_session)
    await db_session.commit()

    assert removed == 1
    assert await _rows(db_session, VisitHash) == []
    (row,) = await _rows(db_session)
    assert (row.hits, row.uniques) == (1, 1)


# --- the beacon's allowlists ----------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        b'{"kind":"page","key":"ru"}',  # not a built locale
        b'{"kind":"feature","key":"einsatzliste"}',  # not a rail surface
        b'{"kind":"demo","key":"app"}',  # only the server may write a demo visit
        b'{"kind":"page","key":"../../etc/passwd"}',
        b'{"kind":"page"}',
        b"not json at all",
        b"[]",
    ],
)
async def test_beacon_rejects_anything_off_the_allowlist(client, counting, db_session, body):
    r = await client.post("/api/hit", content=body)

    assert r.status_code == 204  # it never says why
    assert await _rows(db_session) == []


@pytest.mark.asyncio
async def test_beacon_counts_a_known_page(client, counting, db_session):
    r = await client.post("/api/hit", content=b'{"kind":"page","key":"fr"}')

    assert r.status_code == 204
    (row,) = await _rows(db_session)
    assert (row.kind, row.key, row.hits) == ("page", "fr", 1)


@pytest.mark.asyncio
async def test_beacon_from_a_foreign_origin_counts_nothing(client, counting, db_session):
    r = await client.post(
        "/api/hit",
        content=b'{"kind":"page","key":"de"}',
        headers={"origin": "https://not-us.example"},
    )

    assert r.status_code == 204
    assert "access-control-allow-origin" not in r.headers
    assert await _rows(db_session) == []


@pytest.mark.asyncio
async def test_beacon_from_the_landing_page_is_allowed_and_gets_its_cors_header(client, counting, db_session):
    r = await client.post(
        "/api/hit",
        content=b'{"kind":"page","key":"de"}',
        headers={"origin": "https://kp-front.ch"},
    )

    assert r.headers["access-control-allow-origin"] == "https://kp-front.ch"
    assert [(x.kind, x.key) for x in await _rows(db_session)] == [("page", "de")]


@pytest.mark.asyncio
async def test_an_oversized_body_counts_nothing(client, counting, db_session):
    r = await client.post("/api/hit", content=b'{"kind":"page","key":"de","x":"' + b"a" * 600 + b'"}')

    assert r.status_code == 204
    assert await _rows(db_session) == []


# --- referrers ------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("referrer", "expected"),
    [
        ("https://news.example.org/2026/artikel?utm=x", "news.example.org"),
        ("http://Forum.Example.ORG:8080/thread/12", "forum.example.org"),
        ("https://kp-front.ch/fr/", None),  # our own page is navigation, not a referral
        ("https://demo.kp-front.ch/", None),
        ("android-app://com.example/", None),  # no dot-bearing hostname survives the clamp
        ("not a url", None),
        ("", None),
        (None, None),
    ],
)
async def test_a_referrer_is_reduced_to_a_bare_hostname(referrer, expected):
    assert visits.clamp_referrer(referrer) == expected


@pytest.mark.asyncio
async def test_a_page_hit_records_its_referring_host(client, counting, db_session):
    await client.post(
        "/api/hit",
        content=b'{"kind":"page","key":"de","referrer":"https://news.example.org/artikel"}',
    )

    assert sorted((r.kind, r.key) for r in await _rows(db_session)) == [
        ("page", "de"),
        ("referrer", "news.example.org"),
    ]


def test_the_referrer_bucket_is_capped_per_day():
    """A visitor controls this value, so it must not become free-text storage."""
    day = date(2026, 8, 19)
    visits._referrer_seen.clear()

    accepted = [f"h{i}.example.org" for i in range(visits._MAX_REFERRERS_PER_DAY + 50)]
    allowed = [h for h in accepted if visits.referrer_allowed(day, h)]

    assert len(allowed) == visits._MAX_REFERRERS_PER_DAY
    assert visits.referrer_allowed(day, allowed[0])  # one already counted still is
    visits._referrer_seen.clear()


# --- the route bucket map -------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "bucket"),
    [
        ("/api/incidents/abc/journal", "verlauf"),
        ("/api/incidents/abc/report/pdf", "rapport-pdf"),
        ("/api/media/xyz/transcribe", "transkription"),
        ("/api/traccar/positions", "fahrzeuge"),
        ("/api/capture/incidents", "erfassung"),
        ("/api/capture/incidents/abc/journal", "erfassung"),  # the surface wins over the suffix
        ("/api/overpass/buildings", "umrisse"),
        # counts nothing, all on purpose
        ("/api/alarms", None),
        ("/api/divera/webhook", None),
        ("/api/admin/login", None),
        ("/api/incidents/abc/events", None),
        ("/api/stats/incidents", None),
        ("/health", None),
        ("/", None),
    ],
)
def test_route_buckets(path, bucket):
    assert visits.bucket_for(path) == bucket


def test_every_bucket_the_map_can_produce_is_an_allowed_key():
    """The map and the allowlist must not drift — a bucket the beacon would reject is a
    counter nobody can read back consistently."""
    assert {key for _, key in visits._ROUTE_BUCKETS} <= visits.FEATURE_KEYS


# --- what the middleware counts -------------------------------------------------------


@pytest.mark.asyncio
async def test_middleware_counts_a_feature_but_not_the_probes(client, counting, db_session, editor):
    from tests.conftest import TEST_PIN

    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": TEST_PIN})
    await client.get("/health")
    assert (await client.get("/api/personnel")).status_code == 200

    kinds = {(r.kind, r.key) for r in await _rows(db_session)}
    assert ("feature", "personal") in kinds
    assert not any(k == "demo" for k, _ in kinds)  # no SPA build under test → no shell


# --- the admin read -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_numbers_are_admin_only(client, counting):
    assert (await client.get("/api/admin/visits")).status_code == 401


@pytest.mark.asyncio
async def test_admin_reads_the_aggregates(client, counting, admin_login):
    await visits.record("feature", "atemschutz", _FakeRequest())
    await visits.record("feature", "atemschutz", _FakeRequest(ip="203.0.113.9"))
    await admin_login(client)

    body = (await client.get("/api/admin/visits?days=7")).json()

    assert body["enabled"] is True
    assert body["rows"] == [
        {"day": visits.today().isoformat(), "kind": "feature", "key": "atemschutz", "hits": 2, "uniques": 2}
    ]


@pytest.mark.asyncio
async def test_the_read_says_when_nothing_is_counting(client, session_factory, monkeypatch, admin_login):
    """An all-zero month with the flag off is not the same fact as a quiet month."""
    monkeypatch.setattr(settings, "visit_stats", False)
    monkeypatch.setattr(visits, "_session_factory", session_factory)
    await admin_login(client)

    body = (await client.get("/api/admin/visits")).json()

    assert body == {"enabled": False, "days": 30, "rows": []}

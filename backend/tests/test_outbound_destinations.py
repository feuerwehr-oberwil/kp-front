"""Where this server is allowed to send outbound requests: report tiles and Web Push.

Two caller-chosen destinations reach the network from a logged-in request: the Kroki's base
tile template (``KrokiIn.tiles``, rendered server-side) and a browser's Web-Push endpoint.
Both used to be arbitrary strings, which made the app a request forwarder from its own
network position. These tests pin the policy in `app/egress.py` and its two callers.

No test here touches a real network: the tile fetcher runs against an `httpx.MockTransport`
and the push sender against a stubbed `pywebpush`.
"""

import io
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from PIL import Image

from app import kroki as kk
from app.report_pdf import ReportPayload, warm_report_tiles

CARTO = "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"
SWISSTOPO = "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg"
LOOPBACK = "http://127.0.0.1:9999/{z}/{x}/{y}.png"


@pytest.fixture(autouse=True)
def _no_resolver(monkeypatch: pytest.MonkeyPatch):
    """The push policy asks the resolver; these tests answer for it. Nothing here — not even a
    DNS lookup — leaves the machine, and a test cannot pass or fail on a developer's network."""
    from app import egress

    monkeypatch.setattr(egress, "_resolved_addresses", lambda host: ["93.184.216.34"])


def _png(color: str = "#abcdef", size: int = 256) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (size, size), color).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def tile_transport(monkeypatch: pytest.MonkeyPatch, tmp_path):
    """Record every tile request the compositor makes, and answer it from memory.

    Patches `httpx.Client.__init__` (the `mock_http` pattern in test_admin_cli_visits_branding)
    because `render_base` builds its own client. The tile cache is redirected into tmp_path so
    a run cannot read — or poison — the developer's real cache.
    """

    def _install(handler):
        seen: list[httpx.Request] = []

        def recording(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return handler(request)

        transport = httpx.MockTransport(recording)
        orig_init = httpx.Client.__init__

        def patched_init(self, *args, **kwargs):
            kwargs["transport"] = transport
            orig_init(self, *args, **kwargs)

        monkeypatch.setattr(httpx.Client, "__init__", patched_init)
        monkeypatch.setattr(kk, "_TILE_CACHE", kk.TileCache(tmp_path / "tilecache"))
        return seen

    return _install


def _payload(tiles: str) -> ReportPayload:
    return ReportPayload.model_validate(
        {
            "incident": {"title": "T", "id": "i"},
            "generatedAt": "n",
            "kroki": {
                "entities": [{"coord": [7.556, 47.5139], "symbol": "VKF Feuer"}],
                "drawings": [],
                "tiles": tiles,
            },
        }
    )


# --- tiles: only known providers -----------------------------------------------------------


def test_a_caller_chosen_destination_never_reaches_the_transport(tile_transport):
    """SEC-03: the report composer is open to every logged-in user and to the capture token."""
    seen = tile_transport(lambda _r: httpx.Response(200, content=_png()))
    warm_report_tiles(_payload(LOOPBACK))
    assert seen == [], "a caller-supplied tile template must not be fetched"


@pytest.mark.parametrize(
    "tiles",
    [
        "http://198.51.100.9/{z}/{x}/{y}.png",  # plain http, public host
        "https://evil.example.com/{z}/{x}/{y}.png",  # https, unknown provider
        "https://a.basemaps.cartocdn.com.evil.example/{z}/{x}/{y}.png",  # suffix lookalike
        "https://a.basemaps.cartocdn.com:8443/{z}/{x}/{y}.png",  # off-port
        "https://user:pw@a.basemaps.cartocdn.com/{z}/{x}/{y}.png",  # credentials in the URL
        "file:///etc/passwd",
    ],
)
def test_forbidden_tile_destinations_are_refused(tile_transport, tiles):
    seen = tile_transport(lambda _r: httpx.Response(200, content=_png()))
    warm_report_tiles(_payload(tiles))
    assert seen == []


def test_only_the_zxy_slots_may_appear_in_a_template(tile_transport):
    """The template is `.format()`ed — a stray field would either raise or reach into objects."""
    seen = tile_transport(lambda _r: httpx.Response(200, content=_png()))
    warm_report_tiles(_payload("https://a.basemaps.cartocdn.com/{z.__class__}/{x}/{y}.png"))
    assert seen == []


@pytest.mark.parametrize("tiles", [CARTO, SWISSTOPO, "https://tile.openstreetmap.org/{z}/{x}/{y}.png"])
def test_the_deployments_own_basemaps_still_render(tile_transport, tiles):
    seen = tile_transport(lambda _r: httpx.Response(200, content=_png(), headers={"content-type": "image/png"}))
    warm_report_tiles(_payload(tiles))
    assert seen, "an approved provider must still be fetched"
    assert all(str(r.url).startswith(tiles.split("{")[0]) for r in seen)


def test_an_approved_host_that_resolves_inward_is_refused(tile_transport, monkeypatch):
    """SEC-03 (05.09.): the provider table pins the NAME, but a name that resolves to 10.x is
    still an internal target. Validation resolves the approved host, so a poisoned/rebound CARTO
    host prints a grey base instead of fetching from the server's own network position."""
    from app import egress

    monkeypatch.setattr(egress, "_resolved_addresses", lambda host: ["10.0.0.5"])
    seen = tile_transport(lambda _r: httpx.Response(200, content=_png()))
    assert kk.approved_tile_template(CARTO) == "", "an approved host resolving inward must be refused"
    warm_report_tiles(_payload(CARTO))
    assert seen == []


def test_a_malformed_tile_host_is_a_grey_base_not_a_500(tile_transport):
    """SEC-03 (05.09.): an unclosed IPv6 bracket used to raise a bare ValueError out of
    `require_public_https` — a 500 on the report path. A bad authority is a neutral grey base."""
    seen = tile_transport(lambda _r: httpx.Response(200, content=_png()))
    assert kk.approved_tile_template("https://[1:2:3/{z}/{x}/{y}.png") == ""
    view = kk.center_view((7.55, 47.51), 17, 320, 200)
    img = kk.render_base(view, kk.approved_tile_template("https://[1:2:3/{z}/{x}/{y}.png"))
    assert img.size == (320, 200)
    assert seen == []


def test_a_refused_source_still_prints_a_kroki(tile_transport):
    """A basemap this server does not know is a grey base, not a failed Rapport: the drawings
    and symbols on top are the part of the sheet nobody can redraw by hand."""
    tile_transport(lambda _r: httpx.Response(200, content=_png()))
    view = kk.center_view((7.55, 47.51), 17, 320, 200)
    img = kk.render_base(view, kk.approved_tile_template(LOOPBACK))
    assert img.size == (320, 200)


# --- tiles: the transport itself -----------------------------------------------------------


def test_a_redirect_is_never_followed(tile_transport):
    seen = tile_transport(
        lambda r: (
            httpx.Response(302, headers={"location": "http://127.0.0.1:9999/steal.png"})
            if "cartocdn" in str(r.url)
            else httpx.Response(200, content=_png())
        )
    )
    warm_report_tiles(_payload(CARTO))
    assert seen, "the approved provider is asked"
    assert all("cartocdn" in str(r.url) for r in seen), "the redirect target must not be fetched"


def test_an_oversized_tile_is_dropped_and_never_cached(tile_transport, tmp_path):
    big = b"\x89PNG\r\n\x1a\n" + b"x" * (kk.MAX_TILE_BYTES + 1)
    tile_transport(lambda _r: httpx.Response(200, content=big, headers={"content-type": "image/png"}))
    cache = kk.TileCache(tmp_path / "cap")
    view = kk.center_view((7.55, 47.51), 17, 256, 256)
    kk.render_base(view, kk.approved_tile_template(CARTO), cache=cache)
    assert list(cache.dir.iterdir()) == [], "an oversized body must not be written to the tile cache"


def test_a_non_image_answer_is_dropped(tile_transport, tmp_path):
    tile_transport(
        lambda _r: httpx.Response(200, content=b'{"secret": 1}', headers={"content-type": "application/json"})
    )
    cache = kk.TileCache(tmp_path / "ct")
    view = kk.center_view((7.55, 47.51), 17, 256, 256)
    kk.render_base(view, kk.approved_tile_template(CARTO), cache=cache)
    assert list(cache.dir.iterdir()) == []


def test_the_tile_cache_stays_bounded(tmp_path):
    cache = kk.TileCache(tmp_path / "bounded", max_entries=8)
    for i in range(40):
        cache.put(f"https://a.basemaps.cartocdn.com/x/{i}.png", b"tile")
    assert len(list(cache.dir.iterdir())) <= 8


# --- Web Push: destinations ----------------------------------------------------------------


async def _login(client, user):
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


def _sub(endpoint: str) -> dict:
    return {"endpoint": endpoint, "keys": {"p256dh": "k1", "auth": "a1"}}


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/fcm/send/abc",  # not https
        "https://127.0.0.1/wpush/v2/abc",  # loopback
        "https://[::1]/wpush/v2/abc",
        "https://10.0.0.5/wpush/v2/abc",  # RFC1918
        "https://169.254.169.254/latest/meta-data/",  # cloud metadata
        "https://localhost/wpush/v2/abc",
        "https://intranet/wpush/v2/abc",  # bare LAN name
        "https://printer.local/wpush/v2/abc",
        "https://push.example:8443/wpush/v2/abc",  # off-port
        "ws://push.example/wpush/v2/abc",
    ],
)
async def test_a_push_endpoint_off_the_public_internet_is_refused(client, editor, endpoint):
    """SEC-09: the endpoint is posted to by the server, so it is an outbound destination."""
    await _login(client, editor)
    r = await client.post("/api/push/subscriptions", json=_sub(endpoint))
    assert r.status_code == 422, endpoint


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://fcm.googleapis.com/fcm/send/cQ1abc",
        "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
        "https://web.push.apple.com/QCw8s",
        "https://sg2p.notify.windows.com/w/?token=abc",
    ],
)
async def test_a_real_push_service_registers(client, editor, endpoint):
    await _login(client, editor)
    assert (await client.post("/api/push/subscriptions", json=_sub(endpoint))).status_code == 201


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://fcm.googleapis.com/fcm/send/cQ1abc",
        "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
        "https://web.push.apple.com/QCw8s",
        "https://sg2p.notify.windows.com/w/?token=abc",
    ],
)
async def test_a_real_push_service_is_delivered_to(db_session, monkeypatch, endpoint):
    """SEC-09: the four major browser push services are the built-in allowlist and must send."""
    import pywebpush

    from app.models import PushSubscription
    from app.push import broadcast

    db_session.add(PushSubscription(endpoint=endpoint, p256dh="k", auth="a"))
    await db_session.commit()

    delivered: list[str] = []
    monkeypatch.setattr(
        pywebpush, "webpush", lambda subscription_info, **_kw: delivered.append(subscription_info["endpoint"])
    )
    await broadcast(db_session, title="T", body="B", tag="t", target="")
    assert delivered == [endpoint]


async def test_an_arbitrary_public_host_is_refused_at_registration(client, editor):
    """SEC-09: public-HTTPS is not enough — an arbitrary public host would make the alarm sender
    a request forwarder, so a host that is not a known push service is a 422 at registration."""
    await _login(client, editor)
    r = await client.post("/api/push/subscriptions", json=_sub("https://evil.example.com/push"))
    assert r.status_code == 422


async def test_an_arbitrary_public_host_is_filtered_at_send(db_session, monkeypatch):
    """SEC-09: the send path re-checks the allowlist, so a row written before the policy (or by an
    older release) whose endpoint is an arbitrary public host is never POSTed to."""
    import pywebpush

    from app.models import PushSubscription
    from app.push import broadcast

    db_session.add(PushSubscription(endpoint="https://evil.example.com/push", p256dh="k", auth="a"))
    db_session.add(PushSubscription(endpoint="https://fcm.googleapis.com/fcm/send/ok", p256dh="k", auth="a"))
    await db_session.commit()

    delivered: list[str] = []
    monkeypatch.setattr(
        pywebpush, "webpush", lambda subscription_info, **_kw: delivered.append(subscription_info["endpoint"])
    )
    await broadcast(db_session, title="T", body="B", tag="t", target="")
    assert delivered == ["https://fcm.googleapis.com/fcm/send/ok"]


async def test_an_admin_allowlisted_host_is_accepted(client, editor, db_session, monkeypatch):
    """SEC-09: a station running its own push service adds its host through PUSH_EXTRA_HOSTS — an
    env setting, whoever runs the deployment, never a caller. Both gates honour it."""
    import pywebpush

    from app.config import settings
    from app.push import broadcast

    monkeypatch.setattr(settings, "push_extra_hosts", "push.mystation.ch")
    endpoint = "https://push.mystation.ch/wpush/v2/x"

    await _login(client, editor)
    assert (await client.post("/api/push/subscriptions", json=_sub(endpoint))).status_code == 201

    delivered: list[str] = []
    monkeypatch.setattr(
        pywebpush, "webpush", lambda subscription_info, **_kw: delivered.append(subscription_info["endpoint"])
    )
    await broadcast(db_session, title="T", body="B", tag="t", target="")
    assert delivered == [endpoint]


async def test_a_percent_encoded_arbitrary_host_cannot_slip_past(client, editor, db_session, monkeypatch):
    """SEC-09 (05.09.): the allowlist judges the DECODED host — `%65vil.example.com` normalises to
    `evil.example.com` at the transport, so it is refused at registration and filtered at send
    rather than smuggled past as an opaque encoded name."""
    import pywebpush

    from app.models import PushSubscription
    from app.push import broadcast

    encoded = "https://%65vil.example.com/push"
    await _login(client, editor)
    assert (await client.post("/api/push/subscriptions", json=_sub(encoded))).status_code == 422

    db_session.add(PushSubscription(endpoint=encoded, p256dh="k", auth="a"))
    db_session.add(PushSubscription(endpoint="https://fcm.googleapis.com/fcm/send/ok", p256dh="k", auth="a"))
    await db_session.commit()
    delivered: list[str] = []
    monkeypatch.setattr(
        pywebpush, "webpush", lambda subscription_info, **_kw: delivered.append(subscription_info["endpoint"])
    )
    await broadcast(db_session, title="T", body="B", tag="t", target="")
    assert delivered == ["https://fcm.googleapis.com/fcm/send/ok"]


async def test_a_resolvable_name_pointing_inside_is_refused(client, editor, monkeypatch):
    """DNS is the other half of the destination: a public NAME may still answer with 10.x."""
    from app import egress

    monkeypatch.setattr(egress, "_resolved_addresses", lambda host: ["10.1.2.3"])
    await _login(client, editor)
    r = await client.post("/api/push/subscriptions", json=_sub("https://rebind.example/wpush/v2/x"))
    assert r.status_code == 422


async def test_a_percent_encoded_loopback_is_refused_at_registration(client, editor, monkeypatch):
    """SEC-09 (05.09.): `%31%32%37.0.0.1` resolves as a literal NAME to nothing (empty DNS was
    accepted), and `requests` later normalises it to 127.0.0.1. The host is percent-DECODED
    before the policy runs, so it is judged as the loopback it becomes."""
    from app import egress

    monkeypatch.setattr(egress, "_resolved_addresses", lambda host: [])  # the crafted name resolves to nothing
    await _login(client, editor)
    r = await client.post("/api/push/subscriptions", json=_sub("https://%31%32%37.0.0.1/wpush/v2/x"))
    assert r.status_code == 422


async def test_a_stored_encoded_loopback_is_never_sent_to(db_session, monkeypatch):
    """SEC-09 (05.09.): the send path DECODES too, so a row written before the policy (or by an
    older release) whose endpoint hides loopback behind percent-encoding is filtered out at send,
    not POSTed to 127.0.0.1."""
    import pywebpush

    from app.models import PushSubscription
    from app.push import broadcast

    db_session.add(PushSubscription(endpoint="https://%31%32%37.0.0.1/wpush/v2/x", p256dh="k", auth="a"))
    db_session.add(PushSubscription(endpoint="https://fcm.googleapis.com/fcm/send/ok", p256dh="k", auth="a"))
    await db_session.commit()

    delivered: list[str] = []
    monkeypatch.setattr(
        pywebpush, "webpush", lambda subscription_info, **_kw: delivered.append(subscription_info["endpoint"])
    )
    await broadcast(db_session, title="T", body="B", tag="t", target="")
    assert delivered == ["https://fcm.googleapis.com/fcm/send/ok"]


# --- Web Push: quota, ownership, delivery --------------------------------------------------


async def _count(db) -> int:
    from sqlalchemy import select

    from app.models import PushSubscription

    return len((await db.execute(select(PushSubscription))).scalars().all())


async def test_one_browser_cannot_fill_the_table(client, editor, db_session):
    from app.api.push import MAX_SUBSCRIPTIONS_PER_USER

    await _login(client, editor)
    for i in range(MAX_SUBSCRIPTIONS_PER_USER + 4):
        r = await client.post("/api/push/subscriptions", json=_sub(f"https://fcm.googleapis.com/fcm/send/d{i}"))
        assert r.status_code == 201
    assert await _count(db_session) == MAX_SUBSCRIPTIONS_PER_USER


async def test_a_user_cannot_take_over_another_users_subscription(client, editor, viewer, db_session):
    from sqlalchemy import select

    from app.models import PushSubscription

    endpoint = "https://fcm.googleapis.com/fcm/send/shared"
    await _login(client, editor)
    assert (await client.post("/api/push/subscriptions", json=_sub(endpoint))).status_code == 201

    await _login(client, viewer)
    hijack = {"endpoint": endpoint, "keys": {"p256dh": "evil", "auth": "evil"}}
    assert (await client.post("/api/push/subscriptions", json=hijack)).status_code == 403
    # …and cannot delete it either
    assert (await client.request("DELETE", "/api/push/subscriptions", json=hijack)).status_code == 204

    row = (await db_session.execute(select(PushSubscription).where(PushSubscription.endpoint == endpoint))).scalar_one()
    assert row.user_id == editor.id and row.p256dh == "k1"


async def test_a_deactivated_user_gets_no_alarm_push(db_session, monkeypatch):
    import pywebpush

    from app.models import PushSubscription, User
    from app.push import broadcast

    gone = User(username="weg", pin_hash="x", role="editor", display_name="Weg", is_active=False)
    db_session.add(gone)
    await db_session.flush()
    db_session.add(
        PushSubscription(user_id=gone.id, endpoint="https://fcm.googleapis.com/fcm/send/gone", p256dh="k", auth="a")
    )
    db_session.add(PushSubscription(endpoint="https://fcm.googleapis.com/fcm/send/kiosk", p256dh="k", auth="a"))
    await db_session.commit()

    delivered: list[str] = []
    monkeypatch.setattr(
        pywebpush, "webpush", lambda subscription_info, **_kw: delivered.append(subscription_info["endpoint"])
    )
    sent = await broadcast(db_session, title="T", body="B", tag="t", target="")
    assert delivered == ["https://fcm.googleapis.com/fcm/send/kiosk"]
    assert sent == 1


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://[64:ff9b::7f00:1]/wpush/v2/x",  # NAT64-wrapped 127.0.0.1
        "https://[64:ff9b::a00:5]/wpush/v2/x",  # NAT64-wrapped 10.0.0.5
    ],
)
async def test_a_nat64_wrapped_internal_target_is_refused(client, editor, endpoint):
    """The well-known NAT64 prefix hides an IPv4 destination in its low 32 bits; the IPv6 literal
    reads as global, which slipped a wrapped loopback/private target past the check."""
    await _login(client, editor)
    assert (await client.post("/api/push/subscriptions", json=_sub(endpoint))).status_code == 422, endpoint


def test_nat64_addresses_are_judged_by_their_inner_ipv4():
    from app import egress

    assert egress.is_blocked_host("64:ff9b::7f00:1")  # 127.0.0.1
    assert egress.is_blocked_host("64:ff9b::a00:5")  # 10.0.0.5
    assert not egress.is_blocked_host("64:ff9b::5db8:d822")  # 93.184.216.34, a public host


async def test_absurd_endpoint_or_key_material_is_refused(client, editor):
    """A row is a delivery target, not a store: ~500 KB of «key» was accepted before."""
    await _login(client, editor)
    huge_ep = {"endpoint": "https://fcm.googleapis.com/fcm/send/" + "a" * 4000, "keys": {"p256dh": "k", "auth": "a"}}
    assert (await client.post("/api/push/subscriptions", json=huge_ep)).status_code == 422
    huge_key = {"endpoint": "https://fcm.googleapis.com/fcm/send/x", "keys": {"p256dh": "k" * 4000, "auth": "a"}}
    assert (await client.post("/api/push/subscriptions", json=huge_key)).status_code == 422


async def test_a_logged_in_user_cannot_claim_a_kiosk_subscription(client, editor, db_session):
    """SEC-09: a NULL-owner (kiosk) row's endpoint is that browser's own capability URL. A
    logged-in caller who merely knows it must not overwrite its keys or claim it."""
    from sqlalchemy import select

    from app.models import PushSubscription

    endpoint = "https://fcm.googleapis.com/fcm/send/kioskclaim"
    db_session.add(PushSubscription(endpoint=endpoint, p256dh="kioskkey", auth="kioskauth"))
    await db_session.commit()

    await _login(client, editor)
    assert (await client.post("/api/push/subscriptions", json=_sub(endpoint))).status_code == 403

    db_session.expire_all()
    row = (await db_session.execute(select(PushSubscription).where(PushSubscription.endpoint == endpoint))).scalar_one()
    assert row.user_id is None and row.p256dh == "kioskkey"


def test_push_send_never_follows_a_redirect(monkeypatch):
    """SEC-09: pywebpush's default session follows redirects, so a validated public host that
    answers «301 → http://loopback» would have the body re-POSTed there. The session we hand it
    resolves no redirects at all."""
    import pywebpush

    from app.push import _send_one

    captured: dict = {}

    def fake_webpush(subscription_info, **kw):
        captured["session"] = kw.get("requests_session")

    monkeypatch.setattr(pywebpush, "webpush", fake_webpush)
    _send_one({"endpoint": "https://fcm.googleapis.com/fcm/send/x", "p256dh": "k", "auth": "a"}, "{}")

    session = captured["session"]
    assert session is not None, "a session must be handed to pywebpush, not the default one"
    # A 3xx yields no follow-up request → the encrypted body never reaches the redirect target.
    assert list(session.resolve_redirects(object(), object())) == []


async def test_an_expired_subscription_is_never_delivered_to(db_session, monkeypatch):
    """SEC-09: expiry used to run only when the owner re-registered, so a phone that stopped
    booting the app was still POSTed to for months. Delivery selection excludes it now."""
    import pywebpush

    from app.models import PushSubscription
    from app.push import SUBSCRIPTION_TTL_DAYS, broadcast

    old = datetime.now(UTC) - timedelta(days=SUBSCRIPTION_TTL_DAYS + 1)
    db_session.add(
        PushSubscription(endpoint="https://fcm.googleapis.com/fcm/send/old", p256dh="k", auth="a", created_at=old)
    )
    db_session.add(PushSubscription(endpoint="https://fcm.googleapis.com/fcm/send/fresh", p256dh="k", auth="a"))
    await db_session.commit()

    delivered: list[str] = []
    monkeypatch.setattr(
        pywebpush, "webpush", lambda subscription_info, **_kw: delivered.append(subscription_info["endpoint"])
    )
    await broadcast(db_session, title="T", body="B", tag="t", target="")
    assert delivered == ["https://fcm.googleapis.com/fcm/send/fresh"]


async def test_quota_enforcement_takes_a_user_row_lock(db_session, editor, monkeypatch):
    """SEC-09: concurrent registrations each counted < MAX and both inserted without a lock. The
    count-and-evict runs behind a `FOR UPDATE` read of the user row so a second txn waits."""
    from app.api import push as push_api

    seen: list[str] = []
    orig = db_session.execute

    async def spy(stmt, *a, **k):
        seen.append(str(stmt).lower())
        return await orig(stmt, *a, **k)

    monkeypatch.setattr(db_session, "execute", spy)
    await push_api._enforce_quota(db_session, editor.id, datetime.now(UTC))
    assert any("for update" in s for s in seen), "the count-and-evict must be serialised by a row lock"


async def test_subscribe_locks_the_parent_user_before_inserting(db_session, editor, monkeypatch):
    """SEC-09 (05.09.): on Postgres the child INSERT takes a `KEY SHARE` FK lock on the user row,
    so the quota's `FOR UPDATE` must come BEFORE the insert/flush — two registrations upgrading
    KEY SHARE → FOR UPDATE deadlock otherwise. Pin the ordering by observing the lock and the
    pending PushSubscription flush in the order they hit the session."""
    from app.api.push import SubscriptionIn, subscribe
    from app.models import PushSubscription

    ops: list[str] = []
    orig_execute, orig_flush = db_session.execute, db_session.flush

    async def exec_spy(stmt, *a, **k):
        if "for update" in str(stmt).lower():
            ops.append("lock")
        return await orig_execute(stmt, *a, **k)

    async def flush_spy(*a, **k):
        if "insert" not in ops and any(isinstance(o, PushSubscription) for o in db_session.new):
            ops.append("insert")
        return await orig_flush(*a, **k)

    monkeypatch.setattr(db_session, "execute", exec_spy)
    monkeypatch.setattr(db_session, "flush", flush_spy)

    body = SubscriptionIn.model_validate(_sub("https://fcm.googleapis.com/fcm/send/order"))
    await subscribe(body, editor, db_session)

    assert ops and ops[0] == "lock", f"the user row must be locked before the child insert, saw {ops}"
    assert "insert" in ops and ops.index("lock") < ops.index("insert")


async def test_a_slow_endpoint_cannot_hold_the_sweep_open(db_session, monkeypatch):
    """A broadcast is awaited inline on the alarm path — it needs a wall-clock ceiling of its
    own, not just a per-endpoint timeout multiplied by however many rows exist."""
    import time

    import pywebpush

    from app.models import PushSubscription
    from app.push import broadcast

    for i in range(6):
        db_session.add(PushSubscription(endpoint=f"https://fcm.googleapis.com/fcm/send/slow{i}", p256dh="k", auth="a"))
    await db_session.commit()

    monkeypatch.setattr("app.push.BROADCAST_DEADLINE_SECONDS", 0.3)
    monkeypatch.setattr(pywebpush, "webpush", lambda subscription_info, **_kw: time.sleep(5))
    started = time.monotonic()
    await broadcast(db_session, title="T", body="B", tag="t", target="")
    assert time.monotonic() - started < 3, "the broadcast must give up rather than hold the alarm path"

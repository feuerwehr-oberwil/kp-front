"""Where this server is allowed to send outbound requests: report tiles and Web Push.

Two caller-chosen destinations reach the network from a logged-in request: the Kroki's base
tile template (``KrokiIn.tiles``, rendered server-side) and a browser's Web-Push endpoint.
Both used to be arbitrary strings, which made the app a request forwarder from its own
network position. These tests pin the policy in `app/egress.py` and its two callers.

No test here touches a real network: the tile fetcher runs against an `httpx.MockTransport`
and the push sender against a stubbed `pywebpush`.
"""

import io

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


async def test_a_resolvable_name_pointing_inside_is_refused(client, editor, monkeypatch):
    """DNS is the other half of the destination: a public NAME may still answer with 10.x."""
    from app import egress

    monkeypatch.setattr(egress, "_resolved_addresses", lambda host: ["10.1.2.3"])
    await _login(client, editor)
    r = await client.post("/api/push/subscriptions", json=_sub("https://rebind.example/wpush/v2/x"))
    assert r.status_code == 422


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

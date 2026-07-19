"""Web Push: due-ness engine (the safety math), sender pruning, the Divera new-alarm
push, and the subscription endpoints.

The due computations mirror the client (src/lib/atemschutz.ts / reminders.ts) — Trupps
überfällig after interval+grace since last contact, reminders folded from the journal
lifecycle with closure expiry — so the killed-app push fires exactly when the in-app
alarm would have.
"""

import base64
from datetime import datetime
from types import SimpleNamespace

from sqlalchemy import select

from app.push import _should_send, due_reminders, due_trupps


def ms(iso: str) -> float:
    return datetime.fromisoformat(iso).timestamp() * 1000


NOW = ms("2026-07-02T14:10:00+00:00")


def trupp(id_: str, contact: str | None, status: str = "aktiv", **over) -> dict:
    return {"id": id_, "name": f"Trupp {id_}", "entryTime": "2026-07-02T14:00:00Z",
            "lastContactTime": contact, "status": status, **over}


class TestDueTrupps:
    def test_ueberfaellig_after_interval_plus_grace(self):
        ws = {"trupps": [trupp("a", "2026-07-02T14:03:00Z")]}  # 7 min since contact
        assert [t["id"] for t in due_trupps(ws, {}, NOW)] == ["a"]  # 5+1 min default

    def test_not_due_within_grace(self):
        ws = {"trupps": [trupp("a", "2026-07-02T14:04:30Z")]}  # 5:30 — fällig, not überfällig
        assert due_trupps(ws, {}, NOW) == []

    def test_out_of_field_never_fires(self):
        ws = {"trupps": [
            trupp("raus", "2026-07-02T13:00:00Z", status="raus"),
            trupp("exited", "2026-07-02T13:00:00Z", exitTime="2026-07-02T13:30:00Z"),
            trupp("angemeldet", None, status="angemeldet") | {"entryTime": None},
        ]}
        assert due_trupps(ws, {}, NOW) == []

    def test_doctrine_and_incident_settings_override(self):
        ws = {"trupps": [trupp("a", "2026-07-02T14:03:00Z")]}  # 7 min
        # deployment doctrine stretches the window past 7 min → not due
        assert due_trupps(ws, {"contactIntervalMin": 10}, NOW) == []
        # per-incident settings beat doctrine (tightest binding, like the client)
        ws["settings"] = {"contactIntervalMin": 5, "contactGraceSec": 60}
        assert [t["id"] for t in due_trupps(ws, {"contactIntervalMin": 10}, NOW)] == ["a"]

    def test_contact_falls_back_to_entry(self):
        ws = {"trupps": [trupp("a", None)]}  # entered 14:00, never a contact → due at 14:06
        assert [t["id"] for t in due_trupps(ws, {}, NOW)] == ["a"]


def rem_row(rid: str, op: str, due: str | None = None, text: str = "Prüfen") -> dict:
    return {"id": f"row-{rid}-{op}", "text": text, "reminder": {"op": op, "id": rid, **({"dueAt": due} if due else {})}}


class TestDueReminders:
    def test_due_open_reminder_fires(self):
        rows = [rem_row("r1", "created", "2026-07-02T14:00:00Z")]
        assert [r["id"] for r in due_reminders(rows, NOW, None)] == ["r1"]

    def test_done_and_future_do_not_fire(self):
        rows = [
            rem_row("done", "created", "2026-07-02T14:00:00Z"), rem_row("done", "done"),
            rem_row("future", "created", "2026-07-02T15:00:00Z"),
        ]
        assert due_reminders(rows, NOW, None) == []

    def test_snooze_moves_the_due(self):
        rows = [rem_row("r1", "created", "2026-07-02T13:00:00Z"), rem_row("r1", "snoozed", "2026-07-02T15:00:00Z")]
        assert due_reminders(rows, NOW, None) == []

    def test_expired_by_closure(self):
        rows = [rem_row("stale", "created", "2026-07-02T12:00:00Z")]
        assert due_reminders(rows, NOW, "2026-07-02T13:00:00+00:00") == []


def test_should_send_dedupes_and_renotifies_on_cadence():
    from app.config import settings

    key = "az:test:crossing"
    t0 = NOW
    assert _should_send(key, t0) is True
    assert _should_send(key, t0 + 10_000) is False  # within the renotify window
    assert _should_send(key, t0 + settings.push_renotify_seconds * 1000 + 1) is True


async def test_subscription_endpoints(client, editor, viewer):
    login = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert login.status_code == 200

    sub = {"endpoint": "https://push.example/abc", "keys": {"p256dh": "k1", "auth": "a1"}}
    assert (await client.post("/api/push/subscriptions", json=sub)).status_code == 201
    # re-subscribing the same endpoint upserts (no duplicate-key error)
    sub["keys"]["p256dh"] = "k2"
    assert (await client.post("/api/push/subscriptions", json=sub)).status_code == 201

    r = await client.get("/api/push/vapid-key")
    assert r.status_code == 200
    assert r.json()["enabled"] is False  # no VAPID keys in the test env

    assert (await client.request("DELETE", "/api/push/subscriptions", json=sub)).status_code == 204


async def test_push_endpoints_require_auth(client):
    assert (await client.get("/api/push/vapid-key")).status_code == 401
    sub = {"endpoint": "https://push.example/x", "keys": {"p256dh": "k", "auth": "a"}}
    assert (await client.post("/api/push/subscriptions", json=sub)).status_code == 401


# ---------------------------------------------------------------------------------------
# sender: broadcast + dead-endpoint pruning (webpush mocked — no network)
# ---------------------------------------------------------------------------------------


def _add_sub(db, endpoint: str):
    from app.models import PushSubscription

    db.add(PushSubscription(endpoint=endpoint, p256dh="k", auth="a"))


async def _endpoints(db) -> list[str]:
    from app.models import PushSubscription

    rows = (await db.execute(select(PushSubscription))).scalars()
    return sorted(s.endpoint for s in rows)


class TestBroadcast:
    async def test_sends_to_all_and_prunes_gone_endpoints(self, db_session, monkeypatch):
        import pywebpush

        from app.push import broadcast

        _add_sub(db_session, "https://push.example/ok")
        _add_sub(db_session, "https://push.example/gone")
        await db_session.commit()

        delivered: list[str] = []

        def fake_webpush(subscription_info, **_kw):
            if "gone" in subscription_info["endpoint"]:
                raise pywebpush.WebPushException("gone", response=SimpleNamespace(status_code=410))
            delivered.append(subscription_info["endpoint"])

        monkeypatch.setattr(pywebpush, "webpush", fake_webpush)
        sent = await broadcast(db_session, title="T", body="B", tag="t", target="")
        assert sent == 1
        assert delivered == ["https://push.example/ok"]
        # the 410 endpoint is deleted, the live one kept
        assert await _endpoints(db_session) == ["https://push.example/ok"]

    async def test_transient_failure_keeps_the_subscription(self, db_session, monkeypatch):
        import pywebpush

        from app.push import broadcast

        _add_sub(db_session, "https://push.example/flaky")
        await db_session.commit()

        def fake_webpush(subscription_info, **_kw):
            raise pywebpush.WebPushException("busy", response=SimpleNamespace(status_code=503))

        monkeypatch.setattr(pywebpush, "webpush", fake_webpush)
        await broadcast(db_session, title="T", body="B", tag="t", target="")
        assert await _endpoints(db_session) == ["https://push.example/flaky"]


# ---------------------------------------------------------------------------------------
# Divera new-alarm push (fail-closed without keys; fires once per NEW alarm)
# ---------------------------------------------------------------------------------------


async def test_notify_new_alarm_noop_without_vapid_keys(db_session, monkeypatch):
    import app.push as push_mod

    async def boom(*_a, **_kw):  # broadcast must never be reached while push is disabled
        raise AssertionError("broadcast called with push disabled")

    monkeypatch.setattr(push_mod, "broadcast", boom)
    assert await push_mod.notify_new_alarm(db_session, tag="divera-1", title="Brand", address=None) == 0


async def test_notify_new_alarm_broadcasts_stichwort_and_address(db_session, monkeypatch):
    import app.push as push_mod
    from app.config import settings

    monkeypatch.setattr(settings, "vapid_private_key", "priv")
    monkeypatch.setattr(settings, "vapid_public_key", "pub")
    calls: list[dict] = []

    async def fake_broadcast(_db, **kw):
        calls.append(kw)
        return 2

    monkeypatch.setattr(push_mod, "broadcast", fake_broadcast)
    n = await push_mod.notify_new_alarm(db_session, tag="divera-99", title="Zimmerbrand", address="Teststrasse 1")
    assert n == 2
    assert calls == [{"title": "Neuer Einsatz", "body": "Zimmerbrand — Teststrasse 1", "tag": "divera-99", "target": "divera"}]


async def test_webhook_pushes_only_for_new_alarms(client, monkeypatch):
    import app.push as push_mod
    from app.config import settings

    monkeypatch.setattr(settings, "divera_webhook_secret", "hook-secret-123")
    monkeypatch.setattr(settings, "vapid_private_key", "priv")
    monkeypatch.setattr(settings, "vapid_public_key", "pub")
    calls: list[dict] = []

    async def fake_broadcast(_db, **kw):
        calls.append(kw)
        return 1

    monkeypatch.setattr(push_mod, "broadcast", fake_broadcast)
    payload = {"id": 4712, "title": "Ölspur", "address": "Dorfplatz 2"}
    r = await client.post("/api/divera/webhook?secret=hook-secret-123", json=payload)
    assert r.status_code == 200 and r.json()["new"] is True
    assert [c["tag"] for c in calls] == ["divera-4712"]
    # duplicate delivery: still 200, but no second push
    r = await client.post("/api/divera/webhook?secret=hook-secret-123", json=payload)
    assert r.status_code == 200 and r.json()["new"] is False
    assert len(calls) == 1


# ---------------------------------------------------------------------------------------
# VAPID key generation helper (uv run python -m app.gen_vapid)
# ---------------------------------------------------------------------------------------


def test_gen_vapid_emits_a_matching_urlsafe_pair():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    from app.gen_vapid import generate

    pub, priv = generate()

    def dec(s: str) -> bytes:
        return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

    raw_pub, raw_priv = dec(pub), dec(priv)
    assert len(raw_pub) == 65 and raw_pub[0] == 0x04  # uncompressed P-256 point
    assert len(raw_priv) == 32  # raw scalar
    # the public point actually belongs to the private scalar
    key = ec.derive_private_key(int.from_bytes(raw_priv, "big"), ec.SECP256R1())
    derived = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    assert derived == raw_pub

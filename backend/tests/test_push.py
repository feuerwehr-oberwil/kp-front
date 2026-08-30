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

from app.push import _atemschutz_message, _should_send, due_reminders, due_trupps


def ms(iso: str) -> float:
    return datetime.fromisoformat(iso).timestamp() * 1000


NOW = ms("2026-07-02T14:10:00+00:00")


def trupp(id_: str, contact: str | None, status: str = "aktiv", **over) -> dict:
    return {
        "id": id_,
        "name": f"Trupp {id_}",
        "entryTime": "2026-07-02T14:00:00Z",
        "lastContactTime": contact,
        "status": status,
        **over,
    }


class TestDueTrupps:
    def test_ueberfaellig_after_interval_plus_grace(self):
        ws = {"trupps": [trupp("a", "2026-07-02T14:03:00Z")]}  # 7 min since contact
        assert [t["id"] for t in due_trupps(ws, {}, NOW)] == ["a"]  # 5+1 min default

    def test_not_due_within_grace(self):
        ws = {"trupps": [trupp("a", "2026-07-02T14:04:30Z")]}  # 5:30 — fällig, not überfällig
        assert due_trupps(ws, {}, NOW) == []

    def test_out_of_field_never_fires(self):
        ws = {
            "trupps": [
                trupp("raus", "2026-07-02T13:00:00Z", status="raus"),
                trupp("exited", "2026-07-02T13:00:00Z", exitTime="2026-07-02T13:30:00Z"),
                trupp("angemeldet", None, status="angemeldet") | {"entryTime": None},
            ]
        }
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

    def test_alarmdruck_is_tier_two_even_with_a_fresh_contact(self):
        ws = {
            "trupps": [
                trupp("a", "2026-07-02T14:09:30Z", entryPressureBar=300, lastPressureBar=90),
            ]
        }
        alert = due_trupps(ws, {}, NOW)
        assert alert == [
            {
                "id": "a",
                "name": "Trupp a",
                "since": ms("2026-07-02T14:09:30Z"),
                "reason": "pressure",
                "bar": 90,
                "line": 100,
                "pressureAt": ms("2026-07-02T14:00:00Z"),
            }
        ]
        assert _atemschutz_message(alert[0]) == (
            "Alarmdruck erreicht – Trupp a",
            "90 bar, Grenze 100 bar – Rückzug anordnen.",
        )

    def test_pressure_wins_over_an_overdue_contact(self):
        ws = {"trupps": [trupp("a", "2026-07-02T14:00:00Z", lastPressureBar=80, entryPressureBar=300)]}
        assert due_trupps(ws, {}, NOW)[0]["reason"] == "pressure"

    def test_rueckzug_uses_its_lower_alarm_line(self):
        ws = {
            "trupps": [
                trupp("safe", "2026-07-02T14:09:30Z", status="rueckzug", lastPressureBar=60, entryPressureBar=300),
                trupp("due", "2026-07-02T14:09:30Z", status="rueckzug", lastPressureBar=50, entryPressureBar=300),
            ]
        }
        alert = due_trupps(ws, {}, NOW)
        assert [(t["id"], t["line"]) for t in alert] == [("due", 50)]

    def test_deployment_keeps_separate_working_and_rueckzug_lines(self):
        doctrine = {"alarmBar": 140, "alarmBarRueckzug": 70}
        ws = {
            "trupps": [
                trupp("working", "2026-07-02T14:09:30Z", lastPressureBar=140, entryPressureBar=300),
                trupp(
                    "withdraw-safe", "2026-07-02T14:09:30Z", status="rueckzug", lastPressureBar=71, entryPressureBar=300
                ),
                trupp(
                    "withdraw-due", "2026-07-02T14:09:30Z", status="rueckzug", lastPressureBar=70, entryPressureBar=300
                ),
            ]
        }
        alert = due_trupps(ws, doctrine, NOW)
        assert [(t["id"], t["line"]) for t in alert] == [("working", 140), ("withdraw-due", 70)]

    def test_zero_alarmdruck_disables_pressure_alarm(self):
        ws = {
            "trupps": [
                trupp(
                    "working",
                    "2026-07-02T14:09:30Z",
                    lastPressureBar=0,
                    entryPressureBar=300,
                ),
                trupp(
                    "retreating",
                    "2026-07-02T14:09:30Z",
                    status="rueckzug",
                    lastPressureBar=0,
                    entryPressureBar=300,
                ),
            ]
        }
        assert due_trupps(ws, {"alarmBar": 0, "alarmBarRueckzug": 50}, NOW) == []

    def test_default_rueckzug_line_never_exceeds_a_lower_active_line(self):
        doctrine = {"alarmBar": 40}
        ws = {
            "trupps": [
                trupp("safe", "2026-07-02T14:09:30Z", status="rueckzug", lastPressureBar=41),
                trupp("due", "2026-07-02T14:09:30Z", status="rueckzug", lastPressureBar=40),
            ]
        }
        alert = due_trupps(ws, doctrine, NOW)
        assert [(t["id"], t["line"]) for t in alert] == [("due", 40)]

    def test_contact_notification_matches_foreground_action_copy(self):
        alert = due_trupps({"trupps": [trupp("a", "2026-07-02T14:00:00Z", name="Angriff 1")]}, {}, NOW)[0]
        assert _atemschutz_message(alert) == (
            "Atemschutz überfällig",
            "Trupp Angriff 1 überfällig – Kontakt herstellen.",
        )


def rem_row(rid: str, op: str, due: str | None = None, text: str = "Prüfen") -> dict:
    return {"id": f"row-{rid}-{op}", "text": text, "reminder": {"op": op, "id": rid, **({"dueAt": due} if due else {})}}


class TestDueReminders:
    def test_due_open_reminder_fires(self):
        rows = [rem_row("r1", "created", "2026-07-02T14:00:00Z")]
        assert [r["id"] for r in due_reminders(rows, NOW, None)] == ["r1"]

    def test_done_and_future_do_not_fire(self):
        rows = [
            rem_row("done", "created", "2026-07-02T14:00:00Z"),
            rem_row("done", "done"),
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


async def test_killed_app_sweep_pushes_confirmed_pressure_with_station_threshold(db_session, monkeypatch):
    import app.push as push_mod
    from app.models import DeploymentConfig, Incident

    push_mod._notified.clear()
    db_session.add(DeploymentConfig(id=1, config_json={"doctrine": {"alarmBar": 140, "alarmBarRueckzug": 70}}))
    db_session.add(
        Incident(
            title="Zimmerbrand",
            source="manual",
            status="offen",
            is_archived=False,
            map_workspace_json={
                "trupps": [
                    trupp(
                        "a",
                        "2026-07-02T14:09:30Z",
                        name="Angriff 1",
                        entryPressureBar=300,
                        lastPressureBar=130,
                        lastPressureTime="2026-07-02T14:09:30Z",
                    )
                ]
            },
        )
    )
    await db_session.commit()
    calls: list[dict] = []

    async def fake_broadcast(_db, **kw):
        calls.append(kw)
        return 1

    monkeypatch.setattr(push_mod, "broadcast", fake_broadcast)
    assert await push_mod.check_and_push(db_session, NOW) == 1
    assert calls == [
        {
            "title": "Alarmdruck erreicht – Angriff 1",
            "body": "130 bar, Grenze 140 bar – Rückzug anordnen.",
            "tag": "atemschutz-a",
            # the target carries the Trupp id so the tapped notification lands on the card
            "target": "atemschutz:a",
        }
    ]
    # Same confirmed reading is one crossing, not a new push on every 30 s sweep.
    assert await push_mod.check_and_push(db_session, NOW + 30_000) == 0


async def test_sweep_stays_silent_for_an_uebung(db_session, monkeypatch):
    """A drill's Atemschutz clocks are real rows in a real workspace — without the gate every
    local test run pushed «Trupp überfällig» to every subscribed phone in the Wehr."""
    import app.push as push_mod
    from app.models import DeploymentConfig, Incident

    push_mod._notified.clear()
    db_session.add(DeploymentConfig(id=1, config_json={"doctrine": {"alarmBar": 140}}))
    db_session.add(
        Incident(
            title="Übung Zimmerbrand",
            source="manual",
            status="offen",
            is_archived=False,
            is_exercise=True,
            map_workspace_json={
                "trupps": [
                    trupp(
                        "a",
                        "2026-07-02T14:09:30Z",
                        name="Angriff 1",
                        entryPressureBar=300,
                        lastPressureBar=130,
                        lastPressureTime="2026-07-02T14:09:30Z",
                    )
                ]
            },
        )
    )
    await db_session.commit()

    async def fake_broadcast(_db, **kw):  # pragma: no cover — the gate must keep this unreached
        raise AssertionError("an Übung must not broadcast")

    monkeypatch.setattr(push_mod, "broadcast", fake_broadcast)
    assert await push_mod.check_and_push(db_session, NOW) == 0


async def test_sweep_stays_silent_on_the_public_demo(db_session, monkeypatch):
    """Persisted demo clocks are seed time; browsers rebase them to each visitor's arrival."""
    import app.push as push_mod

    monkeypatch.setattr(push_mod.settings, "demo_reset_seconds", 7200)

    async def fake_broadcast(_db, **kw):  # pragma: no cover - demo gate must keep this unreached
        raise AssertionError(f"the public demo must not broadcast: {kw}")

    monkeypatch.setattr(push_mod, "broadcast", fake_broadcast)
    assert await push_mod.check_and_push(db_session, NOW) == 0


async def test_sweep_stays_silent_for_an_identity_only_demo(db_session, monkeypatch):
    """A local demo config gets the same guard even without an automatic reset schedule."""
    import app.push as push_mod
    from app.models import DeploymentConfig

    monkeypatch.setattr(push_mod.settings, "demo_reset_seconds", 0)
    monkeypatch.setattr(push_mod.settings, "demo_reset_cron", "")
    db_session.add(DeploymentConfig(id=1, config_json={"identity": {"demoMode": True}}))
    await db_session.commit()

    async def fake_broadcast(_db, **kw):  # pragma: no cover - demo gate must keep this unreached
        raise AssertionError(f"an identity-only demo must not broadcast: {kw}")

    monkeypatch.setattr(push_mod, "broadcast", fake_broadcast)
    assert await push_mod.check_and_push(db_session, NOW) == 0


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

    async def test_a_hung_endpoint_gets_a_timeout_and_does_not_stall_the_others(self, db_session, monkeypatch):
        """
        The alarm path awaits this inline (api/alarms.py, api/divera.py), so a push service
        that accepts the connection and then never answers used to hang the ALARM — pywebpush
        passes timeout=None to requests by default, i.e. wait forever.
        """
        import pywebpush

        from app.push import PUSH_TIMEOUT_SECONDS, broadcast

        _add_sub(db_session, "https://push.example/a")
        await db_session.commit()

        seen: list[float | None] = []

        def fake_webpush(subscription_info, **kw):
            seen.append(kw.get("timeout"))

        monkeypatch.setattr(pywebpush, "webpush", fake_webpush)
        await broadcast(db_session, title="T", body="B", tag="t", target="")
        assert seen == [PUSH_TIMEOUT_SECONDS], "every send must carry a finite timeout"

    async def test_slow_endpoints_are_sent_concurrently(self, db_session, monkeypatch):
        """
        Sequentially, N unreachable endpoints cost N x the timeout — twenty devices and one
        dead push service meant minutes of hanging on the alarm-intake path. Fanned out, the
        sweep costs one timeout no matter how many are unreachable.
        """
        import time

        import pywebpush

        from app.push import broadcast

        for i in range(5):
            _add_sub(db_session, f"https://push.example/slow{i}")
        await db_session.commit()

        def fake_webpush(subscription_info, **_kw):
            time.sleep(0.2)  # stands in for a push service that is slow to answer

        monkeypatch.setattr(pywebpush, "webpush", fake_webpush)
        started = time.monotonic()
        await broadcast(db_session, title="T", body="B", tag="t", target="")
        elapsed = time.monotonic() - started

        # Sequential would be ~1.0s; concurrent is ~0.2s. The bound is deliberately loose —
        # this asserts "not serialised", not a performance number.
        assert elapsed < 0.7, f"sends look serialised ({elapsed:.2f}s for 5 x 0.2s)"
        assert await _endpoints(db_session) == [f"https://push.example/slow{i}" for i in range(5)]

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
    import asyncio

    import app.push as push_mod
    from app.config import settings

    monkeypatch.setattr(settings, "vapid_private_key", "priv")
    monkeypatch.setattr(settings, "vapid_public_key", "pub")
    calls: list[dict] = []

    async def fake_broadcast(_db, **kw):
        calls.append(kw)
        return 2

    monkeypatch.setattr(push_mod, "broadcast", fake_broadcast)
    await db_session.execute(select(1))  # the real intake has an open write transaction here
    n = await push_mod.notify_new_alarm(db_session, tag="divera-99", title="Zimmerbrand", address="Teststrasse 1")
    assert n == 1  # queued, but never sent before the alarm transaction commits
    assert calls == []
    await db_session.commit()
    await asyncio.gather(*tuple(push_mod._inflight))
    assert calls == [
        {"title": "Neuer Einsatz", "body": "Zimmerbrand — Teststrasse 1", "tag": "divera-99", "target": "divera"}
    ]


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
    derived = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    assert derived == raw_pub

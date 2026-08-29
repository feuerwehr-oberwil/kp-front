"""Web-Push sending (pywebpush) + the due-ness engine for killed-app alarms.

The in-app alarm layer (tone + SW notification) only works while the PWA is alive; a
swiped-away or OS-reclaimed app hears nothing. This module closes that gap server-side:
a scheduler job recomputes, every ~30s, which Atemschutz-Trupps are überfällig or at their
confirmed Alarmdruck and which Wiedervorlagen are due — from the SAME data the clients sync
(workspace trupps + journal reminder rows) with the SAME doctrine fallbacks — and pushes an
OS notification to every subscribed browser. A NEW Divera alarm additionally pushes
"Neuer Einsatz" immediately
(``notify_new_alarm``, called from both intake paths). Silently disabled while no VAPID
keys are configured.

Deduplication: an alert is sent once per crossing (keyed by what defines the crossing — the
Trupp's lastContactTime, its lastPressureTime, or the reminder's effective dueAt) and re-sent
on a slow cadence while still due. State is in-memory: a restart re-notifies once, which is
the right failure direction for a safety alarm.
"""

import asyncio
import json
import logging
import math
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .config import settings
from .models import DeploymentConfig, Incident, JournalEntry, PushSubscription
from .transaction_hooks import after_commit

logger = logging.getLogger(__name__)


def push_enabled() -> bool:
    """Whether this deployment can send Web Push at all.

    Reads through ``app.credentials`` (env first, admin-set otherwise) rather than off the
    boot-time settings object, so a station that generates a VAPID pair in the browser gets
    push on the next sweep instead of after a restart. Synchronous, because it is also read
    from the sending thread — the snapshot behind it is refreshed on every request path and
    every 30 s by the scheduler.
    """
    from .credentials import get as credential

    return bool(credential("vapid_private_key") and credential("vapid_public_key"))


# ---------------------------------------------------------------------------------------
# due-ness (pure, unit-tested — mirrors src/lib/atemschutz.ts + src/lib/reminders.ts)
# ---------------------------------------------------------------------------------------

DEFAULT_INTERVAL_MIN = 5
DEFAULT_GRACE_SEC = 60
DEFAULT_ALARM_BAR = 100
DEFAULT_ALARM_BAR_RUECKZUG = 50


def _ms(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def due_trupps(workspace: dict, doctrine: dict, now_ms: float) -> list[dict[str, Any]]:
    """Trupps at frontend tier 2: overdue contact or measured Alarmdruck.

    Pressure wins when both reasons apply, matching ``truppAlarm``: a radio check cannot
    resolve a crew at its Alarmdruck. The expected-pressure estimate is deliberately absent;
    it remains a Planungshilfe and never raises an alarm.
    """
    settings_ws = workspace.get("settings") or {}
    interval_min = settings_ws.get("contactIntervalMin")
    if interval_min is None:
        interval_min = doctrine.get("contactIntervalMin")
    if interval_min is None:
        interval_min = DEFAULT_INTERVAL_MIN
    grace_sec = settings_ws.get("contactGraceSec")
    if grace_sec is None:
        grace_sec = doctrine.get("contactGraceSec")
    if grace_sec is None:
        grace_sec = DEFAULT_GRACE_SEC
    alarm_bar = doctrine.get("alarmBar")
    if alarm_bar is None:
        alarm_bar = DEFAULT_ALARM_BAR
    alarm_bar_rueckzug = doctrine.get("alarmBarRueckzug")
    if alarm_bar_rueckzug is None:
        alarm_bar_rueckzug = DEFAULT_ALARM_BAR_RUECKZUG
    out = []
    for t in workspace.get("trupps") or []:
        entry = _ms(t.get("entryTime"))
        if not entry or t.get("status") in ("angemeldet", "raus") or t.get("exitTime"):
            continue
        contact = _ms(t.get("lastContactTime")) or entry
        current_bar = t.get("lastPressureBar")
        if current_bar is None:
            current_bar = t.get("entryPressureBar")
        line = alarm_bar_rueckzug if t.get("status") == "rueckzug" else alarm_bar
        pressure_due = (
            isinstance(current_bar, (int, float))
            and not isinstance(current_bar, bool)
            and math.isfinite(current_bar)
            and isinstance(line, (int, float))
            and not isinstance(line, bool)
            and line > 0
            and current_bar <= line
        )
        contact_due = now_ms - contact >= (interval_min * 60 + grace_sec) * 1000
        if pressure_due or contact_due:
            # A Funkkontakt below the Alarmdruck must not look like a new pressure crossing.
            # A NEW confirmed Druckmeldung should, even if its value happens to be unchanged.
            pressure_at = _ms(t.get("lastPressureTime")) or entry
            out.append(
                {
                    "id": t.get("id"),
                    "name": t.get("name") or "Trupp",
                    "since": contact,
                    "reason": "pressure" if pressure_due else "contact",
                    **({"bar": current_bar, "line": line, "pressureAt": pressure_at} if pressure_due else {}),
                }
            )
    return out


def _atemschutz_message(alert: dict[str, Any]) -> tuple[str, str]:
    """German OS-notification copy matching the frontend tier-2 notification."""
    if alert["reason"] == "pressure":
        bar = f"{alert['bar']:g}"
        line = f"{alert['line']:g}"
        return f"Alarmdruck erreicht – {alert['name']}", f"{bar} bar, Grenze {line} bar – Rückzug anordnen."
    return "Atemschutz überfällig", f"Trupp {alert['name']} überfällig – Kontakt herstellen."


def due_reminders(rows: list[dict], now_ms: float, closed_at: str | None) -> list[dict[str, Any]]:
    """Open, due Wiedervorlagen folded from journal rows (created/snoozed/done lifecycle);
    reminders due before the Einsatzende are expired by closure (mirrors deriveReminders)."""
    created: dict[str, dict] = {}
    latest: dict[str, dict] = {}
    for e in rows:  # oldest→newest (seq order)
        r = e.get("reminder")
        if not r or not r.get("id"):
            continue
        if r.get("op") == "created":
            created[r["id"]] = e
            latest[r["id"]] = {"op": "created", "dueAt": r.get("dueAt")}
        else:
            prev = latest.get(r["id"], {})
            latest[r["id"]] = {"op": r.get("op"), "dueAt": r.get("dueAt") or prev.get("dueAt")}
    closed_ms = _ms(closed_at)
    out = []
    for rid, c in created.items():
        st = latest.get(rid)
        if not st or st["op"] == "done":
            continue
        due = st.get("dueAt") or (c.get("reminder") or {}).get("dueAt")
        due_ms = _ms(due)
        if due_ms is None:
            continue
        if closed_ms is not None and due_ms < closed_ms:
            continue  # expired by closure
        if due_ms <= now_ms:
            out.append({"id": rid, "text": c.get("text") or "Wiedervorlage", "dueAt": due})
    return out


# ---------------------------------------------------------------------------------------
# sending
# ---------------------------------------------------------------------------------------


#: Per-endpoint push timeout. pywebpush hands this to requests; without it the default is
#: None, i.e. wait forever. New-alarm delivery is detached after the intake COMMIT, but due
#: alarm sweeps still await a broadcast; every path needs a finite upper bound.
PUSH_TIMEOUT_SECONDS = 10

# Strong references to post-commit tasks. asyncio itself holds only weak references.
_inflight: set[asyncio.Task] = set()


def _send_one(sub: dict, payload: str) -> bool:
    """Blocking pywebpush send; returns False when the subscription should be pruned
    (endpoint gone per the push service, or the stored keys are unusable)."""
    from pywebpush import WebPushException, webpush

    from .credentials import get as credential

    try:
        webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
            data=payload,
            vapid_private_key=credential("vapid_private_key"),
            vapid_claims={"sub": credential("vapid_subject")},
            ttl=120,
            timeout=PUSH_TIMEOUT_SECONDS,
        )
        return True
    except WebPushException as e:
        code = getattr(getattr(e, "response", None), "status_code", None)
        if code in (404, 410):
            return False  # endpoint gone — caller prunes it
        logger.warning("Web push failed (%s): %s", code, e)
        return True
    except Exception:  # intake must survive a broken push path  # malformed keys must not abort the whole sweep
        logger.exception("Web push subscription unusable — pruning %s", sub["endpoint"][:60])
        return False


async def broadcast(db: AsyncSession, *, title: str, body: str, tag: str, target: str | None) -> int:
    """Push to every subscribed browser; prunes dead endpoints. Returns the send count."""
    subs = list((await db.execute(select(PushSubscription))).scalars())
    if not subs:
        return 0
    payload = json.dumps({"title": title, "body": body, "tag": tag, "target": target})

    # Concurrently, not one after another. Sequentially the worst case was
    # len(subs) x PUSH_TIMEOUT_SECONDS — twenty subscribed devices with one dead push service
    # meant minutes of hanging, and this is awaited inline in the alarm intake path. Fanned
    # out, the whole sweep costs one timeout regardless of how many endpoints are unreachable.
    results = await asyncio.gather(
        *(
            asyncio.to_thread(_send_one, {"endpoint": s.endpoint, "p256dh": s.p256dh, "auth": s.auth}, payload)
            for s in subs
        ),
        return_exceptions=True,
    )

    dead: list[str] = []
    for s, ok in zip(subs, results, strict=True):
        if isinstance(ok, BaseException):
            # _send_one already swallows everything it knows about; anything arriving here is
            # unexpected. Log it and KEEP the subscription — pruning on an unknown fault would
            # silently unsubscribe a working device.
            logger.warning("Web push raised unexpectedly for %s: %s", s.endpoint[:60], ok)
            continue
        if not ok:
            dead.append(s.endpoint)
    if dead:
        await db.execute(delete(PushSubscription).where(PushSubscription.endpoint.in_(dead)))
        logger.info("Pruned %d dead push subscription(s)", len(dead))
    return len(subs) - len(dead)


async def notify_new_alarm(
    db: AsyncSession, *, tag: str, title: str, address: str | None, target: str | None = "divera"
) -> int:
    """Queue a "Neuer Einsatz" push after the alarm transaction commits.

    Delivery uses a fresh session, so dead-subscription pruning is committed independently
    and no task retains the request session. Returns 1 when queued, 0 when push is disabled.
    """
    if not push_enabled():
        return 0
    body = " — ".join(p for p in (title, address) if p) or "Alarmeingang"
    # Bind the fresh session to the caller's engine. This is the application engine in
    # production and the isolated engine under tests.
    factory = async_sessionmaker(db.bind, class_=AsyncSession, expire_on_commit=False, autoflush=False)

    def schedule() -> None:
        task = asyncio.create_task(
            _broadcast_committed(factory, title="Neuer Einsatz", body=body, tag=tag, target=target)
        )
        _inflight.add(task)
        task.add_done_callback(_inflight.discard)

    after_commit(db, schedule)
    return 1


async def _broadcast_committed(
    factory: async_sessionmaker[AsyncSession], *, title: str, body: str, tag: str, target: str | None
) -> None:
    """Best-effort post-commit delivery with independent dead-endpoint pruning."""
    try:
        async with factory() as send_db:
            # Refresh runtime-settable VAPID values before the blocking sender reads them.
            from .credentials import load

            await load(send_db)
            await broadcast(send_db, title=title, body=body, tag=tag, target=target)
            await send_db.commit()
    except Exception:  # push must never affect already-committed intake
        logger.exception("New-alarm push failed (%s)", tag)


# ---------------------------------------------------------------------------------------
# scheduler job
# ---------------------------------------------------------------------------------------

# in-memory crossing → last-notified ms (restart = one re-notification, safe direction)
_notified: dict[str, float] = {}


def _should_send(key: str, now_ms: float) -> bool:
    last = _notified.get(key)
    if last is not None and now_ms - last < settings.push_renotify_seconds * 1000:
        return False
    _notified[key] = now_ms
    return True


async def check_and_push(db: AsyncSession, now_ms: float | None = None) -> int:
    """One due-ness sweep over all open incidents. Returns alerts sent."""
    now_ms = now_ms if now_ms is not None else datetime.now(UTC).timestamp() * 1000
    doctrine_row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    doctrine = ((doctrine_row.config_json if doctrine_row else {}) or {}).get("doctrine") or {}

    sent = 0
    # Übungen are excluded outright: a drill's Atemschutz clocks and Wiedervorlagen are real
    # rows in a real workspace, so without this every local test run pushed «Trupp überfällig»
    # to every subscribed phone in the Wehr. The drill screen itself still shows its alarms —
    # this silences only the server-side broadcast.
    incidents = list(
        (
            await db.execute(select(Incident).where(Incident.is_archived.is_(False), Incident.is_exercise.is_(False)))
        ).scalars()
    )
    for inc in incidents:
        ws = inc.map_workspace_json or {}
        for t in due_trupps(ws, doctrine, now_ms):
            crossing = t.get("pressureAt") if t["reason"] == "pressure" else t["since"]
            key = f"az:{inc.id}:{t['id']}:{crossing}:{t['reason']}"
            if _should_send(key, now_ms):
                title, body = _atemschutz_message(t)
                sent += await broadcast(
                    db,
                    title=title,
                    body=body,
                    tag=f"atemschutz-{t['id']}",
                    # the tap opens the board ON this Trupp's card — the frontend router parses
                    # the ':<truppId>' suffix (sw-notify.js passes the target through opaquely);
                    # a Trupp without an id falls back to the bare surface target.
                    target=f"atemschutz:{t['id']}" if t.get("id") else "atemschutz",
                )
        # journal rows (seq order) + any pre-migration blob rows still carrying reminders
        rows = [
            r.row_json
            for r in (
                await db.execute(
                    select(JournalEntry).where(JournalEntry.incident_id == inc.id).order_by(JournalEntry.seq.asc())
                )
            ).scalars()
        ]
        legacy = list(reversed(ws.get("timeline") or []))  # blob stores newest-first
        seen = {r.get("id") for r in rows}
        rows.extend(r for r in legacy if r.get("id") not in seen)
        closed_at = inc.closed_at.isoformat() if inc.closed_at else None
        for r in due_reminders(rows, now_ms, closed_at):
            key = f"rem:{inc.id}:{r['id']}:{r['dueAt']}"
            if _should_send(key, now_ms):
                sent += await broadcast(
                    db,
                    title="Wiedervorlage fällig",
                    body=r["text"],
                    tag=f"reminder-{r['id']}",
                    target="journal",
                )
    return sent

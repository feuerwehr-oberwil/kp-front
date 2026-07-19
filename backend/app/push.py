"""Web-Push sending (pywebpush) + the due-ness engine for killed-app alarms.

The in-app alarm layer (tone + SW notification) only works while the PWA is alive; a
swiped-away or OS-reclaimed app hears nothing. This module closes that gap server-side:
a scheduler job recomputes, every ~30s, which Atemschutz-Trupps are überfällig and which
Wiedervorlagen are due — from the SAME data the clients sync (workspace trupps + journal
reminder rows) with the SAME doctrine fallbacks — and pushes an OS notification to every
subscribed browser. A NEW Divera alarm additionally pushes "Neuer Einsatz" immediately
(``notify_new_alarm``, called from both intake paths). Silently disabled while no VAPID
keys are configured.

Deduplication: an alert is sent once per crossing (keyed by what defines the crossing —
the Trupp's lastContactTime / the reminder's effective dueAt) and re-sent on a slow
cadence while still due. State is in-memory: a restart re-notifies once, which is the
right failure direction for a safety alarm.
"""

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .models import DeploymentConfig, Incident, JournalEntry, PushSubscription

logger = logging.getLogger(__name__)

push_enabled = lambda: bool(settings.vapid_private_key and settings.vapid_public_key)  # noqa: E731

# ---------------------------------------------------------------------------------------
# due-ness (pure, unit-tested — mirrors src/lib/atemschutz.ts + src/lib/reminders.ts)
# ---------------------------------------------------------------------------------------

DEFAULT_INTERVAL_MIN = 5
DEFAULT_GRACE_SEC = 60


def _ms(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def due_trupps(workspace: dict, doctrine: dict, now_ms: float) -> list[dict[str, Any]]:
    """Trupps past interval+grace since last contact (the überfällig alarm)."""
    settings_ws = workspace.get("settings") or {}
    interval_min = settings_ws.get("contactIntervalMin") or doctrine.get("contactIntervalMin") or DEFAULT_INTERVAL_MIN
    grace_sec = settings_ws.get("contactGraceSec") or doctrine.get("contactGraceSec") or DEFAULT_GRACE_SEC
    out = []
    for t in workspace.get("trupps") or []:
        entry = _ms(t.get("entryTime"))
        if not entry or t.get("status") in ("angemeldet", "raus") or t.get("exitTime"):
            continue
        contact = _ms(t.get("lastContactTime")) or entry
        if now_ms - contact >= (interval_min * 60 + grace_sec) * 1000:
            out.append({"id": t.get("id"), "name": t.get("name") or "Trupp", "since": contact})
    return out


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


def _send_one(sub: dict, payload: str) -> bool:
    """Blocking pywebpush send; returns False when the subscription should be pruned
    (endpoint gone per the push service, or the stored keys are unusable)."""
    from pywebpush import WebPushException, webpush

    try:
        webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
            data=payload,
            vapid_private_key=settings.vapid_private_key,
            vapid_claims={"sub": settings.vapid_subject},
            ttl=120,
        )
        return True
    except WebPushException as e:
        code = getattr(getattr(e, "response", None), "status_code", None)
        if code in (404, 410):
            return False  # endpoint gone — caller prunes it
        logger.warning("Web push failed (%s): %s", code, e)
        return True
    except Exception:  # noqa: BLE001 — malformed keys must not abort the whole sweep
        logger.exception("Web push subscription unusable — pruning %s", sub["endpoint"][:60])
        return False


async def broadcast(db: AsyncSession, *, title: str, body: str, tag: str, target: str | None) -> int:
    """Push to every subscribed browser; prunes dead endpoints. Returns the send count."""
    subs = list((await db.execute(select(PushSubscription))).scalars())
    if not subs:
        return 0
    payload = json.dumps({"title": title, "body": body, "tag": tag, "target": target})
    dead: list[str] = []
    for s in subs:
        ok = await asyncio.to_thread(
            _send_one, {"endpoint": s.endpoint, "p256dh": s.p256dh, "auth": s.auth}, payload
        )
        if not ok:
            dead.append(s.endpoint)
    if dead:
        await db.execute(delete(PushSubscription).where(PushSubscription.endpoint.in_(dead)))
        logger.info("Pruned %d dead push subscription(s)", len(dead))
    return len(subs) - len(dead)


async def notify_new_alarm(
    db: AsyncSession, *, tag: str, title: str, address: str | None, target: str | None = "divera"
) -> int:
    """Immediate "Neuer Einsatz" push when a NEW alarm lands (Divera webhook/poll or the
    generic intake) — reaches subscribed browsers even when the PWA is killed. Best-effort:
    a push failure must never break the intake path. No-op without VAPID keys."""
    if not push_enabled():
        return 0
    try:
        body = " — ".join(p for p in (title, address) if p) or "Alarmeingang"
        # target "divera": a tap routes the app to the intake pool (sw-notify.js → App), so
        # the operator lands one tap from taking the alarm. When the incident was already
        # auto-opened there is nothing to take — target None just focuses/boots the app,
        # whose cold-start pick then lands on the newest alarm incident.
        return await broadcast(db, title="Neuer Einsatz", body=body, tag=tag, target=target)
    except Exception:  # noqa: BLE001 — intake must survive a broken push path
        logger.exception("New-alarm push failed (%s)", tag)
        return 0


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
    doctrine_row = (
        await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()
    doctrine = ((doctrine_row.config_json if doctrine_row else {}) or {}).get("doctrine") or {}

    sent = 0
    incidents = list(
        (await db.execute(select(Incident).where(Incident.is_archived.is_(False)))).scalars()
    )
    for inc in incidents:
        ws = inc.map_workspace_json or {}
        for t in due_trupps(ws, doctrine, now_ms):
            key = f"az:{inc.id}:{t['id']}:{t['since']}"
            if _should_send(key, now_ms):
                sent += await broadcast(
                    db,
                    title="Atemschutz überfällig",
                    body=f"{t['name']} — Funkkontakt überfällig",
                    tag=f"atemschutz-{t['id']}",
                    target="atemschutz",
                )
        # journal rows (seq order) + any pre-migration blob rows still carrying reminders
        rows = [
            r.row_json
            for r in (
                await db.execute(
                    select(JournalEntry)
                    .where(JournalEntry.incident_id == inc.id)
                    .order_by(JournalEntry.seq.asc())
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

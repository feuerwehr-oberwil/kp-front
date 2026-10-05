"""«Neuer Objektbesuch» — the push to the accounts an admin picked, and the admin's view of who
is told and where each visit was filed (docs/object-visits.md · «Notification», owner 05.10.2026:
«Push to admins but needs admins to be configurable and not all users / downloads»).

Pinned: nobody is told by default; the push leaves once, after the FIRST completion commits —
never for a draft save point, never for a correction; only the picked, active accounts' browsers
receive it (no kiosk rows, no other account); the admin endpoints read and set exactly that list;
the admin's visit list carries each destination's state and folder.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select

from app import storage as storage_mod
from app.models import ObjectVisitDelivery, PushSubscription, User
from tests.conftest import _make_user
from tests.ov_support import login, make_object, new_id, put, set_config, visit_doc

DEST = {
    "id": "sharepoint-fu",
    "kind": "sharepoint",
    "enabled": True,
    "timing": "every-sync",
    "siteUrl": "https://feuerwehr.sharepoint.com/sites/kp",
    "root": "Einsatzpläne",
}


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_mod, "_ROOT", str(tmp_path))


@pytest_asyncio.fixture
async def on(db_session):
    await set_config(db_session)


@pytest_asyncio.fixture
async def obj(db_session):
    return await make_object(db_session)


@pytest.fixture
def vapid(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "vapid_private_key", "priv")
    monkeypatch.setattr(settings, "vapid_public_key", "pub")


@pytest.fixture
def sent(monkeypatch):
    """Every broadcast the push layer makes, with the audience it resolved after the commit."""
    import app.push as push_mod

    calls: list[dict] = []

    async def fake_broadcast(_db, **kw):
        calls.append(kw)
        return len(kw.get("user_ids") or [])

    monkeypatch.setattr(push_mod, "broadcast", fake_broadcast)
    return calls


async def _settle() -> None:
    import app.push as push_mod

    await asyncio.sleep(0)
    await asyncio.gather(*tuple(push_mod._inflight))


async def _pick(db, *users: User) -> None:
    for u in users:
        u.notify_object_visits = True
    await db.commit()


async def test_nobody_is_told_by_default(client, editor, on, obj, vapid, sent):
    await login(client, editor)
    vid = new_id("ov")
    assert (await put(client, vid, visit_doc(vid, obj, lifecycle="completed"), None)).status_code == 200
    await _settle()
    # queued (push is on), but the audience is empty — broadcast sends nothing for []
    assert [c["user_ids"] for c in sent] == [[]]


async def test_first_completion_pushes_once_to_the_picked_accounts(
    client, editor, viewer, on, obj, db_session, vapid, sent
):
    await _pick(db_session, viewer)
    await login(client, editor)
    vid = new_id("ov")
    r = await put(client, vid, visit_doc(vid, obj, **{"with": ["Frei Nina", "Muster Max"]}), None)
    assert r.status_code == 200
    await _settle()
    assert sent == []  # a draft save point tells nobody

    done = visit_doc(
        vid,
        obj,
        lifecycle="completed",
        answers={"zugaenglich": {"v": "defect", "note": "zugewachsen"}, "oeffnen": {"v": "ok"}},
        **{"with": ["Frei Nina", "Muster Max"]},
    )
    r = await put(client, vid, done, 1)
    assert r.status_code == 200, r.text
    await _settle()
    assert len(sent) == 1
    assert sent[0]["title"] == "Neuer Objektbesuch"
    assert sent[0]["body"] == "Gemeindeverwaltung · Frei Nina, Muster Max · 1 Mangel"
    assert sent[0]["target"] == f"besuch:{vid}" and sent[0]["tag"] == f"ov-{vid}"
    assert sent[0]["user_ids"] == [viewer.id]  # the picked account — not the one who captured

    # a correction of a completed visit is no new visit
    r = await put(client, vid, {**done, "notes": "Nachtrag"}, 2)
    assert r.status_code == 200
    await _settle()
    assert len(sent) == 1


async def test_a_deactivated_account_is_not_told(client, editor, viewer, on, obj, db_session, vapid, sent):
    await _pick(db_session, viewer)
    viewer.is_active = False
    await db_session.commit()
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, visit_doc(vid, obj, lifecycle="completed"), None)
    await _settle()
    assert [c["user_ids"] for c in sent] == [[]]


async def test_push_off_queues_nothing(client, editor, viewer, on, obj, db_session, sent):
    await _pick(db_session, viewer)
    await login(client, editor)
    vid = new_id("ov")
    await put(client, vid, visit_doc(vid, obj, lifecycle="completed"), None)
    await _settle()
    assert sent == []


async def test_broadcast_reaches_only_the_audience(db_session, editor, viewer, monkeypatch):
    """The real sender: with ``user_ids`` only those accounts' browsers — no kiosk row, no other
    account — and an empty audience sends nothing at all."""
    import pywebpush

    from app.push import broadcast

    for user_id, name in ((editor.id, "editor"), (viewer.id, "viewer"), (None, "kiosk")):
        db_session.add(
            PushSubscription(
                user_id=user_id, endpoint=f"https://fcm.googleapis.com/fcm/send/{name}", p256dh="k", auth="a"
            )
        )
    await db_session.commit()
    reached: list[str] = []
    monkeypatch.setattr(
        pywebpush, "webpush", lambda subscription_info, **_kw: reached.append(subscription_info["endpoint"])
    )

    assert await broadcast(db_session, title="T", body="B", tag="t", target=None, user_ids=[viewer.id]) == 1
    assert reached == ["https://fcm.googleapis.com/fcm/send/viewer"]
    assert await broadcast(db_session, title="T", body="B", tag="t", target=None, user_ids=[]) == 0
    assert reached == ["https://fcm.googleapis.com/fcm/send/viewer"]


async def test_admin_reads_and_sets_who_is_told(client, editor, viewer, db_session, admin_login):
    db_session.add(
        PushSubscription(user_id=viewer.id, endpoint="https://fcm.googleapis.com/fcm/send/v1", p256dh="k", auth="a")
    )
    db_session.add(
        PushSubscription(user_id=viewer.id, endpoint="https://fcm.googleapis.com/fcm/send/v2", p256dh="k", auth="a")
    )
    gone = await _make_user(db_session, username="alt", role="viewer")
    gone.is_active = False
    await db_session.commit()

    assert (await client.get("/api/admin/object-visits/notify")).status_code in (401, 403)
    await login(client, editor)  # a field account is not the admin
    assert (await client.put("/api/admin/object-visits/notify", json={"userIds": [str(editor.id)]})).status_code in (
        401,
        403,
    )
    await client.post("/api/auth/logout")
    await admin_login(client)

    state = (await client.get("/api/admin/object-visits/notify")).json()
    assert state["pushEnabled"] is False
    by_name = {a["username"]: a for a in state["accounts"]}
    assert set(by_name) == {"cmd", "view"}  # active accounts only
    assert not any(a["notify"] for a in state["accounts"])  # nobody by default
    assert by_name["view"]["devices"] == 2 and by_name["cmd"]["devices"] == 0

    state = (await client.put("/api/admin/object-visits/notify", json={"userIds": [str(viewer.id)]})).json()
    assert {a["username"]: a["notify"] for a in state["accounts"]} == {"cmd": False, "view": True}
    state = (await client.put("/api/admin/object-visits/notify", json={"userIds": [str(editor.id)]})).json()
    assert {a["username"]: a["notify"] for a in state["accounts"]} == {"cmd": True, "view": False}
    state = (await client.put("/api/admin/object-visits/notify", json={"userIds": []})).json()
    assert not any(a["notify"] for a in state["accounts"])

    for bad in ({"userIds": "x"}, {"userIds": ["not-a-uuid"]}, {"userIds": [1]}, {}):
        r = await client.put("/api/admin/object-visits/notify", json=bad)
        assert r.status_code == 422, bad
    # an id that is no account changes nothing and is no error
    r = await client.put("/api/admin/object-visits/notify", json={"userIds": [str(uuid.uuid4())]})
    assert r.status_code == 200 and not any(a["notify"] for a in r.json()["accounts"])


async def test_admin_list_says_where_each_visit_was_filed(client, editor, on, obj, db_session, admin_login):
    await set_config(db_session, {"destinations": [DEST]})
    await login(client, editor)
    filed, draft = new_id("ov"), new_id("ov")
    await put(client, filed, visit_doc(filed, obj, lifecycle="completed"), None)
    await put(client, draft, visit_doc(draft, obj), None)
    row = (
        await db_session.execute(select(ObjectVisitDelivery).where(ObjectVisitDelivery.visit_id == filed))
    ).scalar_one()
    row.state, row.delivered_revision = "delivered", 1
    row.remote_items = {"_path": "Einsatzpläne/Hauptstrasse 24 - Gemeindeverwaltung/Objektbesuche/2026-10-03 X (abcd)"}
    other = (
        await db_session.execute(select(ObjectVisitDelivery).where(ObjectVisitDelivery.visit_id == draft))
    ).scalar_one()
    other.state, other.last_error = "failed", "403 Forbidden"
    await db_session.commit()
    await client.post("/api/auth/logout")
    await admin_login(client)

    rows = {v["id"]: v for v in (await client.get("/api/admin/object-visits")).json()}
    assert rows[filed]["deliveries"] == [
        {
            "destination": "sharepoint-fu",
            "state": "delivered",
            "revision": 1,
            "at": rows[filed]["deliveries"][0]["at"],
            "folder": "Einsatzpläne/Hauptstrasse 24 - Gemeindeverwaltung/Objektbesuche/2026-10-03 X (abcd)",
        }
    ]
    assert rows[draft]["deliveries"][0]["state"] == "failed"
    assert rows[draft]["deliveries"][0]["error"] == "403 Forbidden"
    assert rows[draft]["deliveries"][0]["folder"] is None
    assert rows[filed]["with"] == ["Frei Nina"]

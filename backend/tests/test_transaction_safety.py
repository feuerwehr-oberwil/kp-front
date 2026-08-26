"""Non-database side effects follow the transaction which made them reachable."""

import asyncio
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app import push, storage, webhooks
from app.models import Incident
from app.transaction_hooks import after_commit, after_rollback

pytestmark = pytest.mark.asyncio


@pytest.fixture
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "_ROOT", str(tmp_path))
    return tmp_path


async def _start_transaction(db) -> None:
    await db.execute(select(Incident.id).limit(1))


async def test_new_blob_is_compensated_on_rollback(db_session, isolated_storage):
    await _start_transaction(db_session)
    storage.put_bytes("media/new.jpg", b"new")
    storage.created_in_transaction(db_session, "media/new.jpg")

    await db_session.rollback()

    assert not storage.exists("media/new.jpg")


async def test_obsolete_blob_is_deleted_only_after_commit(db_session, isolated_storage):
    storage.put_bytes("plans/old.pdf", b"old")
    await _start_transaction(db_session)
    storage.delete_after_commit(db_session, "plans/old.pdf")
    assert storage.exists("plans/old.pdf")

    await db_session.rollback()
    assert storage.exists("plans/old.pdf")

    await _start_transaction(db_session)
    storage.delete_after_commit(db_session, "plans/old.pdf")
    await db_session.commit()
    assert not storage.exists("plans/old.pdf")


async def test_savepoint_completion_does_not_fire_outer_callbacks(db_session):
    seen: list[str] = []
    async with db_session.begin():
        after_commit(db_session, lambda: seen.append("commit"))
        after_rollback(db_session, lambda: seen.append("rollback"))
        async with db_session.begin_nested():
            pass
        assert seen == []
    assert seen == ["commit"]


async def test_savepoint_rollback_compensates_inner_work_but_keeps_outer_callbacks(db_session, isolated_storage):
    seen: list[str] = []
    transaction = await db_session.begin()
    after_commit(db_session, lambda: seen.append("commit"))
    after_rollback(db_session, lambda: seen.append("rollback"))
    savepoint = await db_session.begin_nested()
    storage.put_bytes("media/savepoint.jpg", b"inner")
    storage.created_in_transaction(db_session, "media/savepoint.jpg")
    await savepoint.rollback()
    assert seen == []
    assert not storage.exists("media/savepoint.jpg")

    await transaction.rollback()
    assert seen == ["rollback"]


async def test_successful_savepoint_remains_covered_by_outer_rollback(db_session, isolated_storage):
    transaction = await db_session.begin()
    async with db_session.begin_nested():
        storage.put_bytes("snapshots/inner.json", b"{}")
        storage.created_in_transaction(db_session, "snapshots/inner.json")
    assert storage.exists("snapshots/inner.json")

    await transaction.rollback()
    assert not storage.exists("snapshots/inner.json")


async def test_webhook_is_dropped_on_rollback(db_session, monkeypatch):
    row = Incident(title="Rollback", source="manual", status="offen", started_at=datetime.now(UTC))
    db_session.add(row)
    await db_session.flush()
    calls: list[tuple[str, dict]] = []

    async def fake_deliver(url: str, payload: dict) -> None:
        calls.append((url, payload))

    async def fake_config(_db):
        return type("Config", (), {"webhooks": ["https://hook.example.test/incident"]})()

    monkeypatch.setattr(webhooks, "_deliver", fake_deliver)
    monkeypatch.setattr("app.alarms.get_alarms_config", fake_config)
    await webhooks.notify_incident_created(db_session, row)

    await db_session.rollback()
    await asyncio.sleep(0)
    assert calls == []


async def test_push_runs_after_commit_and_not_after_rollback(db_session, monkeypatch):
    monkeypatch.setattr(push, "push_enabled", lambda: True)
    calls: list[dict] = []

    async def fake_broadcast(_db, **kwargs):
        calls.append(kwargs)
        return 1

    async def fake_load(_db):
        return None

    monkeypatch.setattr(push, "broadcast", fake_broadcast)
    monkeypatch.setattr("app.credentials.load", fake_load)

    await _start_transaction(db_session)
    assert await push.notify_new_alarm(db_session, tag="rolled-back", title="Brand", address=None) == 1
    await db_session.rollback()
    await asyncio.sleep(0)
    assert calls == []

    await _start_transaction(db_session)
    assert await push.notify_new_alarm(db_session, tag="committed", title="Brand", address="Dorf 1") == 1
    await db_session.commit()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert [call["tag"] for call in calls] == ["committed"]

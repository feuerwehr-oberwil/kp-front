"""Deployment-wide scheduler leadership and failover primitives."""

from types import SimpleNamespace

import pytest

from app import scheduler


class _Connection:
    def __init__(self, acquired: bool):
        self.acquired = acquired
        self.commits = 0
        self.closed = False
        self.statements: list[str] = []

    async def scalar(self, statement, params):
        self.statements.append(str(statement))
        assert params == {"lock_id": scheduler.SCHEDULER_ADVISORY_LOCK_ID}
        return self.acquired

    async def execute(self, statement, params=None):
        self.statements.append(str(statement))
        return None

    async def commit(self):
        self.commits += 1

    async def close(self):
        self.closed = True


class _Engine:
    dialect = SimpleNamespace(name="postgresql")

    def __init__(self, connection: _Connection):
        self.connection = connection

    async def connect(self):
        return self.connection


@pytest.mark.asyncio
async def test_scheduler_leader_retains_dedicated_advisory_lock_connection(monkeypatch):
    connection = _Connection(acquired=True)
    monkeypatch.setattr(scheduler, "engine", _Engine(connection))

    held = await scheduler._acquire_scheduler_lock()

    assert held is connection
    assert connection.commits == 1
    assert not connection.closed
    assert connection.statements == ["SELECT pg_try_advisory_lock(:lock_id)"]


@pytest.mark.asyncio
async def test_scheduler_standby_returns_unlocked_connection_to_pool(monkeypatch):
    connection = _Connection(acquired=False)
    monkeypatch.setattr(scheduler, "engine", _Engine(connection))

    held = await scheduler._acquire_scheduler_lock()

    assert held is None
    assert connection.commits == 1
    assert connection.closed


@pytest.mark.asyncio
async def test_scheduler_shutdown_explicitly_unlocks_and_closes(monkeypatch):
    connection = _Connection(acquired=True)
    monkeypatch.setattr(scheduler, "_scheduler_leader_connection", connection)

    await scheduler._release_scheduler_lock()

    assert scheduler._scheduler_leader_connection is None
    assert connection.commits == 1
    assert connection.closed
    assert connection.statements == ["SELECT pg_advisory_unlock(:lock_id)"]

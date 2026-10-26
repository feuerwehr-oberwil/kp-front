"""Configuration preconditions and read-modify-write must share the row's transaction lock.

SQLite's single test connection cannot model two independently committed requests; the race
regression runs on PostgreSQL (including the backend CI job).
"""

import asyncio
import copy
import io
from contextlib import suppress

import pytest
from openpyxl import Workbook
from sqlalchemy import select

from app.models import DeploymentConfig, DeploymentConfigHistory
from app.schemas import DeploymentConfigIn
from app.services.station_workbook import COLUMNS, SHEET_PARTNER


@pytest.mark.asyncio
async def test_overlapping_config_puts_accept_one_version_once(
    client, admin_login, session_factory, db_session, monkeypatch
):
    if db_session.bind.dialect.name != "postgresql":
        pytest.skip("requires independent PostgreSQL transactions")
    import app.api.config as config_api

    await admin_login(client)
    original = DeploymentConfigIn().model_dump(mode="json")
    original["identity"]["appName"] = "Original station"
    db_session.add(DeploymentConfig(id=1, config_json=original))
    await db_session.commit()
    version = (await client.get("/api/config")).json()["version"]
    first_at_write, second_at_write, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    keep_previous = config_api.keep_previous
    calls = 0

    async def hold_first_writer(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            first_at_write.set()
            await asyncio.wait_for(release.wait(), 5)
        else:
            second_at_write.set()
        await keep_previous(*args, **kwargs)

    monkeypatch.setattr(config_api, "keep_previous", hold_first_writer)
    first, second = copy.deepcopy(original), copy.deepcopy(original)
    first["identity"]["appName"] = "Saved station"
    second["doctrine"]["alarmBar"] = 71
    task_a = asyncio.create_task(client.put("/api/config", json=first, headers={"If-Match": version}))
    await asyncio.wait_for(first_at_write.wait(), 5)
    task_b = asyncio.create_task(client.put("/api/config", json=second, headers={"If-Match": version}))
    try:
        # Before the fix the second handler reaches the write while the first is held.
        # With locking it must wait at the SELECT until the first commits.
        with suppress(TimeoutError):
            await asyncio.wait_for(second_at_write.wait(), 0.5)
    finally:
        release.set()
    responses = await asyncio.gather(task_a, task_b)
    assert [r.status_code for r in responses] == [200, 409]
    async with session_factory() as db:
        saved = await db.scalar(select(DeploymentConfig.config_json))
        history = list((await db.scalars(select(DeploymentConfigHistory.config_json))).all())
    assert saved["identity"]["appName"] == "Saved station"
    assert saved["doctrine"]["alarmBar"] is None
    assert history == [original]


@pytest.mark.asyncio
async def test_workbook_import_reloads_config_loaded_before_another_writer(session_factory, db_session):
    from fastapi import UploadFile

    from app.api.station_workbook import import_workbook

    original = DeploymentConfigIn().model_dump(mode="json")
    db_session.add(DeploymentConfig(id=1, config_json=original))
    await db_session.commit()
    book = Workbook()
    sheet = book.active
    sheet.title = SHEET_PARTNER
    sheet.append(list(COLUMNS[SHEET_PARTNER]))
    sheet.append(["Rapport", "Sanität"])
    stream = io.BytesIO()
    book.save(stream)
    async with session_factory() as importer:
        # A connector session may have read configuration before downloading its workbook.
        stale = await importer.get(DeploymentConfig, 1)
        async with session_factory() as other:
            row = await other.get(DeploymentConfig, 1)
            updated = copy.deepcopy(row.config_json)
            updated["doctrine"]["alarmBar"] = 71
            row.config_json = updated
            await other.commit()
        await import_workbook(
            _admin=None,
            actor=None,
            file=UploadFile(io.BytesIO(stream.getvalue()), filename="station.xlsx"),
            digest=None,
            db=importer,
        )
        await importer.commit()
        assert stale.config_json["doctrine"]["alarmBar"] == 71
    async with session_factory() as db:
        saved = await db.scalar(select(DeploymentConfig.config_json))
    assert saved["doctrine"]["alarmBar"] == 71
    assert saved["report"]["partnerOrgs"] == ["Sanität"]

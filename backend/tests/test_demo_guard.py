"""The public demo is a single living incident everyone edits — creating NEW incidents is blocked
server-side (gated on the deployment config's identity.demoMode), while editing stays open."""

import pytest
from sqlalchemy import select

from app.models import DeploymentConfig


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200, r.text


async def _set_demo(db_session, on: bool) -> None:
    row = (
        await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))
    ).scalar_one_or_none()
    identity = {"demoMode": on}
    if row is None:
        db_session.add(DeploymentConfig(id=1, config_json={"identity": identity}))
    else:
        row.config_json = {**(row.config_json or {}), "identity": identity}
    await db_session.commit()


@pytest.mark.asyncio
async def test_demo_blocks_creating_a_new_incident(client, editor, db_session):
    await _login(client, editor)
    await _set_demo(db_session, True)
    r = await client.post("/api/incidents", json={"title": "Neuer Einsatz"})
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_non_demo_allows_creating_a_new_incident(client, editor, db_session):
    await _login(client, editor)
    await _set_demo(db_session, False)
    r = await client.post("/api/incidents", json={"title": "Neuer Einsatz"})
    assert r.status_code == 201, r.text

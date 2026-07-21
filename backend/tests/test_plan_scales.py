"""Station plan-scale calibration endpoint.

- GET is public and starts empty; PUT is editor-only and round-trips; a viewer cannot write.
"""
import pytest

pytestmark = pytest.mark.asyncio

SCALE = {"mPerU": 12.5, "refM": 20.0, "ar": 1.414}


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def test_get_is_public_and_empty_by_default(client):
    r = await client.get("/api/plan-scales")
    assert r.status_code == 200
    assert r.json() == {"default": None, "byPlan": {}}


async def test_editor_puts_and_it_round_trips(client, editor):
    await _login(client, editor)
    body = {"default": SCALE, "byPlan": {"modul1": {"mPerU": 8.0, "refM": 10.0, "ar": 1.414}}}
    r = await client.put("/api/plan-scales", json=body)
    assert r.status_code == 200
    # public GET now returns the stored document
    got = (await client.get("/api/plan-scales")).json()
    assert got["default"] == SCALE
    assert got["byPlan"]["modul1"]["mPerU"] == 8.0


async def test_viewer_cannot_write(client, editor, viewer):
    await _login(client, viewer)
    r = await client.put("/api/plan-scales", json={"default": SCALE, "byPlan": {}})
    assert r.status_code in (401, 403)


async def test_unauthenticated_cannot_write(client):
    r = await client.put("/api/plan-scales", json={"default": SCALE, "byPlan": {}})
    assert r.status_code in (401, 403)


async def test_rejects_degenerate_scale(client, editor):
    await _login(client, editor)
    r = await client.put("/api/plan-scales", json={"default": {"mPerU": 0, "refM": 5, "ar": 1}, "byPlan": {}})
    assert r.status_code == 422

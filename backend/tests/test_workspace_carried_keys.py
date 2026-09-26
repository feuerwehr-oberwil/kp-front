"""A slice an older build does not know survives that build's save (the Suche's rollout, 24.09.2026).

The client of an older build rebuilds the workspace blob from the fields it knows, and its save
replaces the stored blob — so one tablet that had not updated yet erased the whole `suche` slice
for every device. The keys in ``CARRIED_WORKSPACE_KEYS`` are carried over from the stored blob
when a save leaves them out; a save that SENDS the key (every current build does, even when empty)
writes it as sent.
"""

import pytest

from app.api.incidents import CARRIED_WORKSPACE_KEYS

pytestmark = pytest.mark.asyncio

SUCHE = {"personen": [{"id": "p1", "name": "Tim Muster", "createdAt": "", "log": []}], "bereiche": []}


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def test_the_suche_is_a_carried_key():
    assert "suche" in CARRIED_WORKSPACE_KEYS


async def test_a_save_without_the_slice_keeps_the_stored_one(client, editor):
    await _login(client, editor)
    inc_id = (await client.post("/api/incidents", json={"title": "Test Einsatz"})).json()["id"]
    r = await client.put(
        f"/api/incidents/{inc_id}/workspace", json={"base_rev": 0, "workspace": {"entities": [], "suche": SUCHE}}
    )
    assert r.status_code == 200, r.text
    # an older build saves: it knows nothing of `suche`
    r = await client.put(f"/api/incidents/{inc_id}/workspace", json={"base_rev": 1, "workspace": {"entities": []}})
    assert r.status_code == 200, r.text
    stored = (await client.get(f"/api/incidents/{inc_id}/workspace")).json()["workspace"]
    assert stored["suche"] == SUCHE


async def test_a_save_that_sends_the_slice_writes_it_as_sent(client, editor):
    await _login(client, editor)
    inc_id = (await client.post("/api/incidents", json={"title": "Test Einsatz"})).json()["id"]
    await client.put(f"/api/incidents/{inc_id}/workspace", json={"base_rev": 0, "workspace": {"suche": SUCHE}})
    empty = {"personen": [], "bereiche": []}
    r = await client.put(f"/api/incidents/{inc_id}/workspace", json={"base_rev": 1, "workspace": {"suche": empty}})
    assert r.status_code == 200, r.text
    stored = (await client.get(f"/api/incidents/{inc_id}/workspace")).json()["workspace"]
    assert stored["suche"] == empty

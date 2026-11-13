"""The incident list names each RUNNING Einsatz's Trupps at the alarm tier (FLOW.1, 13.11.2026).

A device standing in Einsatz B marks Einsatz A in its switcher — and, from an Übung, raises A's
alarm — off this field. The tier is the push sweep's (push · due_trupps, tested in test_push.py);
what is under test here is which Einsätze carry it.
"""

import pytest

pytestmark = pytest.mark.asyncio

# entered hours ago, never a Funkkontakt: overdue by any interval in range
OVERDUE = {"id": "tr1", "name": "Trupp 1", "status": "aktiv", "entryTime": "2026-01-01T10:00:00Z"}
OUT = {**OVERDUE, "id": "tr2", "name": "Trupp 2", "status": "raus", "exitTime": "2026-01-01T10:10:00Z"}


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _incident(client, trupps: list[dict], **body) -> str:
    r = await client.post("/api/incidents", json={"title": "Liste", **body})
    assert r.status_code == 201, r.text
    inc = r.json()["id"]
    r = await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": {"trupps": trupps}, "base_rev": 0})
    assert r.status_code == 200, r.text
    return inc


async def _listed(client, inc: str, archived: str = "false") -> dict:
    return next(i for i in (await client.get(f"/api/incidents?archived={archived}")).json() if i["id"] == inc)


async def test_a_running_einsatz_names_its_overdue_trupps_only(client, editor):
    await _login(client, editor)
    inc = await _incident(client, [OVERDUE, OUT])
    quiet = await _incident(client, [OUT])
    assert (await _listed(client, inc))["atemschutz_due"] == [{"id": "tr1", "name": "Trupp 1", "reason": "contact"}]
    assert (await _listed(client, quiet))["atemschutz_due"] == []


async def test_an_uebung_carries_it_too(client, editor):
    """The client decides what an Übung's alarm may do on another device — the list says the fact."""
    await _login(client, editor)
    inc = await _incident(client, [{**OVERDUE, "notfallAt": "2026-01-01T10:20:00Z"}], is_exercise=True)
    assert [t["reason"] for t in (await _listed(client, inc))["atemschutz_due"]] == ["notfall"]


async def test_a_closed_einsatz_alarms_nothing(client, editor):
    await _login(client, editor)
    inc = await _incident(client, [OVERDUE])
    assert (await client.patch(f"/api/incidents/{inc}", json={"is_archived": True})).status_code == 200
    assert (await _listed(client, inc, archived="true"))["atemschutz_due"] == []

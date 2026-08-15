"""Config history + restore over HTTP — the undo that only existed as a shell command.

Every write already kept the document it replaced; the table was simply unreachable from a
browser. That is the recovery path for a failure this project has now had four times, and it
required an SSH session and a Python module while the damage was live.
"""

import pytest


async def _login(client, editor):
    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "112118"})


@pytest.fixture
async def three_writes(client, editor, admin_login):
    """A populated config, then a write that guts it — the incident, in miniature."""
    await _login(client, editor)
    await admin_login(client)
    full = {
        "identity": {"appName": "Feuerwehr Musterdorf"},
        "report": {"partnerOrgs": ["Polizei", "Sanität"]},
        "roster": {"ranks": [{"key": "of", "label": "Offizier"}]},
    }
    r1 = await client.put("/api/config", json=full)
    assert r1.status_code == 200, r1.text
    # …and now the clobber: the same document minus everything that made it a station
    r2 = await client.put(
        "/api/config",
        json={"identity": {"appName": "Feuerwehr Musterdorf"}},
        headers={"If-Match": r1.json()["version"]},
    )
    assert r2.status_code == 200, r2.text


async def test_history_names_what_a_write_emptied(client, three_writes):
    r = await client.get("/api/config/history")
    assert r.status_code == 200, r.text
    rows = r.json()
    assert rows, "every write keeps its predecessor; the list must not be empty"

    # newest first: row 0 is the state BEFORE the clobber, so ITS successor is the gutted live
    # document — which is exactly the entry an operator needs to find and put back
    newest = rows[0]
    assert set(newest["emptied"]) >= {"report.partnerOrgs", "roster.ranks"}, newest
    assert "identity" in newest["sections"]
    assert newest["source"] == "api"


async def test_history_is_admin_only(client, editor):
    """A PIN session is not enough: the list carries every past configuration."""
    await _login(client, editor)
    assert (await client.get("/api/config/history")).status_code in (401, 403)


async def test_restore_puts_the_station_back(client, three_writes):
    rows = (await client.get("/api/config/history")).json()
    target = rows[0]["id"]

    r = await client.post(f"/api/config/history/{target}/restore")
    assert r.status_code == 200, r.text
    assert r.json()["report"]["partnerOrgs"] == ["Polizei", "Sanität"]
    assert (await client.get("/api/config")).json()["roster"]["ranks"], "the live document must be back"


async def test_a_restore_is_itself_undoable(client, three_writes):
    """Including a restore of the WRONG entry — the mistake somebody makes while hurrying."""
    before = (await client.get("/api/config/history")).json()
    await client.post(f"/api/config/history/{before[0]['id']}/restore")
    after = (await client.get("/api/config/history")).json()
    assert len(after) == len(before) + 1, "the document the restore replaced must be kept too"


async def test_restoring_something_that_is_not_there(client, editor, admin_login):
    await _login(client, editor)
    await admin_login(client)
    assert (await client.post("/api/config/history/999999/restore")).status_code == 404

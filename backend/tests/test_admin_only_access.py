"""Admin-secret-only /admin: shared endpoints accept the admin session (UserOrAdmin /
EditorOrAdmin) so the admin UI works without any kiosk roster login. Contract:
- no session at all → 401;
- kiosk viewer → read yes, write no (role check keeps holding);
- admin session alone → read AND write (identity stamps NULL, like the CLI)."""


async def test_personnel_requires_some_session(client):
    r = await client.get("/api/personnel")
    assert r.status_code == 401
    r = await client.post("/api/personnel", json={"display_name": "Neu"})
    assert r.status_code == 401


async def test_admin_session_alone_reads_and_writes_personnel(client, admin_login):
    await admin_login(client)
    r = await client.get("/api/personnel")
    assert r.status_code == 200
    r = await client.post("/api/personnel", json={"display_name": "Muster Max"})
    assert r.status_code == 201
    r = await client.get("/api/personnel")
    assert any(p["display_name"] == "Muster Max" for p in r.json())


async def test_viewer_reads_but_cannot_write_personnel(client, viewer):
    lr = await client.post("/api/auth/login", json={"user_id": str(viewer.id), "pin": "135790"})
    assert lr.status_code == 200
    r = await client.get("/api/personnel")
    assert r.status_code == 200
    r = await client.post("/api/personnel", json={"display_name": "Nope"})
    assert r.status_code == 403


async def test_admin_session_passes_divera_refresh_auth(client, admin_login):
    await admin_login(client)
    # auth passes — anything but 401/403 (503 = Divera unconfigured, 200 = test env has a key)
    r = await client.post("/api/divera/pool/refresh")
    assert r.status_code not in (401, 403)

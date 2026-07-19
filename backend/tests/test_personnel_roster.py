"""Integration tests for the manual roster CRUD + CSV import (Batch D).

Covers create / patch / deactivate (editor-only), a CSV happy-path with upsert by
divera_id, and a bad-row error. Runs against the test DB (SQLite locally, postgres in CI).
"""

import pytest

pytestmark = pytest.mark.asyncio


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


# --- access control ----------------------------------------------------------------


async def test_create_requires_editor(client, viewer):
    await _login(client, viewer)
    r = await client.post("/api/personnel", json={"display_name": "Muster Max"})
    assert r.status_code == 403


# --- create / patch / deactivate ----------------------------------------------------


async def test_create_patch_deactivate(client, editor):
    await _login(client, editor)

    # create
    r = await client.post("/api/personnel", json={"display_name": "Meier Hptm"})
    assert r.status_code == 201, r.text
    person = r.json()
    pid = person["id"]
    assert person["divera_id"] is None
    assert person["external_identities"] == []
    assert person["display_name"] == "Meier Hptm"
    assert person["is_active"] is True

    # patch
    r = await client.patch(f"/api/personnel/{pid}", json={"display_name": "Meier Maj"})
    assert r.status_code == 200
    assert r.json()["display_name"] == "Meier Maj"

    # deactivate (soft)
    r = await client.delete(f"/api/personnel/{pid}")
    assert r.status_code == 200
    assert r.json() == {"ok": True}

    # default list excludes inactive; include_inactive surfaces it again
    assert all(p["id"] != pid for p in (await client.get("/api/personnel")).json())
    inactive = (await client.get("/api/personnel?include_inactive=true")).json()
    found = next(p for p in inactive if p["id"] == pid)
    assert found["is_active"] is False

    # reactivate via PATCH
    r = await client.patch(f"/api/personnel/{pid}", json={"is_active": True})
    assert r.json()["is_active"] is True


async def test_patch_missing_404(client, editor):
    await _login(client, editor)
    import uuid

    r = await client.patch(f"/api/personnel/{uuid.uuid4()}", json={"display_name": "X"})
    assert r.status_code == 404


# --- CSV import ---------------------------------------------------------------------


async def test_import_csv_happy_path(client, editor):
    await _login(client, editor)
    csv_text = (
        "name,divera_id\n"
        "Meier Hans,1001\n"
        "Müller Anna,\n"
    )
    files = {"file": ("roster.csv", csv_text.encode("utf-8"), "text/csv")}
    r = await client.post("/api/personnel/import-csv", files=files)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"imported": 2, "skipped": 0, "errors": []}

    roster = (await client.get("/api/personnel")).json()
    by_name = {p["display_name"]: p for p in roster}
    assert by_name["Meier Hans"]["divera_id"] == 1001
    assert by_name["Müller Anna"]["divera_id"] is None

    # re-import upserts by divera_id (no duplicate row for 1001)
    csv2 = "name,divera_id\nMeier Hans-Peter,1001\n"
    files2 = {"file": ("roster.csv", csv2.encode("utf-8"), "text/csv")}
    r2 = await client.post("/api/personnel/import-csv", files=files2)
    assert r2.json()["imported"] == 1
    roster2 = (await client.get("/api/personnel?include_inactive=true")).json()
    meier_rows = [p for p in roster2 if p["divera_id"] == 1001]
    assert len(meier_rows) == 1
    assert meier_rows[0]["display_name"] == "Meier Hans-Peter"


async def test_import_csv_accepts_opaque_provider_identity(client, editor):
    await _login(client, editor)
    csv_text = "name,rank,provider,external_id\nRossi Lea,Fwm,example,crew-7a\n"
    files = {"file": ("roster.csv", csv_text.encode("utf-8"), "text/csv")}

    r = await client.post("/api/personnel/import-csv", files=files)
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 1

    roster = (await client.get("/api/personnel")).json()
    person = next(p for p in roster if p["display_name"] == "Rossi Lea")
    assert person["divera_id"] is None
    assert len(person["external_identities"]) == 1
    assert person["external_identities"][0]["provider"] == "example"
    assert person["external_identities"][0]["external_id"] == "crew-7a"
    assert person["external_identities"][0]["synced_at"] is not None

    # The external identity, not the display name, is the stable upsert key.
    csv_text = "name,provider,external_id\nRossi Lea-Maria,example,crew-7a\n"
    files = {"file": ("roster.csv", csv_text.encode("utf-8"), "text/csv")}
    r = await client.post("/api/personnel/import-csv", files=files)
    assert r.status_code == 200, r.text
    matching = [
        p for p in (await client.get("/api/personnel")).json()
        if any(i["external_id"] == "crew-7a" for i in p["external_identities"])
    ]
    assert len(matching) == 1
    assert matching[0]["display_name"] == "Rossi Lea-Maria"


async def test_import_csv_bad_row(client, editor):
    await _login(client, editor)
    csv_text = (
        "name,divera_id\n"
        "Gut Gustav,5\n"
        ",9\n"               # missing name → skipped
        "Falsch Franz,abc\n"  # non-int divera_id → skipped
    )
    files = {"file": ("roster.csv", csv_text.encode("utf-8"), "text/csv")}
    r = await client.post("/api/personnel/import-csv", files=files)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["imported"] == 1
    assert body["skipped"] == 2
    assert len(body["errors"]) == 2


async def test_import_csv_with_rank_column(client, editor):
    await _login(client, editor)
    # rank given by label / abbr / key — all map to the config rank key; unknown → null + note
    csv_text = (
        "name,divera_id,rank\n"
        "Meier Hans,1001,Hauptmann\n"
        "Müller Anna,,Fwm\n"
        "Weber Urs,,Admiral\n"
    )
    files = {"file": ("roster.csv", csv_text.encode("utf-8"), "text/csv")}
    r = await client.post("/api/personnel/import-csv", files=files)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["imported"] == 3
    assert any("Admiral" in e for e in body["errors"])  # unknown rank noted, row still imported

    by_name = {p["display_name"]: p for p in (await client.get("/api/personnel")).json()}
    assert by_name["Meier Hans"]["rank"] == "hptm"
    assert by_name["Müller Anna"]["rank"] == "fwm"
    assert by_name["Weber Urs"]["rank"] is None


async def test_import_csv_missing_name_column_400(client, editor):
    await _login(client, editor)
    files = {"file": ("roster.csv", b"divera_id,foo\n1,bar\n", "text/csv")}
    r = await client.post("/api/personnel/import-csv", files=files)
    assert r.status_code == 400

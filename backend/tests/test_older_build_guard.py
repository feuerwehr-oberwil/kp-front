"""A save from an OLDER build never overwrites a newer build's blob (sweep 30.10.2026 #19).

An old build drops what it cannot read at its load gate (and never writes a key it does not
know), so its full save — and its Trupp or record slice, which replace those keys wholesale —
would delete what a newer build wrote. Such a save is refused whole: 409 `workspace_older_build`,
nothing written (workspace_kinds · refuse_older_build).
"""

from app.workspace_kinds import UNVERSIONED_SLICE_VERSION, WORKSPACE_OLDER_BUILD_CODE

TRUPP = {"id": "tr1", "name": "Trupp 1", "status": "aktiv", "entryTime": "2026-10-30T12:00:00Z"}
NEWER = UNVERSIONED_SLICE_VERSION + 1


async def _seeded(client, editor, version: int) -> tuple[str, int]:
    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert r.status_code == 200
    inc = (await client.post("/api/incidents", json={"title": "Brand"})).json()["id"]
    ws = {"schemaVersion": version, "trupps": [TRUPP], "future": {"kept": True}}
    r = await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": ws, "base_rev": 0})
    assert r.status_code == 200, r.text
    return inc, r.json()["workspace_rev"]


def _refused(r, stored: int) -> None:
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == WORKSPACE_OLDER_BUILD_CODE
    assert r.json()["detail"]["stored_version"] == stored


async def _stored(client, inc):
    return (await client.get(f"/api/incidents/{inc}/workspace")).json()


async def test_an_older_full_save_is_refused_and_writes_nothing(client, editor):
    inc, rev = await _seeded(client, editor, NEWER)
    r = await client.put(
        f"/api/incidents/{inc}/workspace",
        json={"workspace": {"schemaVersion": NEWER - 1, "trupps": []}, "base_rev": rev},
    )
    _refused(r, NEWER)
    # an unstamped blob is the oldest build there is
    r = await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": {"trupps": []}, "base_rev": rev})
    _refused(r, NEWER)
    after = await _stored(client, inc)
    assert after["workspace_rev"] == rev
    assert after["workspace"]["trupps"] == [TRUPP] and after["workspace"]["future"] == {"kept": True}


async def test_an_equal_or_newer_full_save_goes_through(client, editor):
    inc, rev = await _seeded(client, editor, NEWER)
    r = await client.put(
        f"/api/incidents/{inc}/workspace", json={"workspace": {"schemaVersion": NEWER, "trupps": []}, "base_rev": rev}
    )
    assert r.status_code == 200, r.text
    r = await client.put(
        f"/api/incidents/{inc}/workspace", json={"workspace": {"schemaVersion": NEWER + 1}, "base_rev": rev + 1}
    )
    assert r.status_code == 200, r.text


async def test_a_stale_revision_is_still_the_revision_conflict_first(client, editor):
    # the merge-and-retry answer comes before the version: a refused save always sits on the current blob
    inc, rev = await _seeded(client, editor, NEWER)
    r = await client.put(
        f"/api/incidents/{inc}/workspace", json={"workspace": {"schemaVersion": 1}, "base_rev": rev - 1}
    )
    assert r.status_code == 409 and r.json()["detail"].get("code") != WORKSPACE_OLDER_BUILD_CODE


async def test_a_trupp_slice_without_a_version_is_refused_once_the_stored_blob_is_newer(client, editor):
    inc, rev = await _seeded(client, editor, NEWER)
    kontakt = {**TRUPP, "lastContactTime": "2026-10-30T12:10:00Z"}
    _refused(
        await client.put(f"/api/incidents/{inc}/workspace/trupps", json={"trupps": [kontakt], "base_rev": rev}), NEWER
    )
    _refused(
        await client.put(
            f"/api/incidents/{inc}/workspace/trupps",
            json={"trupps": [kontakt], "base_rev": rev, "schemaVersion": NEWER - 1},
        ),
        NEWER,
    )
    assert (await _stored(client, inc))["workspace"]["trupps"] == [TRUPP]
    r = await client.put(
        f"/api/incidents/{inc}/workspace/trupps", json={"trupps": [kontakt], "base_rev": rev, "schemaVersion": NEWER}
    )
    assert r.status_code == 200, r.text


async def test_a_trupp_slice_from_a_current_build_goes_through_with_or_without_its_version(client, editor):
    # builds in the field before 30.10.2026 send no version: they are current while the blob is too
    inc, rev = await _seeded(client, editor, UNVERSIONED_SLICE_VERSION)
    kontakt = {**TRUPP, "lastContactTime": "2026-10-30T12:10:00Z"}
    r = await client.put(f"/api/incidents/{inc}/workspace/trupps", json={"trupps": [kontakt], "base_rev": rev})
    assert r.status_code == 200, r.text
    r = await client.put(
        f"/api/incidents/{inc}/workspace/trupps",
        json={"trupps": [TRUPP], "base_rev": rev + 1, "schemaVersion": UNVERSIONED_SLICE_VERSION},
    )
    assert r.status_code == 200, r.text


async def test_the_record_slice_takes_the_same_rule(client, editor):
    inc, rev = await _seeded(client, editor, NEWER)
    record = {"mittel": [{"id": "m1", "label": "Schaum", "unit": "l"}]}
    _refused(
        await client.put(f"/api/incidents/{inc}/workspace/record", json={"workspace": record, "base_rev": rev}), NEWER
    )
    r = await client.put(
        f"/api/incidents/{inc}/workspace/record",
        json={"workspace": {**record, "schemaVersion": NEWER}, "base_rev": rev},
    )
    assert r.status_code == 200, r.text
    stored = (await _stored(client, inc))["workspace"]
    assert stored["schemaVersion"] == NEWER  # a slice never re-stamps the blob

"""Annual plans preserve past work, are atomic, and reject stale administrators."""

import pytest
import pytest_asyncio

from tests.ov_support import bearer, set_config, set_key

BASE = "/api/integrations/visit-programmes/fwo-admin:fu"


@pytest_asyncio.fixture
async def prepared(client, db_session):
    await set_config(db_session)
    await set_key(db_session)
    for code in ["A", "B", "C"]:
        result = await client.put(f"/api/integrations/objects/fwo/{code}", headers=bearer(), json={"name": code})
        assert result.status_code == 200
    return [
        {"code": code, "title": f"Route {code}", "objects": [{"source": "fwo", "id": code}], "retired": False}
        for code in ["A", "B"]
    ]


async def save(client, revision, routes):
    return await client.put(BASE + "/routes", headers=bearer(), json={"revision": revision, "routes": routes})


async def publish(client, revision, assignments, year=2027):
    return await client.put(
        BASE + f"/years/{year}", headers=bearer(), json={"revision": revision, "assignments": assignments}
    )


def assignment(code="A", day="2027-03-28"):
    return {"code": code, "scheduledOn": day}


async def catalogue(client):
    return (await client.get("/api/integrations/object-visits/catalogue", headers=bearer())).json()["lists"]


async def test_templates_stay_off_field_and_only_selected_routes_publish(client, prepared):
    assert (await client.get(BASE, headers=bearer())).json()["revision"] == 0
    result = await save(client, 0, prepared)
    assert result.status_code == 200, result.text
    assert await catalogue(client) == []
    result = await publish(client, 1, [assignment()])
    assert result.status_code == 200, result.text
    lists = await catalogue(client)
    assert len(lists) == 1 and lists[0]["ref"] == "fwo-admin:fu-2027/A"
    assert lists[0]["scheduledOn"] == "2027-03-28" and not lists[0]["archived"]
    assert not lists[0]["done"]
    assert result.json()["years"] == [2027]


async def test_route_edits_rescheduling_and_withdrawal_preserve_snapshots(client, prepared):
    await save(client, 0, prepared)
    await publish(client, 1, [assignment()])
    original = (await catalogue(client))[0]
    prepared[0]["objects"].append({"source": "fwo", "id": "C"})
    assert (await save(client, 2, prepared)).status_code == 200
    assert (await publish(client, 3, [assignment(day="2027-04-04")])).status_code == 200
    rescheduled = (await catalogue(client))[0]
    assert rescheduled["objectIds"] == original["objectIds"]
    assert rescheduled["scheduledOn"] == "2027-04-04"
    assert (await publish(client, 4, [])).status_code == 200
    assert (await catalogue(client))[0]["archived"] is True
    assert (await publish(client, 5, [assignment()])).status_code == 200
    assert (await catalogue(client))[0]["objectIds"] == original["objectIds"]
    await publish(client, 6, [assignment(day="2028-04-04")], year=2028)
    lists = await catalogue(client)
    assert len(next(x for x in lists if x["ref"].endswith("2028/A"))["objectIds"]) == 2


async def test_legacy_completions_survive_migration_and_old_clients_cannot_overwrite(client, prepared):
    ref = "fwo-admin:fu-2026/A"
    legacy = {
        "title": "FU 2026 · A",
        "objects": [{"source": "fwo", "id": "A", "done": {"at": "2026-05-30", "source": "SchlüHü"}}],
    }
    assert (await client.put(f"/api/integrations/visit-lists/{ref}", headers=bearer(), json=legacy)).status_code == 200
    await save(client, 0, prepared)
    assert (await publish(client, 1, [assignment(day="2026-05-30")], year=2026)).status_code == 200
    lists = await catalogue(client)
    assert len(lists[0]["done"]) == 1
    for method in ["PUT", "DELETE"]:
        result = await client.request(method, f"/api/integrations/visit-lists/{ref}", headers=bearer(), json=legacy)
        assert result.status_code == 409
    await publish(client, 2, [], year=2026)
    lists = await catalogue(client)
    assert lists[0]["archived"] and len(lists[0]["done"]) == 1
    await publish(client, 3, [assignment()])
    assert not next(x for x in await catalogue(client) if "2027/" in x["ref"])["done"]


async def test_stale_admin_cannot_replace_routes_or_year(client, prepared):
    await save(client, 0, prepared)
    assert (await save(client, 0, prepared)).status_code == 409
    assert (await publish(client, 0, [assignment()])).status_code == 409
    assert not await catalogue(client)


@pytest.mark.parametrize(
    "assignments",
    [
        [assignment(), assignment()],
        [assignment(day="2028-01-01")],
        [assignment(day="2027-02-30")],
        [assignment(code="UNKNOWN")],
    ],
)
async def test_invalid_plan_changes_nothing(client, prepared, assignments):
    await save(client, 0, prepared)
    response = await publish(client, 1, assignments)
    assert response.status_code == 422, response.text
    assert await catalogue(client) == []
    assert (await client.get(BASE, headers=bearer())).json()["revision"] == 1


async def test_atomic_publication_failure_keeps_existing_plan(client, prepared):
    await save(client, 0, prepared)
    await publish(client, 1, [assignment()])
    prepared[1]["objects"] = [{"source": "fwo", "id": "unknown"}]
    await save(client, 2, prepared)
    result = await publish(client, 3, [assignment(day="2027-04-04"), assignment(code="B")])
    assert result.status_code == 422
    lists = await catalogue(client)
    assert len(lists) == 1 and lists[0]["scheduledOn"] == "2027-03-28"


async def test_retirement_is_reversible_but_deleting_route_is_refused(client, prepared):
    await save(client, 0, prepared)
    assert (await save(client, 1, prepared[:1])).status_code == 422
    prepared[0]["retired"] = True
    assert (await save(client, 1, prepared)).status_code == 200
    assert (await publish(client, 2, [assignment()])).status_code == 422
    prepared[0]["retired"] = False
    assert (await save(client, 2, prepared)).status_code == 200
    assert (await publish(client, 3, [assignment()])).status_code == 200


async def test_programme_requires_organizer_and_enabled_module(client, db_session):
    assert (await client.get(BASE)).status_code in (401, 403)
    await set_key(db_session)
    assert (await client.get(BASE, headers=bearer())).status_code == 404


async def test_old_cleanup_cannot_detach_a_route_or_historic_round(client, prepared):
    await save(client, 0, prepared)
    assert (await client.delete("/api/integrations/objects/fwo/A", headers=bearer())).status_code == 409
    await publish(client, 1, [assignment()])
    prepared[0]["objects"] = [{"source": "fwo", "id": "C"}]
    await save(client, 2, prepared)
    await publish(client, 3, [])
    assert (await client.delete("/api/integrations/objects/fwo/A", headers=bearer())).status_code == 409


async def test_concurrent_administrators_one_wins(client, prepared, database_url):
    import asyncio

    if not database_url.startswith("postgresql"):
        pytest.skip("Row-lock concurrency needs independent PostgreSQL transactions")
    await save(client, 0, prepared)
    results = await asyncio.gather(publish(client, 1, [assignment()]), publish(client, 1, [assignment("B")]))
    assert sorted(r.status_code for r in results) == [200, 409]
    assert len(await catalogue(client)) == 1


async def test_completed_visit_survives_rescheduling_and_withdrawal(client, prepared, db_session, editor):
    from types import SimpleNamespace

    from tests.ov_support import login, new_id, put, visit_doc

    await save(client, 0, prepared)
    await publish(client, 1, [assignment()])
    obj = (await client.get("/api/integrations/objects/by-ref/fwo/A", headers=bearer())).json()
    await login(client, editor)
    vid = new_id("ov")
    doc = visit_doc(
        vid,
        SimpleNamespace(id=obj["objectId"], name=obj["name"], address=obj["address"]),
        workRef="fwo-admin:fu-2027/A",
        lifecycle="completed",
        visitedAt="2027-03-28T10:00:00+02:00",
    )
    response = await put(client, vid, doc, None)
    assert response.status_code == 200, response.text
    await publish(client, 2, [assignment(day="2027-04-04")])
    await publish(client, 3, [])
    actual = (await client.get(f"/api/integrations/object-visits/{vid}", headers=bearer())).json()
    assert actual["workRef"] == doc["workRef"] and actual["visitedAt"] == doc["visitedAt"]
    assert actual["lifecycle"] == "completed" and actual["revision"] == 1

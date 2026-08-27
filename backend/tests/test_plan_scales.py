"""Station plan-scale calibration + georeferencing endpoint.

- GET is public and starts empty; PUT is editor-only and round-trips; a viewer cannot write.
- The georeference (landmark pairs per plan) shares the document and stays backward compatible:
  a body without it still validates, and the PUT replaces the WHOLE document.
- A stored document that is partly malformed is served entry by entry, never blanked wholesale.
"""

import pytest

pytestmark = pytest.mark.asyncio

SCALE = {"mPerU": 12.5, "refM": 20.0, "ar": 1.414}
PAIRS = [
    {"plan": {"x": 0.21, "y": 0.78}, "lngLat": {"lng": 7.5461, "lat": 47.5072}, "kind": "gesetzt"},
    {"plan": {"x": 0.79, "y": 0.31}, "lngLat": {"lng": 7.5489, "lat": 47.5091}, "kind": "korrigiert"},
]


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def test_get_is_public_and_empty_by_default(client):
    r = await client.get("/api/plan-scales")
    assert r.status_code == 200
    assert r.json() == {"default": None, "byPlan": {}, "georefByPlan": {}}


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


async def test_georef_round_trips(client, editor):
    await _login(client, editor)
    body = {"default": SCALE, "byPlan": {}, "georefByPlan": {"modul1": {"pairs": PAIRS}}}
    assert (await client.put("/api/plan-scales", json=body)).status_code == 200
    got = (await client.get("/api/plan-scales")).json()
    assert got["georefByPlan"]["modul1"]["pairs"] == PAIRS


async def test_document_without_georef_still_validates(client, editor):
    """A body (and therefore a row) written before georeferencing existed stays readable."""
    await _login(client, editor)
    assert (await client.put("/api/plan-scales", json={"default": SCALE, "byPlan": {}})).status_code == 200
    got = (await client.get("/api/plan-scales")).json()
    assert got["georefByPlan"] == {}


async def test_put_replaces_the_whole_document(client, editor):
    """The client must read-modify-write: a body that omits the georef half DROPS it."""
    await _login(client, editor)
    await client.put(
        "/api/plan-scales", json={"default": SCALE, "byPlan": {}, "georefByPlan": {"m1": {"pairs": PAIRS}}}
    )
    await client.put("/api/plan-scales", json={"default": SCALE, "byPlan": {}})
    assert (await client.get("/api/plan-scales")).json()["georefByPlan"] == {}


async def test_viewer_cannot_write_a_georef(client, editor, viewer):
    await _login(client, viewer)
    r = await client.put("/api/plan-scales", json={"georefByPlan": {"m1": {"pairs": PAIRS}}})
    assert r.status_code in (401, 403)


async def test_rejects_plan_pixels_mistaken_for_normalized_coords(client, editor):
    await _login(client, editor)
    bad = {"plan": {"x": 1100, "y": 702}, "lngLat": {"lng": 7.54, "lat": 47.5}}
    r = await client.put("/api/plan-scales", json={"georefByPlan": {"m1": {"pairs": [bad]}}})
    assert r.status_code == 422


async def test_rejects_out_of_range_coordinates(client, editor):
    await _login(client, editor)
    bad = {"plan": {"x": 0.5, "y": 0.5}, "lngLat": {"lng": 7.54, "lat": 947.5}}
    r = await client.put("/api/plan-scales", json={"georefByPlan": {"m1": {"pairs": [bad]}}})
    assert r.status_code == 422


async def test_one_bad_georef_entry_does_not_blank_the_others(client, db_session):
    """The 3am case: ONE plan holds a georef the current format rejects (here a latitude of 947,
    the kind of value a pre-format or hand-edited entry carries). All-or-nothing validation made
    GET return empty, so every plan station-wide reverted to «kalibrieren» at once, with the cause
    only in the server log. Everything that still parses must survive its neighbour."""
    from app.models import DeploymentConfig

    db_session.add(
        DeploymentConfig(
            id=1,
            plan_scales_json={
                "default": SCALE,
                "byPlan": {"modul1": {"mPerU": 8.0, "refM": 10.0, "ar": 1.414}},
                "georefByPlan": {
                    "bad": {"pairs": [{"plan": {"x": 0.5, "y": 0.5}, "lngLat": {"lng": 7.54, "lat": 947.5}}]},
                    "good": {"pairs": PAIRS},
                },
            },
        )
    )
    await db_session.commit()

    got = (await client.get("/api/plan-scales")).json()
    assert got["default"] == SCALE
    assert got["byPlan"]["modul1"]["mPerU"] == 8.0
    assert got["georefByPlan"]["good"]["pairs"] == PAIRS
    assert "bad" not in got["georefByPlan"]

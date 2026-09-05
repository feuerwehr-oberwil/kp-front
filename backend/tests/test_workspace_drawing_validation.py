"""SEC-01 · a saved workspace may not carry a colour that becomes markup.

The client draws a shape's outline into an SVG attribute (``src/lib/shapes.tsx``), so a colour
carrying a quote used to close that attribute and open an event handler in the next operator's
browser. The renderer is fixed; this is the persistence boundary that stops a hostile value
from ever being stored — and from being handed to a device that has not updated yet.

Neutralise, never reject: an incident whose blob is refused stops syncing on every tablet, so
the offending property is dropped and the object keeps its geometry and its clocks.
"""

import pytest

from app.schemas import WorkspacePut

HOSTILE = 'red" onmouseover="window.__pwned=1'


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


# --- The schema itself ---------------------------------------------------------------


def test_hostile_colour_is_dropped_everywhere_it_can_hide():
    body = WorkspacePut(
        base_rev=0,
        workspace={
            "entities": [{"id": "e1", "kind": "shape", "color": HOSTILE}],
            "drawings": [{"id": "d1", "kind": "area", "color": HOSTILE}],
            "board": {"plan-1": [{"id": "b1", "kind": "shape", "color": HOSTILE}]},
            "trupps": [{"id": "t1", "color": HOSTILE}],
        },
    )
    ws = body.workspace
    assert "color" not in ws["entities"][0]
    assert "color" not in ws["drawings"][0]
    assert "color" not in ws["board"]["plan-1"][0]
    assert "color" not in ws["trupps"][0]
    # …and nothing else about the objects is touched
    assert ws["entities"][0]["kind"] == "shape"


def test_every_colour_the_app_writes_survives():
    colours = ["#1f6feb", "#fff", "#e8392bcc", "rgba(31, 111, 235, 0.5)", "rgb(0,0,0)", "white"]
    body = WorkspacePut(
        base_rev=0,
        workspace={"entities": [{"id": f"e{i}", "color": c} for i, c in enumerate(colours)]},
    )
    assert [e["color"] for e in body.workspace["entities"]] == colours


def test_colour_null_still_means_back_to_automatic():
    # ``Trupp.color: null`` is «zurück auf automatisch» and is distinct from an absent key
    body = WorkspacePut(base_rev=0, workspace={"trupps": [{"id": "t1", "color": None}]})
    assert body.workspace["trupps"][0]["color"] is None


def test_unusable_numeric_drawing_properties_are_dropped():
    body = WorkspacePut(
        base_rev=0,
        workspace={
            "entities": [
                {"id": "e1", "aspect": '0.3" onload="1', "strokeW": float("nan"), "fillOpacity": True},
                {"id": "e2", "aspect": 0.32, "strokeW": 8, "fillOpacity": 0},
            ],
        },
    )
    bad, good = body.workspace["entities"]
    assert "aspect" not in bad and "strokeW" not in bad and "fillOpacity" not in bad
    assert good == {"id": "e2", "aspect": 0.32, "strokeW": 8, "fillOpacity": 0}


def test_a_deeply_nested_blob_does_not_blow_the_stack():
    deep: dict = {"color": HOSTILE}
    for _ in range(3000):
        deep = {"nested": [deep]}
    body = WorkspacePut(base_rev=0, workspace=deep)
    assert isinstance(body.workspace, dict)


# --- …and through the real save path -------------------------------------------------


@pytest.mark.asyncio
async def test_saved_workspace_comes_back_without_the_injected_colour(client, editor):
    await _login(client, editor)
    inc_id = (await client.post("/api/incidents", json={"title": "Test Einsatz"})).json()["id"]
    r = await client.put(
        f"/api/incidents/{inc_id}/workspace",
        json={
            "base_rev": 0,
            "workspace": {"entities": [{"id": "e1", "kind": "shape", "color": HOSTILE, "coord": [7.5, 47.5]}]},
        },
    )
    assert r.status_code == 200, r.text
    assert "color" not in r.json()["workspace"]["entities"][0]
    stored = (await client.get(f"/api/incidents/{inc_id}/workspace")).json()
    assert "color" not in stored["workspace"]["entities"][0]

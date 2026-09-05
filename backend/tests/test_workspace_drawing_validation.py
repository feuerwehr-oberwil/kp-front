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


def test_hostile_symbolsvg_is_neutralised_not_rejected():
    # `Entity.symbolSvg` is a free glyph string the client writes into the DOM; a crafted value was
    # a stored-XSS vector (SEC-01). The server neutralises it (the browser DOMParser sanitiser is
    # the authoritative gate) rather than 422-ing the whole workspace.
    hostile = (
        '<svg xmlns="http://www.w3.org/2000/svg">'
        '<image href="https://evil.example/x" onerror="window.__pwned=1"/>'
        "<script>window.__pwned=1</script>"
        '<a href="javascript:alert(1)"><rect/></a>'
        "</svg>"
    )
    body = WorkspacePut(
        base_rev=0,
        workspace={
            "entities": [{"id": "e1", "kind": "vehicle", "symbolSvg": hostile}],
            "board": {"plan-1": [{"id": "b1", "kind": "symbol", "symbolSvg": hostile}]},
        },
    )
    for cleaned in (body.workspace["entities"][0]["symbolSvg"], body.workspace["board"]["plan-1"][0]["symbolSvg"]):
        assert "onerror" not in cleaned
        assert "<script" not in cleaned
        assert "javascript:" not in cleaned
        assert "evil.example" not in cleaned  # the external href attribute is dropped
        assert "<svg" in cleaned  # …but the glyph itself is kept


def test_legit_symbolsvg_survives_unchanged():
    glyph = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="#00a0ff"/></svg>'
    body = WorkspacePut(base_rev=0, workspace={"entities": [{"id": "e1", "symbolSvg": glyph}]})
    assert body.workspace["entities"][0]["symbolSvg"] == glyph  # idempotent: nothing to scrub


def test_a_colour_with_a_trailing_newline_is_dropped():
    # ⚠️ Python `$` matches before a trailing newline; the regex is anchored with `\Z` so `"#fff\n"`
    # cannot slip the gate and be stored with a stray newline in an SVG attribute value.
    body = WorkspacePut(
        base_rev=0, workspace={"entities": [{"id": "e1", "color": "#fff\n"}, {"id": "e2", "color": "#fff"}]}
    )
    assert "color" not in body.workspace["entities"][0]
    assert body.workspace["entities"][1]["color"] == "#fff"


def test_a_huge_integer_drawing_prop_is_dropped_not_500():
    # ⚠️ math.isfinite(10**400) raises OverflowError — the round-1 validator called it unguarded, so
    # a JSON body carrying such an int turned PUT /workspace into a 500. It must be treated as an
    # unusable value and dropped, exactly like a NaN.
    body = WorkspacePut(
        base_rev=0,
        workspace={"entities": [{"id": "e1", "sizeM": 10**400, "rotation": 42}]},
    )
    entity = body.workspace["entities"][0]
    assert "sizeM" not in entity  # the overflowing value is gone
    assert entity["rotation"] == 42  # the usable neighbour is kept


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

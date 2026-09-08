"""Automatic plan alignment: geometry, compound registration and the proposal contract.

Private-sheet replay and search comparisons live under docs/planning/auto-alignment/.
The synthetic compound regression exercises the neighbouring-row failure without bundling
station geometry. The remaining tests cover parsing, coordinate conversion and API claims.

The module needs the optional `georef` dependency group; without it the whole file skips,
matching the endpoint's own 503 degradation.
"""

import math

import pytest

matcher = pytest.importorskip("app.georef_suggest")
np = pytest.importorskip("numpy")

ANCHOR = (7.5561, 47.5142)  # lng, lat — Oberwil BL


def geom(*lnglat: tuple[float, float]) -> list[dict]:
    return [{"lon": lng, "lat": lat} for lng, lat in lnglat]


def test_rings_from_simple_way() -> None:
    sq = [(7.5560, 47.5141), (7.5562, 47.5141), (7.5562, 47.5143), (7.5560, 47.5143)]
    data = {"elements": [{"type": "way", "geometry": geom(*sq)}]}
    rings = matcher.rings_from_overpass(data, *ANCHOR)
    assert len(rings) == 1
    assert rings[0].shape == (4, 2)
    # the ring sits within ~±20 m of the anchor in the local frame
    assert np.max(np.abs(rings[0])) < 30


def test_rings_stitch_relation_outer_members() -> None:
    # one square outline split into two half-ring ways, second one reversed — the stitcher
    # must join them by endpoint coordinates into a single ≥3-point ring
    a = [(7.5560, 47.5141), (7.5562, 47.5141), (7.5562, 47.5143)]
    b_reversed = [(7.5560, 47.5141), (7.5560, 47.5143), (7.5562, 47.5143)]
    data = {
        "elements": [
            {
                "type": "relation",
                "members": [
                    {"type": "way", "role": "outer", "geometry": geom(*a)},
                    {"type": "way", "role": "outer", "geometry": geom(*b_reversed)},
                    {"type": "way", "role": "inner", "geometry": geom(*a)},  # courtyard hole: ignored
                ],
            }
        ]
    }
    rings = matcher.rings_from_overpass(data, *ANCHOR)
    assert len(rings) == 1
    assert len(rings[0]) >= 4


def test_suggestion_pairs_reproduce_the_transform() -> None:
    # a known similarity: 30° rotation at 0.127 m/px plus a shift — the two returned pairs,
    # pushed through the same transform arithmetic, must land on their own lngLat halves
    th = math.radians(30)
    scale = 0.127
    a = scale * np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
    t = np.array([40.0, -25.0])
    s = matcher.Suggestion(a=a, t=t, score=1.0, coverage=0.5, rotation_deg=30.0)
    w, h = 1755, 1241
    pairs = matcher.suggestion_pairs(s, w, h, *ANCHOR)
    assert len(pairs) == 2
    assert all(p["kind"] == "auto" for p in pairs)
    for p in pairs:
        px = np.array([p["plan"]["x"] * w, -(p["plan"]["y"] * h)])
        mx, my = px @ a.T + t
        lng, lat = matcher.local_to_wgs84(float(mx), float(my), *ANCHOR)
        assert p["lngLat"]["lng"] == pytest.approx(lng)
        assert p["lngLat"]["lat"] == pytest.approx(lat)
    # and the two pairs are two distinct landmarks, well apart on both surfaces
    d_plan = math.hypot(
        pairs[0]["plan"]["x"] - pairs[1]["plan"]["x"],
        pairs[0]["plan"]["y"] - pairs[1]["plan"]["y"],
    )
    assert d_plan > 0.5


def test_local_metres_roundtrip() -> None:
    lng, lat = 7.5591959953, 47.5191726685
    x, y = matcher.local_metres(lng, lat, *ANCHOR)
    back = matcher.local_to_wgs84(x, y, *ANCHOR)
    assert back[0] == pytest.approx(lng, abs=1e-9)
    assert back[1] == pytest.approx(lat, abs=1e-9)


@pytest.mark.parametrize("angle", [0, 57])
def test_compound_alignment_does_not_snap_to_a_neighbouring_row(angle: float) -> None:
    # A red column of four buildings is absent from the grey context. Scoring that whole
    # compound against ONE seed building favours a neighbouring row even with exact data.
    rng = np.random.default_rng(8)
    rings = []
    for row in range(4):
        for col in range(4):
            x, y = col * 35 - 50, row * 25 - 40
            w, h = rng.uniform(8, 18, 2)
            rings.append(np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]))
    compound = {1, 5, 9, 13}
    focus = np.concatenate([matcher._sampled_ring(rings[i], 1) for i in sorted(compound)])
    context = np.concatenate([matcher._sampled_ring(r, 1) for i, r in enumerate(rings) if i not in compound])
    shift = np.array([150, -200])
    scale = 0.15
    theta = math.radians(angle)
    a = scale * np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
    source = (context - shift) @ np.linalg.inv(a).T
    source_focus = (focus - shift) @ np.linalg.inv(a).T
    fit = matcher.context_icp(source_focus, source, rings, scale, compound=True)
    error = np.linalg.norm(source @ fit.a.T + fit.t - context, axis=1)
    assert np.max(error) < 1


async def test_module_one_proposal_remains_uncertain_with_a_low_union_score(client, editor, monkeypatch):
    import json

    import cv2

    from app.api import georef_suggest as api

    async def osm_around(*_args):
        return {"elements": []}

    monkeypatch.setattr(api, "_osm_around", osm_around)
    monkeypatch.setattr(api.overpass_client, "mirrors", lambda: ["https://example.com"])
    monkeypatch.setattr(
        matcher,
        "suggest",
        lambda *_args: matcher.Suggestion(
            a=np.eye(2) * 0.15,
            t=np.zeros(2),
            score=0.6,
            coverage=0.8,
            rotation_deg=0,
        ),
    )
    login = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert login.status_code == 200
    _, encoded = cv2.imencode(".jpg", np.full((100, 100, 3), 255, np.uint8))
    response = await client.post(
        "/api/georef/suggest",
        params={"lng": 7.5, "lat": 47.5, "mPerPx": 0.4, "template": "m1"},
        files={"image": ("plan.jpg", encoded.tobytes(), "image/jpeg")},
    )
    assert response.status_code == 200
    result = json.loads(response.text.splitlines()[-1])["result"]
    assert result["found"] is True
    assert result["confident"] is False
    assert len(result["pairs"]) == 2


async def test_scores_past_the_ceiling_return_no_proposal(client, editor, monkeypatch):
    import json

    import cv2

    from app.api import georef_suggest as api

    async def osm_around(*_args):
        return {"elements": []}

    monkeypatch.setattr(api, "_osm_around", osm_around)
    monkeypatch.setattr(api.overpass_client, "mirrors", lambda: ["https://example.com"])
    monkeypatch.setattr(
        matcher,
        "suggest",
        lambda *_args: matcher.Suggestion(
            a=np.eye(2) * 0.15,
            t=np.zeros(2),
            score=99.0,
            coverage=0.1,
            rotation_deg=0,
        ),
    )
    login = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert login.status_code == 200
    _, encoded = cv2.imencode(".jpg", np.full((100, 100, 3), 255, np.uint8))
    response = await client.post(
        "/api/georef/suggest",
        params={"lng": 7.5, "lat": 47.5, "mPerPx": 0.17, "template": "m2"},
        files={"image": ("plan.jpg", encoded.tobytes(), "image/jpeg")},
    )
    assert response.status_code == 200
    result = json.loads(response.text.splitlines()[-1])["result"]
    assert result["found"] is False
    assert result["pairs"] == []


async def test_oversized_decoded_images_are_refused_in_band(client, editor, monkeypatch):
    """The JPEG cap does not bound the DECODED size — the pixel cap does, and past it the
    stream answers with an in-band error instead of letting the resize allocate gigabytes."""
    import json

    import cv2

    from app.api import georef_suggest as api

    async def osm_around(*_args):
        return {"elements": []}

    monkeypatch.setattr(api, "_osm_around", osm_around)
    monkeypatch.setattr(api.overpass_client, "mirrors", lambda: ["https://example.com"])
    login = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert login.status_code == 200
    _, encoded = cv2.imencode(".jpg", np.full((2200, 3500, 3), 255, np.uint8))  # 7.7 MP
    response = await client.post(
        "/api/georef/suggest",
        params={"lng": 7.5, "lat": 47.5, "mPerPx": 0.17, "template": "m2"},
        files={"image": ("plan.jpg", encoded.tobytes(), "image/jpeg")},
    )
    assert response.status_code == 200
    last = json.loads(response.text.splitlines()[-1])
    assert last == {"error": "Bild zu gross"}

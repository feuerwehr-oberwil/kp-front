"""Automatic plan alignment: geometry, compound registration and the proposal contract.

Private-sheet replay and search comparisons live under docs/planning/auto-alignment/.
The synthetic compound regression exercises the neighbouring-row failure without bundling
station geometry. The remaining tests cover parsing, coordinate conversion and the context floor.

The module needs the optional `georef` dependency group; without it the whole file skips,
matching the worker's own «dependencies missing» capability.
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


def test_a_lone_grey_rectangle_is_not_enough_context():
    """An interior page with one grey block covered 100 % of «nothing» and was offered as a
    confident fit (Schulhaus Wehrlin / BLT Tramdepot Modul 3, 12.09.2026)."""
    img = np.full((1241, 1755, 3), 255, np.uint8)
    img[600:640, 800:855] = 160
    rings = [np.array([[0.0, 0.0], [30.0, 0.0], [30.0, 20.0], [0.0, 20.0]])]
    with pytest.raises(ValueError, match="too little building context"):
        matcher.suggest(img, 0.127, rings)

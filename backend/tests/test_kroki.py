"""Server-side Kroki compositor (app/kroki.py): projection, view fitting, scene extent,
dash walking (regression: exact-boundary phases must still advance) and offline-safe
rendering — tiles pointing at an unroutable host must still yield a complete image with
all overlays, never an exception. Plan-page rendering runs against a tiny generated PDF."""

import io
import math
from pathlib import Path

from PIL import Image
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas

from app import kroki as kk

PACK = kk.SymbolPack(Path(__file__).resolve().parents[2] / "public" / "tactical-symbols.json")
NO_TILES = "http://127.0.0.1:9/{z}/{x}/{y}.png"  # port 9 (discard) — refuses instantly


def test_world_px_projection_roundtrip_and_scale():
    # zoom 0: the whole world is one 256px tile; Null Island sits at its centre
    x, y = kk.world_px(0.0, 0.0, 0)
    assert abs(x - 128) < 1e-6 and abs(y - 128) < 1e-6
    # one zoom level doubles world pixels
    x1, _ = kk.world_px(7.5, 47.5, 15)
    x2, _ = kk.world_px(7.5, 47.5, 16)
    assert abs(x2 / x1 - 2) < 1e-9


def test_fit_view_contains_all_points_with_padding():
    pts = [(7.55, 47.51), (7.56, 47.515), (7.552, 47.518)]
    v = kk.fit_view(pts, 800, 500, pad_frac=0.1)
    for lng, lat in pts:
        x, y = v.project(lng, lat)
        assert -1 <= x <= 801 and -1 <= y <= 501
        assert x >= 800 * 0.1 - 1 and x <= 800 * 0.9 + 1
    # single point falls back to max zoom, centred
    v1 = kk.fit_view([(7.55, 47.51)], 800, 500)
    x, y = v1.project(7.55, 47.51)
    assert abs(x - 400) < 1 and abs(y - 250) < 1


def test_center_view_centers_the_coordinate():
    v = kk.center_view((7.55, 47.51), 16.5, 640, 480)
    x, y = v.project(7.55, 47.51)
    assert abs(x - 320) < 1e-6 and abs(y - 240) < 1e-6
    # MapLibre camera zoom uses a 512 px world; the compositor uses 256 px XYZ tiles.
    # Its projection zoom must be one level higher or the PDF crop is 2x too large.
    assert v.z == 17.5
    assert v.overlay_z == 16.5
    east = kk.world_px(7.551, 47.51, 17.5)[0] - kk.world_px(7.55, 47.51, 17.5)[0]
    assert abs(v.project(7.551, 47.51)[0] - 320 - east) < 1e-6


def test_bounds_view_reproduces_literal_maplibre_viewport():
    explicit = kk.center_view((7.55, 47.51), 18, 1600, 940)
    scale = kk.TILE * (2**explicit.z)

    def unproject(x: float, y: float) -> tuple[float, float]:
        lng = x / scale * 360 - 180
        lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / scale))))
        return lng, lat

    west, north = unproject(*explicit.origin)
    east, south = unproject(explicit.origin[0] + explicit.width, explicit.origin[1] + explicit.height)
    bounded = kk.bounds_view((west, south, east, north), 1600, 940)

    assert abs(bounded.z - explicit.z) < 1e-9
    assert abs(bounded.origin[0] - explicit.origin[0]) < 1e-6
    assert abs(bounded.origin[1] - explicit.origin[1]) < 1e-6
    assert abs(bounded.project(west, north)[0]) < 1e-6
    assert abs(bounded.project(east, south)[0] - 1600) < 1e-6


def test_sym_px_band_clamps():
    assert kk.sym_px("symbol", 47.5, 10) == 28.0  # tiny at low zoom → floor
    assert kk.sym_px("symbol", 47.5, 22) == 48.0  # huge at high zoom → ceiling
    assert kk.sym_px("symbol", 47.5, 16, mul=0.5) == 14.0


def test_kroki_symbol_mul_only_shrinks_close_up_views():
    assert kk.kroki_symbol_mul(16) == 1.0
    assert kk.kroki_symbol_mul(17) == 1.0
    assert kk.kroki_symbol_mul(18) == 0.9
    assert kk.kroki_symbol_mul(19) == 0.8
    assert kk.kroki_symbol_mul(20) == 0.7
    assert kk.kroki_symbol_mul(22) == 0.7


def test_scene_extent_includes_circle_radius():
    scene = kk.KrokiScene(drawings=[{"kind": "circle", "coords": [[7.55, 47.51]], "radiusM": 1000}])
    pts = scene.extent_points()
    lats = [p[1] for p in pts]
    assert max(lats) - min(lats) > 1500 / 110540  # diameter ≈ 2km of latitude spread


def test_dashed_walk_terminates_on_exact_boundaries():
    # segment lengths hitting the dash period exactly used to advance by float epsilon
    img = Image.new("RGBA", (100, 100))
    d = kk.ImageDraw.Draw(img)
    kk._dashed(d, [(0, 0), (24, 0), (48, 0), (96, 0)], "#ff0000", 2, dash=14, gap=10)
    kk._dashed(d, [(0, 0), (14, 0)], "#ff0000", 2, dash=14, gap=10)


def test_render_kroki_offline_still_produces_full_overlay():
    scene = kk.KrokiScene(
        entities=[
            {"coord": [7.556, 47.5139], "symbol": "VKF Feuer", "spread": {"h": "E", "up": True},
             "floor": 2, "caption": "Vollbrand"},
            {"coord": [7.5566, 47.514], "symbolSvg": '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#123456"/></svg>'},
        ],
        drawings=[
            {"kind": "circle", "coords": [[7.556, 47.5139]], "radiusM": 60, "dashed": True, "color": "#d43d3d"},
            {"kind": "line", "coords": [[7.5555, 47.5135], [7.556, 47.5139]], "arrow": True,
             "marker": "R", "showDistance": True, "teilstueck": True, "lineNo": 1, "content": "S", "floorTag": -1},
            {"kind": "area", "coords": [[7.555, 47.513], [7.556, 47.513], [7.556, 47.5136]], "label": "Nord"},
        ],
    )
    img = kk.render_kroki(scene, PACK, NO_TILES, width=640, height=400)
    assert img.size == (640, 400)
    # the overlay must have drawn SOMETHING over the neutral background
    colors = {c for _, c in img.getcolors(maxcolors=1_000_000)}
    assert len(colors) > 10


def test_render_base_uses_configured_source_max_zoom():
    tile = io.BytesIO()
    Image.new("RGB", (256, 256), "#abcdef").save(tile, "PNG")

    class Client:
        urls: list[str] = []

        def get(self, url: str):
            import httpx

            self.urls.append(url)
            return httpx.Response(200, content=tile.getvalue(), request=httpx.Request("GET", url))

    client = Client()
    view = kk.center_view((7.55, 47.51), 19, 320, 188)  # MapLibre z19 -> XYZ z20
    img = kk.render_base(view, "https://tiles/{z}/{x}/{y}.png", client=client, max_tile_z=20)

    assert img.size == (320, 188)
    assert client.urls
    assert all("/20/" in url for url in client.urls)


def test_render_plan_page_with_annotations():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=landscape(A4))
    c.drawString(100, 100, "Grundriss")
    c.save()
    annos = [
        {"kind": "draw", "pts": [[0.1, 0.1], [0.5, 0.5]], "color": "#1f6feb", "width": 4},
        {"kind": "area", "pts": [[0.6, 0.1], [0.9, 0.1], [0.9, 0.4]], "label": "Sektor"},
        {"kind": "symbol", "x": 0.3, "y": 0.7, "symbol": "VKF Feuer"},
        {"kind": "text", "x": 0.7, "y": 0.7, "text": "EL"},
        {"kind": "resource", "x": 0.5, "y": 0.85, "text": "Trupp 1"},
    ]
    img = kk.render_plan_page(buf.getvalue(), annos, PACK, width=800)
    assert img.width == 800
    assert img.height > 400  # landscape A4 aspect preserved (≈ 566)
    assert abs(img.height / img.width - (A4[0] / A4[1])) < 0.05


def test_pack_and_dynamic_svg_raster():
    glyph = PACK.raster("VKF Feuer", 64)
    assert glyph is not None and glyph.size == (64, 64)
    assert PACK.raster("Gibt Es Nicht", 64) is None
    inline = kk.raster_svg('<svg viewBox="0 0 4 4" xmlns="http://www.w3.org/2000/svg"><circle cx="2" cy="2" r="2" fill="#ff0000"/></svg>', 32)
    assert inline.size == (32, 32)


def test_hose_math_matches_client_rules():
    assert kk._fmt_distance(199.6) == "200 m"
    assert kk._fmt_distance(1500) == "1,50 km"
    # 199.6m * 1.1 / 20 = 10.98 → 11 Schläuche (client hoseCount: reserve then ceil)
    assert kk._hose_hint(199.6) == "~11 Schläuche"


def test_marker_points_rhythm():
    pts = kk._marker_points([(0, 0), (200, 0)], spacing=46)
    # first letter half a step in, then every 46px
    assert [round(p[0]) for p in pts] == [23, 69, 115, 161]
    assert all(p[1] == 0 for p in pts)


def test_lookback_point():
    pts = [(0.0, 0.0), (100.0, 0.0)]
    assert kk._lookback(pts, 30) == (70.0, 0.0)
    assert kk._lookback(pts, 500) == (0.0, 0.0)  # falls back to the start


def test_floor_badge_and_sym_color():
    assert kk.floor_badge(2) == "+2" and kk.floor_badge(0) == "0" and kk.floor_badge(-1) == "-1"
    assert kk.sym_color('<svg><circle fill="#ff0000"/></svg>') == "#ff0000"
    assert kk.sym_color('<svg><path fill="#000000" stroke="#000000"/></svg>') == "#1f6feb"


def test_composer_embeds_server_rendered_kroki_and_plan():
    from app.report_pdf import ReportPayload, compose_report_pdf

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.drawString(100, 100, "Plan")
    c.save()
    p = ReportPayload.model_validate({
        "incident": {"title": "T", "id": "i"},
        "generatedAt": "n",
        "kroki": {
            "entities": [{"coord": [7.556, 47.5139], "symbol": "VKF Feuer"}],
            "drawings": [],
            "tiles": NO_TILES,
        },
        "planPages": [{"label": "Modul 1", "url": "/api/reference/plan:x:modul1", "annos": [
            {"kind": "text", "x": 0.5, "y": 0.5, "text": "EL"},
        ]}],
    })
    pdf = compose_report_pdf(p, {}, {"/api/reference/plan:x:modul1": buf.getvalue()})
    assert pdf[:5] == b"%PDF-"
    assert len(pdf) > 8_000  # embedded kroki + plan bitmaps (offline grey base compresses well)

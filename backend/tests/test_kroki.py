"""Server-side Kroki compositor (app/kroki.py): projection, view fitting, scene extent,
dash walking (regression: exact-boundary phases must still advance) and offline-safe
rendering — tiles pointing at an unroutable host must still yield a complete image with
all overlays, never an exception. Plan-page rendering runs against a tiny generated PDF."""

import io
import math
from pathlib import Path

import pytest
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
    """⚠️ The floor is 0.85 since 18.08. — held against the live map the printed symbols came out
    about half the relative size, and the shrink is only meant to stop a close-up crop merging
    four glyphs into one blob. Mirrored by ``krokiSymbolMul`` in src/lib/krokiPayload.ts; if the
    two drift the framing modal stops being WYSIWYG."""
    assert kk.kroki_symbol_mul(16) == 1.0
    assert kk.kroki_symbol_mul(17) == 1.0
    assert kk.kroki_symbol_mul(18) == 0.9
    assert kk.kroki_symbol_mul(19) == pytest.approx(0.85)
    assert kk.kroki_symbol_mul(20) == 0.85
    assert kk.kroki_symbol_mul(22) == 0.85


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
            {
                "coord": [7.556, 47.5139],
                "symbol": "VKF Feuer",
                "spread": {"h": "E", "up": True},
                "floor": 2,
                "caption": "Vollbrand",
            },
            {
                "coord": [7.5566, 47.514],
                "symbolSvg": '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#123456"/></svg>',
            },
        ],
        drawings=[
            {"kind": "circle", "coords": [[7.556, 47.5139]], "radiusM": 60, "dashed": True, "color": "#d43d3d"},
            {
                "kind": "line",
                "coords": [[7.5555, 47.5135], [7.556, 47.5139]],
                "arrow": True,
                "marker": "R",
                "showDistance": True,
                "teilstueck": True,
                "lineNo": 1,
                "content": "S",
                "floorTag": -1,
                "trupp": "Müller H.",
            },
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
        # a stretched generic shape (client planAnnosForPdf: kind 'symbol' + sizeN + aspect)
        {
            "kind": "symbol",
            "x": 0.5,
            "y": 0.3,
            "sizeN": 0.1,
            "aspect": 2.0,
            "rotation": 15,
            "symbolSvg": '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" '
            'preserveAspectRatio="none"><rect width="100" height="100" fill="#e8392b"/></svg>',
        },
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
    inline = kk.raster_svg(
        '<svg viewBox="0 0 4 4" xmlns="http://www.w3.org/2000/svg"><circle cx="2" cy="2" r="2" fill="#ff0000"/></svg>',
        32,
    )
    assert inline.size == (32, 32)


def test_raster_svg_stretches_to_an_explicit_height():
    # generic shapes carry preserveAspectRatio="none" + an aspect (height/width) — the client
    # glyph stretches, so the printed one must too (Rechteck mit freiem Seitenverhältnis)
    svg = (
        '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">'
        '<rect x="0" y="0" width="100" height="100" fill="#ff0000"/></svg>'
    )
    img = kk.raster_svg(svg, 40, 120)
    assert img.size == (40, 120)
    # the artwork fills the stretched box — not a square letterboxed into it
    assert img.getpixel((20, 110))[3] > 0


def test_place_symbol_paints_a_stretched_shape_box():
    svg = (
        '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">'
        '<rect x="0" y="0" width="100" height="100" fill="#ff0000"/></svg>'
    )
    overlay = Image.new("RGBA", (300, 300), (0, 0, 0, 0))
    kk._place_symbol(overlay, kk.ImageDraw.Draw(overlay), svg, (150, 150), 60, None, None, height=180)
    left, top, right, bottom = overlay.getbbox()
    assert (right - left, bottom - top) == (60, 180)


def test_render_kroki_draws_an_aspect_shape_and_the_arrow_stop_bar():
    # the payload the client builds for Item A1/A2: a stretched Rechteck + a Pfeil whose
    # Stopp-Balken is baked into the client-resolved SVG (krokiPayload.shapeSvgString)
    arrow_stop = (
        '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">'
        '<path d="M50 6 L80 50 L60 50 L60 94 L40 94 L40 50 L20 50 Z" fill="#1f6feb" stroke="#fff"'
        ' stroke-width="4" stroke-linejoin="round"/>'
        '<path d="M14 7 L86 7" stroke="#fff" stroke-width="11" stroke-linecap="round"/>'
        '<path d="M14 7 L86 7" stroke="#1f6feb" stroke-width="6" stroke-linecap="round"/></svg>'
    )
    scene = kk.KrokiScene(
        entities=[
            {
                "coord": [7.556, 47.5139],
                "symbolSvg": '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" '
                'preserveAspectRatio="none"><rect width="100" height="100" fill="#e8392b" '
                'fill-opacity="0.18" stroke="#e8392b" stroke-width="5"/></svg>',
                "kind": "shape",
                "sizeM": 40,
                "aspect": 2.5,
                "rotation": 30,
            },
            {"coord": [7.5566, 47.514], "symbolSvg": arrow_stop, "kind": "shape", "sizeM": 45},
        ],
        drawings=[],
    )
    img = kk.render_kroki(scene, PACK, NO_TILES, width=640, height=400)
    assert img.size == (640, 400)
    colors = {c for _, c in img.getcolors(maxcolors=1_000_000)}
    assert len(colors) > 10


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
    p = ReportPayload.model_validate(
        {
            "incident": {"title": "T", "id": "i"},
            "generatedAt": "n",
            "kroki": {
                "entities": [{"coord": [7.556, 47.5139], "symbol": "VKF Feuer"}],
                "drawings": [],
                "tiles": NO_TILES,
            },
            "planPages": [
                {
                    "label": "Modul 1",
                    "url": "/api/reference/plan:x:modul1",
                    "annos": [
                        {"kind": "text", "x": 0.5, "y": 0.5, "text": "EL"},
                    ],
                }
            ],
        }
    )
    pdf = compose_report_pdf(p, {}, {"/api/reference/plan:x:modul1": buf.getvalue()})
    assert pdf[:5] == b"%PDF-"
    assert len(pdf) > 8_000  # embedded kroki + plan bitmaps (offline grey base compresses well)


# --- free-text notes: one-line pill vs. wrapping text box ---------------------------------
# The client decides a note is a BOX purely by whether it carries a width (isNoteBox in
# src/lib/notes.ts). The sheet must agree, or a note reads correctly on screen and wrong on
# paper — which for a rapport is worse than not having the feature.


def _draw():
    return kk.ImageDraw.Draw(Image.new("RGBA", (400, 200)))


def test_note_defaults_match_the_client():
    # mirrors NOTE_WN.def / NOTE_W_PX.def in src/lib/notes.ts — a note stored before notes had
    # a width falls back to these on BOTH sides, so old notes print the box they now show
    assert kk.NOTE_WN_DEFAULT == 0.2
    assert kk.NOTE_W_PX_DEFAULT == 220


def test_note_with_width_wraps_to_that_width():
    d = _draw()
    f = kk._font(12)
    text = "Achtung Gasflaschen im UG - Zugang nur ueber Treppenhaus Ost"
    lines = kk._note_lines(d, text, f, 90)
    assert len(lines) > 1
    # every line fits the box (the greedy wrap never overshoots on multi-word text)
    assert all(d.textlength(line, font=f) <= 90 for line in lines)
    # and nothing was dropped or duplicated on the way
    assert " ".join(lines).split() == text.split()


def test_note_keeps_typed_line_breaks():
    d = _draw()
    f = kk._font(12)
    assert kk._note_lines(d, "Zeile A\nZeile B", f, 400) == ["Zeile A", "Zeile B"]


def test_widthless_caller_flattens_a_typed_break():
    # the only width-less caller left is a team chip, which is one line by nature
    d = _draw()
    f = kk._font(12)
    assert kk._note_lines(d, "Zeile A\nZeile B", f, 0) == ["Zeile A Zeile B"]


def test_overlong_word_overhangs_rather_than_being_split():
    # splitting a chemical name / hydrant code mid-token makes a hard word unreadable; the
    # on-screen box does the same (overflow-wrap only breaks when it must)
    d = _draw()
    f = kk._font(12)
    assert kk._note_lines(d, "Dichlordiphenyltrichlorethan", f, 20) == ["Dichlordiphenyltrichlorethan"]


def test_note_size_steps_match_the_client():
    # mirrors NOTE_SIZE_SCALE in src/lib/notes.ts — drift here means a heading prints as body
    assert kk.NOTE_SIZE_SCALE == {"s": 0.8, "m": 1.0, "l": 1.45}
    assert kk._note_scale(None) == 1.0
    assert kk._note_scale("nonsense") == 1.0


def test_plan_page_renders_a_wrapped_note_box(tmp_path):
    # end-to-end: a boxed note on a plan page must still produce a complete sheet
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=landscape(A4))
    c.drawString(80, 300, "PLAN")
    c.showPage()
    c.save()
    img = kk.render_plan_page(
        buf.getvalue(),
        [
            {
                "kind": "text",
                "x": 0.4,
                "y": 0.4,
                "text": "Achtung Gasflaschen im UG - Zugang nur ueber Treppenhaus Ost",
                "wN": 0.2,
                "noteSize": "l",
                "notePlain": True,
            }
        ],
        PACK,
        width=800,
    )
    assert img.width > 0 and img.height > 0


# --- plan-page symbol decor: the badges the board draws must survive onto paper ------------
# Until 26.08. a symbol on a PLAN page printed bare — the Kroki grew storey/count badges and
# Entwicklung arrows, the plan pages never did. So «3 Brände im 2. OG» came off the printer as
# one nameless flame, on the sheet that is supposed to BE the record.


def _plan_ink(img: Image.Image, box: tuple[int, int, int, int]) -> int:
    """Non-white pixels in a box of a rendered plan page (the base is white)."""
    return sum(n for n, px in img.crop(box).getcolors(maxcolors=1_000_000) if min(px[:3]) < 235)


def _blank_plan(anno: dict, width: int = 400) -> Image.Image:
    """One anno on a blank square page; the glyph lands dead centre at 21px (42 · u · ss / ss)."""
    return kk.render_blank_page(1.0, [anno], PACK, width=width)


#: the rendered glyph's half-size on a 400px `_blank_plan` page — 42px at ref_width 800
_HALF = 42 * (400 / 800) / 2


def test_a_plan_symbol_prints_its_storey_and_count_badges():
    base = {"kind": "symbol", "x": 0.5, "y": 0.5, "symbol": "VKF Feuer"}
    cx = cy = 200
    top_right = (int(cx + _HALF - 4), int(cy - _HALF - 8), int(cx + _HALF + 14), int(cy - _HALF + 4))
    bottom_right = (int(cx + _HALF - 4), int(cy + _HALF - 4), int(cx + _HALF + 14), int(cy + _HALF + 8))

    bare = _blank_plan(base)
    assert _plan_ink(bare, top_right) == 0 and _plan_ink(bare, bottom_right) == 0

    badged = _blank_plan({**base, "storey": 2, "count": 3})
    assert _plan_ink(badged, top_right) > 0  # «+2» chip
    assert _plan_ink(badged, bottom_right) > 0  # «3» chip

    # a von/bis span (stairs, lift) uses the storey's slot — and it is a property of the OBJECT,
    # so it prints on the Gebäude floor-stack pages too
    ranged = _blank_plan({**base, "floorFrom": -1, "floorTo": 3})
    assert _plan_ink(ranged, top_right) > 0


def test_a_plan_symbols_floor_is_the_tile_index_and_never_a_badge():
    """⚠️ `floor` on a BoardAnno is the floor-stack's TILE INDEX, `storey` is the signed badge
    (types.ts · BoardAnno). Reading the wrong one here would stamp «+3» on every symbol that
    happens to sit on the fourth sheet."""
    base = {"kind": "symbol", "x": 0.5, "y": 0.5, "symbol": "VKF Feuer"}
    assert _blank_plan({**base, "floor": 3}).tobytes() == _blank_plan(base).tobytes()


def test_a_plan_symbol_prints_its_entwicklung_arrows():
    base = {"kind": "symbol", "x": 0.5, "y": 0.5, "symbol": "VKF Feuer"}
    # the arrows sit OUTSIDE the glyph in a 250% box, so they ink a band the bare glyph cannot
    outside = (200 - 8, int(200 - _HALF * 2.2), 200 + 8, int(200 - _HALF * 1.2))
    assert _plan_ink(_blank_plan(base), outside) == 0
    assert _plan_ink(_blank_plan({**base, "spread": {"up": True, "left": True}}), outside) > 0


def test_a_plan_trupp_chip_prints_its_truppfarbe():
    """The colour IS the team's identity on both surfaces; the printed chip was the one place
    it got lost (the dark pill knew nothing but the name)."""
    chip = {"kind": "resource", "x": 0.5, "y": 0.5, "text": "Trupp 1", "color": "#e8590c"}
    img = _blank_plan(chip)
    warm = img.crop((150, 185, 250, 215)).getcolors(maxcolors=1_000_000)
    assert any(px[0] > 180 and px[1] < 160 and px[2] < 90 for _n, px in warm)


def test_plan_anno_schema_lets_the_badge_fields_through():
    """The badges only reach the renderer if the SCHEMA knows them: pydantic drops an unknown
    field without a word, and the sheet then simply has no badge and no error either."""
    from app.report_pdf import PlanAnnoIn

    a = PlanAnnoIn.model_validate(
        {
            "kind": "symbol",
            "x": 0.5,
            "y": 0.5,
            "symbol": "VKF Feuer",
            "storey": -1,
            "floorFrom": 0,
            "floorTo": 3,
            "count": 4,
            "spread": {"up": True, "upBounded": True},
        }
    )
    d = a.model_dump()
    assert (d["storey"], d["floorFrom"], d["floorTo"], d["count"]) == (-1, 0, 3, 4)
    assert d["spread"] == {"up": True, "upBounded": True}


# --- plan-page captions: the words the board shows under a glyph -------------------------
# Until 26.08. a plan symbol printed its badges but never its CAPTION — «Melder 3. OG» was on
# the board and missing from the sheet stapled next to the Kroki, which prints exactly that.


def _blank_plan_legend(annos: list[dict], width: int = 400) -> tuple[Image.Image, list[str]]:
    """A blank plan page plus the legend it produced — the plan twin of `render_kroki`'s."""
    legend: list[str] = []
    return kk.render_blank_page(1.0, annos, PACK, width=width, legend_out=legend), legend


#: where the disc for a centred glyph lands on a 400px `_blank_plan` page: it hangs under the
#: caption's anchor (glyph bottom + 3u), nudged down by its own radius
_DISC_BOX = (192, 210, 208, 224)


def test_a_plan_symbol_prints_a_disc_only_when_it_has_a_caption():
    base = {"kind": "symbol", "x": 0.5, "y": 0.5, "symbol": "VKF Feuer"}

    bare, no_legend = _blank_plan_legend([base])
    assert _plan_ink(bare, _DISC_BOX) == 0
    assert no_legend == []

    captioned, legend = _blank_plan_legend([{**base, "caption": "Brandherd"}])
    assert _plan_ink(captioned, _DISC_BOX) > 0
    assert legend == ["Brandherd"]


def test_a_plan_caption_never_prints_as_a_chip_on_the_plan():
    """The words go in the LEGEND, not next to the glyph — the 08.08. lesson, applied to the
    sheet that has even less room than the Kroki. A caption chip would ink a band far wider
    than the disc; the disc is all that may appear."""
    img, _ = _blank_plan_legend(
        [{"kind": "symbol", "x": 0.5, "y": 0.5, "symbol": "VKF Feuer", "caption": "Zugang nur über Treppenhaus Ost"}]
    )
    assert _plan_ink(img, _DISC_BOX) > 0
    # the bands a chip that long would have to reach into — clear of both glyph and disc
    for band in ((120, 208, 185, 232), (215, 208, 280, 232)):
        assert _plan_ink(img, band) == 0, band


def test_plan_numbering_follows_placement_order_and_skips_the_uncaptioned():
    """Numbers are per page, 1..n, in the order the annos were placed — and a symbol without a
    caption is not a hole in the sequence, it simply never enters it."""
    a = {"kind": "symbol", "x": 0.25, "y": 0.5, "symbol": "VKF Feuer", "caption": "erstes"}
    silent = {"kind": "symbol", "x": 0.5, "y": 0.25, "symbol": "VKF Luefter mobil"}
    b = {"kind": "symbol", "x": 0.75, "y": 0.5, "symbol": "VKF Einsatzleiter", "caption": "zweites"}

    _, legend = _blank_plan_legend([a, silent, b])
    assert legend == ["erstes", "zweites"]
    # …and dropping the uncaptioned symbol changes nothing about the numbers
    _, without = _blank_plan_legend([a, b])
    assert without == legend


def test_a_plan_caption_at_the_edge_is_left_out_rather_than_clipped():
    """⚠️ Same rule as the Kroki's crop (11.08.): a disc that cannot sit WHOLLY on the page is
    drawn half off it, and a legend line for it sends the reader hunting for a number that is
    not there. It is skipped, and the numbering closes up behind it."""
    inside = {"kind": "symbol", "x": 0.5, "y": 0.5, "symbol": "VKF Feuer", "caption": "im Bild"}
    at_edge = {"kind": "symbol", "x": 0.5, "y": 0.999, "symbol": "VKF Feuer", "caption": "über den Rand"}
    _, legend = _blank_plan_legend([inside, at_edge])
    assert legend == ["im Bild"]


def test_a_plan_page_and_the_kroki_word_the_same_caption_identically():
    """One rapport, two kinds of sheet: the reader must not meet «Meier A. · TLF» on one and
    «Meier A. / TLF» on the other. Both go through kroki · _number_words."""
    caption = "Lüfter Akku 3. OG\nMeier Anna"
    _, plan_legend = _blank_plan_legend(
        [{"kind": "symbol", "x": 0.5, "y": 0.5, "symbol": "VKF Feuer", "caption": caption}]
    )

    kroki_legend: list[str] = []
    kk.render_kroki(
        kk.KrokiScene(entities=[{"kind": "symbol", "symbol": "VKF Feuer", "coord": [7.53, 47.41], "caption": caption}]),
        PACK,
        "",
        width=900,
        height=700,
        legend_out=kroki_legend,
    )
    assert plan_legend == kroki_legend == ["Lüfter Akku 3. OG · Meier Anna"]


def test_plan_anno_schema_lets_the_caption_through():
    """pydantic drops an unknown field without a word — the sheet would then simply have no
    legend and no error either (the badge fields' own lesson, one field later)."""
    from app.report_pdf import PlanAnnoIn

    a = PlanAnnoIn.model_validate(
        {"kind": "symbol", "x": 0.5, "y": 0.5, "symbol": "VKF Feuer", "caption": "Melder 3. OG"}
    )
    assert a.model_dump()["caption"] == "Melder 3. OG"


def test_every_label_becomes_a_number_and_a_legend_line():
    """⚠️ Chips used to be drawn where their own anchor was, with no idea what was already
    there — so three symbols within a few metres printed three chips on top of one another and
    the middle one was unreadable, on PAPER, where nothing can be dragged aside (08.08.).

    Numbering only ON COLLISION was tried and dropped (09.08.): it made the same Einsatz print
    differently before and after one more symbol. Every labelled thing is numbered, always."""
    from app import kroki as kk

    def scene(spread: float) -> "kk.KrokiScene":
        return kk.KrokiScene(
            entities=[
                {
                    "id": "a",
                    "kind": "symbol",
                    "symbol": "VKF Einsatzleiter",
                    "coord": [7.5300, 47.4100],
                    "caption": "Kurmann Thomas",
                },
                {
                    "id": "b",
                    "kind": "symbol",
                    "symbol": "VKF Luefter mobil",
                    "coord": [7.5300 + spread, 47.4100 + spread],
                    "caption": "Lüfter Akku 3. OG",
                },
                {
                    "id": "c",
                    "kind": "symbol",
                    "symbol": "VKF Fahrzeug",
                    "coord": [7.5340, 47.4128],
                    "caption": "TLF · Meier Anna",
                },
            ]
        )

    # crammed together and comfortably apart produce the SAME sheet — that is the whole point
    for spread in (0.00004, 0.0016):
        legend: list[str] = []
        kk.render_kroki(scene(spread), kk.get_pack(), "", width=900, height=700, legend_out=legend)
        # in picture order, and carrying the FULL text a chip would have had to cut
        assert legend == ["Kurmann Thomas", "Lüfter Akku 3. OG", "TLF · Meier Anna"], spread


def test_a_kroki_without_labels_has_no_legend():
    """An empty legend is what tells report_pdf not to put a numbered list under a picture that
    carries no numbers — symbols without a caption are still just symbols."""
    from app import kroki as kk

    scene = kk.KrokiScene(
        entities=[
            {"id": "a", "kind": "symbol", "symbol": "VKF Einsatzleiter", "coord": [7.5300, 47.4100]},
            {"id": "b", "kind": "symbol", "symbol": "VKF Fahrzeug", "coord": [7.5310, 47.4108]},
        ]
    )
    legend: list[str] = []
    kk.render_kroki(scene, kk.get_pack(), "", width=900, height=700, legend_out=legend)
    assert legend == []


def test_the_legend_lists_only_what_the_crop_actually_shows():
    """⚠️ A legend number the reader cannot find on the map is worse than no entry at all.

    The Kroki crop follows the Lage (the operator frames the picture), so the scene routinely
    carries labelled symbols outside the frame. Their numbered disc was drawn off the canvas and
    silently clipped away while the legend went on listing them — a sheet ending in a «7» with
    no 7 anywhere on the picture, which sends the reader looking for something that is not there
    (reported 11.08. off a demo Kroki).
    """
    from app import kroki as kk

    scene = kk.KrokiScene(
        entities=[
            {
                "id": "a",
                "kind": "symbol",
                "symbol": "VKF Einsatzleiter",
                "coord": [7.5300, 47.4100],
                "caption": "im Bild",
            },
            # far outside any view fitted to the entity above
            {
                "id": "b",
                "kind": "symbol",
                "symbol": "VKF Fahrzeug",
                "coord": [7.5300, 47.4100],
                "caption": "weit weg",
            },
        ]
    )
    # a view centred tightly on the first symbol; the second is moved out of it
    scene.entities[1]["coord"] = [7.6000, 47.4600]
    view = kk.fit_view([(7.5300, 47.4100)], 900, 700)
    legend: list[str] = []
    kk.render_kroki(scene, kk.get_pack(), "", width=900, height=700, view=view, legend_out=legend)
    assert legend == ["im Bild"], legend


def test_spread_dirs_reads_both_stored_shapes() -> None:
    """⚠️ Mirrors src/lib/spread.test.ts. The printed Kroki renders from the same workspace blob
    as the screen, and incidents written before 2026-08 still carry the exclusive
    `h`/`hBounded` + shared `vBounded` shape — an archived Rapport reprints from it years later.
    If this drifts from the client, paper stops matching the screen."""
    d = kk._spread_dirs

    # legacy: one exclusive horizontal direction, its bar landing on that arrow only
    assert d({"h": "W"}) == {"left": False}
    assert d({"h": "E", "hBounded": True}) == {"right": True}
    # legacy: one shared vertical bar reaching every vertical arrow that was set
    assert d({"up": True, "down": True, "vBounded": True}) == {"up": True, "down": True}
    assert d({"up": True, "vBounded": True}) == {"up": True}

    # current: four independent arrows, each with its own bar
    assert d({"left": True, "right": True, "leftBounded": True}) == {"left": True, "right": False}
    assert d({"up": True, "down": True, "upBounded": True}) == {"up": True, "down": False}

    # a bar without its arrow never draws one
    assert d({"leftBounded": True}) == {}
    assert d({}) == {}


def test_spread_overlay_draws_one_arrow_per_direction() -> None:
    """All four at once is a real Lage: a fire running both ways along a Fassade and into the
    storeys above and below."""
    svg = kk.spread_overlay_svg({"left": True, "right": True, "up": True, "down": True}, "#f00")
    assert svg.count("<path") == 4
    # only the bounded one grows a bar
    svg2 = kk.spread_overlay_svg({"left": True, "right": True, "rightBounded": True}, "#f00")
    assert svg2.count("<rect") == 1

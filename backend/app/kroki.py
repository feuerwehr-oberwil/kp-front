"""Server-side Kroki compositor — renders the Lage map to a bitmap without a browser.

Every kp-front basemap is raster XYZ tiles (CARTO PNG / swisstopo WMTS JPEG), so the Kroki
needs no WebGL: stitch tiles for the fitted view, then draw the workspace's drawings and
tactical symbols on top with Pillow. The symbol artwork is the SAME pack the client uses
(public/tactical-symbols.json), rasterised with resvg — identical glyphs, no porting drift.

This replaces the browser capture path (html2canvas + preserveDrawingBuffer) so the whole
rapport can be composed server-side — the prerequisite for the print relay's «Einsatzrapport
drucken» button working without a tablet in the loop.

Deliberately mirrors the client's sizing rules (src/lib/mapView.ts): symbols live in a
28..48 px band derived from real-world metres × zoom, scaled by the Kroki multiplier 0.7
(ReportPrintView symMul). Rendering is supersampled 2× and downscaled for clean edges.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont

TILE = 256
_UA = {"User-Agent": "kp-front-kroki/1.0 (+https://github.com/feuerwehr-oberwil/kp-front)"}

# ----------------------------------------------------------------------------- projection


def world_px(lng: float, lat: float, z: float) -> tuple[float, float]:
    """WebMercator world pixel of a WGS84 coordinate at zoom z (256px tiles)."""
    scale = TILE * (2**z)
    x = (lng + 180.0) / 360.0 * scale
    siny = min(max(math.sin(math.radians(lat)), -0.9999), 0.9999)
    y = (0.5 - math.log((1 + siny) / (1 - siny)) / (4 * math.pi)) * scale
    return x, y


def px_per_m(lat: float, z: float) -> float:
    """Pixels per ground metre (client lib/mapView.ts pxPerM)."""
    return (2**z) / (156543.03392 * math.cos(math.radians(lat)))


def sym_px(kind: str, lat: float, z: float, mul: float = 1.0) -> float:
    """Symbol size band (client lib/mapView.ts symPx): metres × zoom clamped to 28..48."""
    size_m = {"vehicle": 11, "command": 10, "hydrant": 6, "symbol": 8, "area": 8}.get(kind, 8)
    return max(28.0, min(48.0, size_m * px_per_m(lat, z))) * mul


def kroki_symbol_mul(z: float) -> float:
    """Print-specific scale: close-up crops need less marker growth than the live map.

    Keep overview maps unchanged through z17, then ease down by 10% per zoom level and
    stop at 70%. Mirrored by ``krokiSymbolMul`` in ``src/lib/krokiPayload.ts`` so the
    framing modal remains WYSIWYG.
    """
    return max(0.7, 1.0 - max(0.0, z - 17.0) * 0.1)


@dataclass
class View:
    z: float  # fractional, like MapLibre — tiles are fetched at ceil(z) and downscaled
    origin: tuple[float, float]  # world px (at zoom z) of the image's top-left
    width: int
    height: int
    # MapLibre defines camera zoom against a 512 px world, while traditional XYZ raster
    # tiles (and this compositor's projection) use 256 px. Explicit views therefore need
    # z+1 for projection/tile selection, but overlay sizing must keep using the camera zoom.
    overlay_z: float | None = None

    def project(self, lng: float, lat: float) -> tuple[float, float]:
        wx, wy = world_px(lng, lat, self.z)
        return wx - self.origin[0], wy - self.origin[1]


def fit_view(points: list[tuple[float, float]], width: int, height: int,
             pad_frac: float = 0.08, min_z: float = 10.0, max_z: float = 20.0) -> View:
    """Fractional zoom at which all points fill the frame (with padding), centered —
    the same framing feel as MapLibre's fitBounds.

    max_z 20 > the z19 tile ceiling on purpose: a single-building incident has its whole
    extent within a few metres, and at z19 the 48px-capped glyphs pile up into one clump
    on a ~320m frame. z20 halves the frame (~160m) so they separate; render_base upscales
    the z19 tiles 2× (slightly soft basemap — the readable symbols matter more)."""
    pts = points or [(8.2275, 46.8182)]
    p0 = [world_px(lng, lat, 0) for lng, lat in pts]
    ext_x = max(p[0] for p in p0) - min(p[0] for p in p0)
    ext_y = max(p[1] for p in p0) - min(p[1] for p in p0)
    z = min(
        math.log2(width * (1 - 2 * pad_frac) / ext_x) if ext_x > 0 else max_z,
        math.log2(height * (1 - 2 * pad_frac) / ext_y) if ext_y > 0 else max_z,
    )
    z = max(min_z, min(max_z, z))
    proj = [world_px(lng, lat, z) for lng, lat in pts]
    cx = (max(p[0] for p in proj) + min(p[0] for p in proj)) / 2
    cy = (max(p[1] for p in proj) + min(p[1] for p in proj)) / 2
    return View(z=z, origin=(cx - width / 2, cy - height / 2), width=width, height=height)


def center_view(center: tuple[float, float], z: float, width: int, height: int) -> View:
    """View for an explicit MapLibre center+zoom from the framing modal.

    MapLibre's camera has a constant 512 px tile size; its zoom 16 therefore covers the
    same geographic extent as a 256 px XYZ projection at zoom 17. Keeping the raw camera
    zoom here made the PDF twice as wide/high as the crop the operator had selected.
    """
    projection_z = z + math.log2(512 / TILE)
    cx, cy = world_px(center[0], center[1], projection_z)
    return View(
        z=projection_z,
        origin=(cx - width / 2, cy - height / 2),
        width=width,
        height=height,
        overlay_z=z,
    )


def bounds_view(bounds: tuple[float, float, float, float], width: int, height: int) -> View:
    """Render the literal north-up viewport bounds selected in MapLibre.

    Bounds avoid any dependency on the client's camera/tile zoom convention. With the
    selector and output sharing an aspect ratio, the two corners land on the image edges.
    """
    west, south, east, north = bounds
    return fit_view([(west, south), (east, north)], width, height,
                    pad_frac=0.0, min_z=0.0, max_z=24.0)


# ----------------------------------------------------------------------------- tiles


class TileCache:
    """Tiny on-disk tile cache — polite to the tile CDNs and fast for repeated renders."""

    def __init__(self, cache_dir: Path):
        self.dir = cache_dir
        self.dir.mkdir(parents=True, exist_ok=True)

    def get(self, url: str) -> bytes | None:
        p = self.dir / hashlib.sha256(url.encode()).hexdigest()
        return p.read_bytes() if p.exists() else None

    def put(self, url: str, data: bytes) -> None:
        (self.dir / hashlib.sha256(url.encode()).hexdigest()).write_bytes(data)


def render_base(view: View, tile_url: str, cache: TileCache | None = None,
                client: httpx.Client | None = None, max_tile_z: int = 19) -> Image.Image:
    """Stitch the XYZ raster tiles covering the view. `tile_url` has {z}/{x}/{y} slots.
    Fractional view zoom: tiles come from ceil(z) (crisper than upscaling from floor)
    and the stitched canvas is resized down to the view's pixel size."""
    tz = min(max_tile_z, math.ceil(view.z))
    f = 2.0 ** (tz - view.z)  # tile-zoom px per view px (≥ 1)
    tw, th = math.ceil(view.width * f), math.ceil(view.height * f)
    x0, y0 = view.origin[0] * f, view.origin[1] * f
    img = Image.new("RGB", (tw, th), "#e8ecef")
    own = client is None
    client = client or httpx.Client(timeout=10, headers=_UA)
    try:
        n = 2**tz
        tx0, ty0 = int(x0 // TILE), int(y0 // TILE)
        tx1, ty1 = int((x0 + tw) // TILE), int((y0 + th) // TILE)
        coords = [(tx, ty) for tx in range(tx0, tx1 + 1) for ty in range(ty0, ty1 + 1) if 0 <= ty < n]

        def fetch(txy: tuple[int, int]) -> tuple[int, int, bytes | None]:
            tx, ty = txy
            url = tile_url.format(z=tz, x=tx % n, y=ty)
            data = cache.get(url) if cache else None
            if data is None:
                try:
                    r = client.get(url)
                    r.raise_for_status()
                    data = r.content
                    if cache:
                        cache.put(url, data)
                except httpx.HTTPError:
                    return tx, ty, None  # missing tile → keep the neutral background
            return tx, ty, data

        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=8) as ex:
            for tx, ty, data in ex.map(fetch, coords):
                if data is None:
                    continue
                try:
                    tile = Image.open(io.BytesIO(data)).convert("RGB")
                except Exception:
                    continue
                img.paste(tile, (int(tx * TILE - x0), int(ty * TILE - y0)))
    finally:
        if own:
            client.close()
    return img.resize((view.width, view.height), Image.LANCZOS) if (tw, th) != (view.width, view.height) else img


# ----------------------------------------------------------------------------- symbols


def raster_svg(svg: str, size_px: int) -> Image.Image:
    """Rasterise an SVG string to a square RGBA image (resvg — same renderer for pack
    symbols and the client-resolved dynamic glyphs like vehicles/placards).

    The pack's letters use `font-family="Arial,sans-serif"`. The Linux container has no
    Arial, and resvg's built-in generic-family defaults don't exist there either — the
    letters silently VANISH (empty blue boxes on the prod Kroki). Pin every generic
    family to DejaVu Sans (fonts-dejavu-core, see Dockerfile); on macOS dev Arial matches
    first, so the pin is inert there."""
    import resvg_py

    png = bytes(resvg_py.svg_to_bytes(
        svg_string=svg, width=size_px, height=size_px,
        font_family="DejaVu Sans", sans_serif_family="DejaVu Sans",
        serif_family="DejaVu Serif", monospace_family="DejaVu Sans Mono",
    ))
    return Image.open(io.BytesIO(png)).convert("RGBA")


class SymbolPack:
    """The client's own tactical-symbol pack (name → SVG), rasterised on demand."""

    def __init__(self, pack_path: Path):
        data = json.loads(pack_path.read_text())
        self.by_name: dict[str, str] = {s["name"]: s["svg"] for s in data["symbols"]}
        self._raster: dict[tuple[str, int], Image.Image | None] = {}

    def raster(self, name: str, size_px: int) -> Image.Image | None:
        key = (name, size_px)
        if key not in self._raster:
            svg = self.by_name.get(name)
            self._raster[key] = raster_svg(svg, size_px) if svg else None
        return self._raster[key]


def default_pack_path() -> Path | None:
    """The tactical-symbol pack as deployed: the built SPA copy (dist) in production,
    the repo's public/ next to the backend in dev. Env override for exotic setups."""
    import os

    here = Path(__file__).resolve().parent  # backend/app
    candidates = [
        Path(p) if (p := os.environ.get("KP_SYMBOLS_PACK")) else None,
        here.parent / "dist" / "tactical-symbols.json",  # container: dist copied next to app
        here.parent.parent / "dist" / "tactical-symbols.json",  # repo build
        here.parent.parent / "public" / "tactical-symbols.json",  # repo dev
    ]
    for c in candidates:
        if c and c.exists():
            return c
    return None


_PACK: SymbolPack | None = None
_TILE_CACHE: TileCache | None = None


def get_pack() -> SymbolPack | None:
    global _PACK
    if _PACK is None:
        p = default_pack_path()
        _PACK = SymbolPack(p) if p else None
    return _PACK


def get_tile_cache() -> TileCache:
    """Process-wide tile cache next to the media storage (persists across renders)."""
    global _TILE_CACHE
    if _TILE_CACHE is None:
        from .config import settings

        _TILE_CACHE = TileCache(Path(settings.media_storage_dir) / "tilecache")
    return _TILE_CACHE


# ----------------------------------------------------------------------------- symbol decor

# the client's own accent-colour pick (symbolRender.tsx symColor): first non-black
# fill/stroke, else the app blue; black is the glyph outline
_COLOR_RE = __import__("re").compile(r'(?:fill|stroke)="(#[0-9a-fA-F]{6})"')


def sym_color(svg: str) -> str:
    for c in _COLOR_RE.findall(svg):
        if c.lower() != "#000000":
            return c
    return "#1f6feb"


def needs_white(svg: str) -> bool:
    """Outline symbols (KP Front, hydrants, …) get a white legibility chip behind them."""
    return 'fill="none"' in svg


def floor_badge(f: int) -> str:
    return f"+{f}" if f > 0 else str(f)


# FKS Entwicklung block arrow (symbolRender.tsx BLOCK_ARROW), hollow, in the symbol colour
_BLOCK_ARROW = "M42 30 L42 20 L34 20 L50 8 L66 20 L58 20 L58 30 Z"


def spread_overlay_svg(spread: dict, color: str) -> str:
    """The SpreadArrows overlay as one SVG (same paths/rotations as the client)."""
    parts: list[str] = []

    def arrow(deg: int, bounded: bool) -> str:
        bar = '<rect x="33" y="1" width="34" height="6" rx="1.5" stroke-width="3"/>' if bounded else ""
        return (f'<g transform="rotate({deg} 50 50)" fill="#fff" stroke="{color}" '
                f'stroke-width="3.5" stroke-linejoin="round"><path d="{_BLOCK_ARROW}"/>{bar}</g>')

    if spread.get("up"):
        parts.append(arrow(0, bool(spread.get("vBounded"))))
    if spread.get("down"):
        parts.append(arrow(180, bool(spread.get("vBounded"))))
    if spread.get("h") == "E":
        parts.append(arrow(90, bool(spread.get("hBounded"))))
    if spread.get("h") == "W":
        parts.append(arrow(270, bool(spread.get("hBounded"))))
    return f'<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg>'


def _badge(draw: ImageDraw.ImageDraw, xy: tuple[float, float], text: str, h: float,
           bg: str, fg: str) -> None:
    """A small rounded chip (floor / count badge), centred on xy."""
    f = _font(int(h * 0.72))
    w = max(h, draw.textlength(text, font=f) + h * 0.5)
    x, y = xy
    draw.rounded_rectangle([x - w / 2, y - h / 2, x + w / 2, y + h / 2], radius=h * 0.3,
                           fill=bg, outline="#d4dae3" if bg == "white" else None, width=1)
    draw.text((x, y - h * 0.04), text, font=f, fill=fg, anchor="mm")


def _caption(draw: ImageDraw.ImageDraw, xy: tuple[float, float], lines: list[str], fs: int) -> None:
    """White caption chip under a glyph — the map's .sym-caption (bold, stacked lines)."""
    f = _font(fs)
    lh = fs * 1.25
    bw = max(draw.textlength(t, font=f) for t in lines)
    bh = lh * len(lines)
    pad = fs * 0.4
    x, y = xy  # top-centre of the chip
    draw.rounded_rectangle([x - bw / 2 - pad, y, x + bw / 2 + pad, y + bh + pad],
                           radius=max(2, fs // 4), fill=(255, 255, 255, 240), outline="#d4dae3", width=1)
    for i, t in enumerate(lines):
        draw.text((x, y + pad / 2 + lh * (i + 0.5)), t, font=f, fill="#1b2330", anchor="mm")


# ----------------------------------------------------------------------------- line decor


def _teilstueck_fork(overlay: Image.Image, pts: list[tuple[float, float]],
                     color: str, width: int) -> None:
    """The forward «E»-fork Teilstück coupling at the line tip — the client's
    TeilstueckFork SVG (round caps, clean joins) rasterised via resvg and composited
    at the tip; PIL's fat butt-capped strokes turned into blobs."""
    tip = pts[-1]
    back = _lookback(pts, max(10.0, width * 2.5))
    ang = math.degrees(math.atan2(tip[1] - back[1], tip[0] - back[0]))
    # slightly longer + thinner than the on-screen fork so the E reads crisply on paper
    half = max(10.0, width * 2.1)
    prong = half * 1.25
    sw = max(2.0, width * 0.55)
    box = (half + prong) * 2 + 8
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-box / 2} {-box / 2} {box} {box}">'
        f'<g transform="rotate({ang})" stroke="{color}" stroke-width="{sw}" '
        f'stroke-linecap="round" fill="none">'
        f'<path d="M0,{-half} L0,{half}"/>'
        f'<path d="M0,{-half} L{prong},{-half}"/>'
        f'<path d="M0,0 L{prong},0"/>'
        f'<path d="M0,{half} L{prong},{half}"/>'
        f"</g></svg>"
    )
    size = int(round(box))
    fork = raster_svg(svg, size)
    overlay.alpha_composite(fork, (int(tip[0] - size / 2), int(tip[1] - size / 2)))


def _end_tag(draw: ImageDraw.ImageDraw, pts: list[tuple[float, float]], parts: list[str],
             color: str, fs: int) -> None:
    """Boxed tag just before the tip (72 % along the last segment): «1 · S · +2»."""
    a, b = pts[-2], pts[-1]
    x, y = a[0] + (b[0] - a[0]) * 0.72, a[1] + (b[1] - a[1]) * 0.72
    text = " · ".join(parts)
    f = _font(fs)
    tw = draw.textlength(text, font=f)
    pad = fs * 0.4
    draw.rounded_rectangle([x - tw / 2 - pad, y - fs * 0.8 - pad / 2, x + tw / 2 + pad, y + fs * 0.8 + pad / 2],
                           radius=max(2, fs // 4), fill=(255, 255, 255, 240), outline=color, width=max(1, fs // 7))
    draw.text((x, y), text, font=f, fill=color, anchor="mm")


# ----------------------------------------------------------------------------- drawing


def _font(size: int) -> ImageFont.FreeTypeFont:
    # macOS' Helvetica.ttc throws division-by-zero below 8pt (bitmap-strike quirk); a
    # sub-8px label is unreadable on paper anyway, so floor instead of special-casing
    size = max(8, int(size))
    for cand in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",  # container
        "/System/Library/Fonts/Helvetica.ttc",  # macOS dev
        "/Library/Fonts/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(cand, size)
        except OSError:
            continue
    return ImageFont.load_default()  # type: ignore[return-value]


def _dashed(draw: ImageDraw.ImageDraw, pts: list[tuple[float, float]], color: str, width: int,
            dash: float = 14, gap: float = 10) -> None:
    """PIL has no dash pattern — walk the polyline and emit dash segments, keeping the
    dash phase continuous across vertices."""
    period = dash + gap
    dist = 0.0  # cumulative length along the polyline
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        seg = math.hypot(x2 - x1, y2 - y1)
        if seg == 0:
            continue
        ux, uy = (x2 - x1) / seg, (y2 - y1) / seg
        t = 0.0
        while t < seg:
            phase = (dist + t) % period
            if phase < dash:
                step = min(dash - phase, seg - t)
                draw.line([(x1 + ux * t, y1 + uy * t), (x1 + ux * (t + step), y1 + uy * (t + step))],
                          fill=color, width=width)
            else:
                step = min(period - phase, seg - t)
            t += max(step, 0.05)  # epsilon floor — a phase landing exactly on a boundary must still advance
        dist += seg


def _lookback(pts: list[tuple[float, float]], dist: float) -> tuple[float, float]:
    """Point `dist` px back from the END — stable arrowhead bearing (client lookbackPoint)."""
    acc = 0.0
    for i in range(len(pts) - 1, 0, -1):
        a, b = pts[i], pts[i - 1]
        seg = math.hypot(a[0] - b[0], a[1] - b[1])
        if seg > 0 and acc + seg >= dist:
            t = (dist - acc) / seg
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        acc += seg
    return pts[0]


def _arrow_head(draw: ImageDraw.ImageDraw, pts: list[tuple[float, float]], color: str, width: int) -> None:
    """Filled triangle terminating the line: its BASE sits on the last vertex and the tip
    extends beyond it, so the stroke visibly ends in the arrow (not under it)."""
    end = pts[-1]
    back = _lookback(pts, max(12.0, width * 3.5))
    ang = math.atan2(end[1] - back[1], end[0] - back[0])
    ln, half = max(12.0, width * 3.2), max(6.0, width * 1.7)
    tip = (end[0] + ln * math.cos(ang), end[1] + ln * math.sin(ang))
    nx, ny = -math.sin(ang), math.cos(ang)
    draw.polygon([tip, (end[0] + half * nx, end[1] + half * ny), (end[0] - half * nx, end[1] - half * ny)], fill=color)


def _marker_points(pts: list[tuple[float, float]], spacing: float) -> list[tuple[float, float]]:
    """Positions for the repeated inline letter (—R—R—), every `spacing` px along the
    polyline, starting half a step in (client markerParamsAlong)."""
    out: list[tuple[float, float]] = []
    carry = spacing / 2
    for i in range(1, len(pts)):
        (ax, ay), (bx, by) = pts[i - 1], pts[i]
        seg = math.hypot(bx - ax, by - ay)
        if seg < 1e-3:
            continue
        while carry <= seg:
            t = carry / seg
            out.append((ax + (bx - ax) * t, ay + (by - ay) * t))
            carry += spacing
        carry -= seg
    return out


def _halo_text(draw: ImageDraw.ImageDraw, xy: tuple[float, float], text: str, fs: int, color: str) -> None:
    """Bold letter with a white halo — the marker letters must read on any base map."""
    f = _font(fs)
    r = max(1, fs // 7)
    for dx in (-r, 0, r):
        for dy in (-r, 0, r):
            if dx or dy:
                draw.text((xy[0] + dx, xy[1] + dy), text, font=f, fill="white", anchor="mm")
    draw.text(xy, text, font=f, fill=color, anchor="mm")


def _label_box(draw: ImageDraw.ImageDraw, xy: tuple[float, float], lines: list[str], fs: int) -> None:
    """White label chip; multiple lines stack (distance line + free label, like the map)."""
    f = _font(fs)
    lh = fs * 1.25
    widths = [draw.textlength(t, font=f) for t in lines]
    bw, bh = max(widths), lh * len(lines)
    pad = fs * 0.4
    x, y = xy
    draw.rounded_rectangle([x - bw / 2 - pad, y - bh / 2 - pad, x + bw / 2 + pad, y + bh / 2 + pad],
                           radius=max(2, fs // 4), fill=(255, 255, 255, 238), outline="#d4dae3", width=1)
    for i, t in enumerate(lines):
        draw.text((x, y - bh / 2 + lh * (i + 0.5)), t, font=f, fill="#1b2330", anchor="mm")


def _fmt_distance(m: float) -> str:
    return f"{round(m)} m" if m < 1000 else f"{m / 1000:.2f} km".replace(".", ",")


def _hose_hint(m: float, hose_len: float = 20.0, reserve: float = 0.10) -> str:
    """Messpfeil helper line (client hoseLengthHint): length + reserve ÷ hose length, up."""
    return f"~{math.ceil(m * (1 + reserve) / hose_len)} Schläuche"


def _geodesic_m(coords: list[tuple[float, float]]) -> float:
    total = 0.0
    for (lng1, lat1), (lng2, lat2) in zip(coords, coords[1:]):
        dx = (lng2 - lng1) * 111320 * math.cos(math.radians((lat1 + lat2) / 2))
        dy = (lat2 - lat1) * 110540
        total += math.hypot(dx, dy)
    return total


@dataclass
class KrokiScene:
    """The drawable subset of a workspace: entities + drawings (matching src/types.ts)."""

    entities: list[dict] = field(default_factory=list)
    drawings: list[dict] = field(default_factory=list)

    def extent_points(self) -> list[tuple[float, float]]:
        pts: list[tuple[float, float]] = [tuple(e["coord"]) for e in self.entities]
        for d in self.drawings:
            pts.extend(tuple(c) for c in d.get("coords", []))
            if d.get("kind") == "circle" and d.get("radiusM") and d.get("coords"):
                lng, lat = d["coords"][0]
                dlat = d["radiusM"] / 110540
                dlng = d["radiusM"] / (111320 * math.cos(math.radians(lat)))
                pts += [(lng - dlng, lat - dlat), (lng + dlng, lat + dlat)]
        return pts


def _circle_points(lng: float, lat: float, radius_m: float, n: int = 72) -> list[tuple[float, float]]:
    out = []
    for i in range(n + 1):
        a = 2 * math.pi * i / n
        out.append((
            lng + (radius_m * math.cos(a)) / (111320 * math.cos(math.radians(lat))),
            lat + (radius_m * math.sin(a)) / 110540,
        ))
    return out


def _hex_alpha(color: str, alpha: float) -> tuple[int, int, int, int]:
    c = color.lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
    return (r, g, b, int(alpha * 255))


def render_kroki(scene: KrokiScene, pack: SymbolPack, tile_url: str,
                 width: int = 1600, height: int = 980, view: View | None = None,
                 cache: TileCache | None = None, sym_mul: float = 0.7,
                 attribution: str = "© CARTO, © OpenStreetMap-Mitwirkende",
                 supersample: int = 2, ref_width: int = 1050,
                 max_tile_z: int = 19) -> Image.Image:
    """Compose one Kroki bitmap: base tiles + drawings + tactical symbols + attribution.

    `ref_width`: the on-screen viewport width the client sizing rules assume (~the print
    view's map container). Symbol sizes, line widths and label fonts scale by
    width/ref_width so the printed proportions match the app regardless of render DPI."""
    ss = supersample
    u = width / ref_width  # UI scale: screen-px rules → render-px
    view = view or fit_view(scene.extent_points(), width, height)
    overlay_z = view.overlay_z if view.overlay_z is not None else view.z
    # supersampled view: same world extent, ss× the pixels (tiles are stitched at 1× then
    # upscaled — map detail stays honest, but every overlay edge is drawn at ss× and
    # downsampled, which is where the crispness matters)
    base = render_base(view, tile_url, cache=cache, max_tile_z=max_tile_z)
    img = base.resize((width * ss, height * ss), Image.LANCZOS).convert("RGBA")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    def pt(lng: float, lat: float) -> tuple[float, float]:
        x, y = view.project(lng, lat)
        return x * ss, y * ss

    # --- drawings below symbols; TWO passes like the map's layer order: every polygon
    # FILL first, then every stroke + decor — so an area's fill can never sit on top of a
    # neighbouring line (prod feedback 2026-07-18) ---
    labels: list[tuple[tuple[float, float], list[str], int]] = []
    markers: list[tuple[tuple[float, float], str, int, str]] = []
    for d in scene.drawings:
        color = d.get("color") or "#1f6feb"
        kind = d.get("kind")
        alpha = d.get("fillOpacity") if d.get("fillOpacity") is not None else 0.14
        if kind == "circle" and d.get("coords"):
            lng, lat = d["coords"][0]
            draw.polygon([pt(a, b) for a, b in _circle_points(lng, lat, d.get("radiusM") or 50)],
                         fill=_hex_alpha(color, alpha))
        elif kind == "area" and len(d.get("coords", [])) >= 3:
            draw.polygon([pt(a, b) for a, b in d["coords"]], fill=_hex_alpha(color, alpha))
    for d in scene.drawings:
        color = d.get("color") or "#1f6feb"
        w = max(1, int(round((d.get("width") or 4) * u * ss)))
        kind = d.get("kind")
        if kind == "circle" and d.get("coords"):
            lng, lat = d["coords"][0]
            pts = [pt(a, b) for a, b in _circle_points(lng, lat, d.get("radiusM") or 50)]
            _dashed(draw, pts, color, w, dash=14 * u * ss, gap=10 * u * ss) if d.get("dashed") \
                else draw.line(pts, fill=color, width=w, joint="curve")
            if d.get("radiusM"):
                labels.append((pts[len(pts) // 8], [f"r = {round(d['radiusM'])} m"], int(13 * u * ss)))
        elif kind == "area" and len(d.get("coords", [])) >= 3:
            pts = [pt(a, b) for a, b in d["coords"]]
            draw.line([*pts, pts[0]], fill=color, width=w, joint="curve")
            if d.get("label"):
                cx = sum(p[0] for p in pts) / len(pts)
                cy = sum(p[1] for p in pts) / len(pts)
                labels.append(((cx, cy), [d["label"]], int(14 * u * ss)))
        elif len(d.get("coords", [])) >= 2:
            pts = [pt(a, b) for a, b in d["coords"]]
            if d.get("dashed"):
                _dashed(draw, pts, color, w, dash=14 * u * ss, gap=10 * u * ss)
            else:
                draw.line(pts, fill=color, width=w, joint="curve")
            if d.get("arrow"):
                _arrow_head(draw, pts, color, w)
            if d.get("marker"):
                # repeated inline letter (—R—R—) at the client's 46px screen rhythm
                for mp in _marker_points(pts, 46 * u * ss):
                    markers.append((mp, d["marker"], int(13 * u * ss), color))
            # FKS hose-line decorations: Teilstück fork at the tip + boxed end tag
            # («Leitungsnummer · Inhaltsbuchstabe · Stockwerk») just before it
            if d.get("teilstueck"):
                _teilstueck_fork(overlay, pts, color, w)
            tag_parts: list[str] = []
            if d.get("lineNo") is not None:
                tag_parts.append(str(d["lineNo"]))
            if d.get("content"):
                tag_parts.append(str(d["content"]))
            if d.get("floorTag") is not None:
                tag_parts.append(floor_badge(d["floorTag"]))
            if tag_parts:
                _end_tag(draw, pts, tag_parts, color, int(12 * u * ss))
            # label chip at the midpoint VERTEX (like the map): distance line + free label stack
            lines: list[str] = []
            if d.get("showDistance"):
                ln_m = _geodesic_m(d["coords"])
                lines.append(f"{_fmt_distance(ln_m)} · {_hose_hint(ln_m)}")
            if d.get("label"):
                lines.append(d["label"])
            if lines:
                labels.append((pts[(len(pts) - 1) // 2], lines, int(13 * u * ss)))

    # --- tactical symbols (the client's own pack, same size band + decor: white chip
    # for outline glyphs, FKS spread arrows, floor/count badges, caption below) ---
    for e in scene.entities:
        # dynamic glyphs (live vehicles, placards, shapes) arrive as client-resolved SVG
        # strings; everything else is looked up in the shared pack by name
        svg = e.get("symbolSvg") or (pack.by_name.get(e["symbol"]) if e.get("symbol") else None)
        lng, lat = e["coord"]
        x0_, y0_ = pt(lng, lat)
        if not svg:
            # glyph-less markers: Trupp dot (team colour + name chip) and note pill
            if e.get("kind") == "team" and e.get("caption"):
                r = 7 * u * ss
                tc = e.get("color") or "#1f6feb"
                draw.ellipse([x0_ - r, y0_ - r, x0_ + r, y0_ + r], fill=tc, outline="white", width=max(1, int(1.5 * u * ss)))
                _caption(draw, (x0_, y0_ + r + 2 * u * ss), [str(e["caption"])], int(11.5 * u * ss))
            elif e.get("kind") == "note" and e.get("caption"):
                _label_box(draw, (x0_, y0_), [str(e["caption"])], int(12 * u * ss))
            continue
        # shapes are sized in real-world metres (client shapePx); symbols use the band
        if e.get("sizeM"):
            size = int(round(max(24.0, min(900.0, e["sizeM"] * px_per_m(lat, overlay_z))) * u * ss))
        else:
            size = int(round(sym_px(e.get("kind", "symbol"), lat, overlay_z, sym_mul) * u * ss))
        glyph = raster_svg(svg, size)
        color = sym_color(svg)
        x, y = x0_, y0_
        # FKS Entwicklung arrows sit OUTSIDE the glyph in a 250% box (client .sym-spread)
        if e.get("spread"):
            osize = int(size * 2.5)
            oimg = raster_svg(spread_overlay_svg(e["spread"], color), osize)
            overlay.alpha_composite(oimg, (int(x - osize / 2), int(y - osize / 2)))
        # white legibility chip behind outline symbols (KP Front, hydrants, …)
        if needs_white(svg):
            draw.rounded_rectangle([x - size / 2, y - size / 2, x + size / 2, y + size / 2],
                                   radius=size * 0.14, fill=(255, 255, 255, 235))
        if e.get("rotation"):
            glyph = glyph.rotate(-e["rotation"], expand=True, resample=Image.BICUBIC)
        overlay.alpha_composite(glyph, (int(x - glyph.width / 2), int(y - glyph.height / 2)))
        # storey badge top-right (white chip, symbol colour) / count bottom-right (ink chip)
        bh = max(16.0 * u * ss / 2, size * 0.46)
        if e.get("floor") is not None:
            _badge(draw, (x + size / 2, y - size / 2), floor_badge(e["floor"]), bh, "white", color)
        elif e.get("floorFrom") is not None or e.get("floorTo") is not None:
            rng = "/".join(floor_badge(v) for v in (e.get("floorFrom"), e.get("floorTo")) if v is not None)
            _badge(draw, (x + size / 2, y - size / 2), rng, bh, "white", color)
        if (e.get("count") or 0) > 1:
            _badge(draw, (x + size / 2, y + size / 2), str(e["count"]), bh, "#1b2330", "white")
        # metadata caption under the glyph (the map's .sym-caption)
        if e.get("caption"):
            _caption(draw, (x, y + size / 2 + 3 * u * ss), str(e["caption"]).split("\n"), int(11.5 * u * ss))

    # marker letters over the lines, label chips on top of everything
    for xy, letter, fs, color in markers:
        _halo_text(draw, xy, letter, fs, color)
    for xy, lines, fs in labels:
        _label_box(draw, xy, lines, int(fs))

    out = Image.alpha_composite(img, overlay).resize((width, height), Image.LANCZOS).convert("RGB")
    # attribution (tile ToS) bottom-right
    d2 = ImageDraw.Draw(out)
    f = _font(int(11 * u))
    tw = d2.textlength(attribution, font=f)
    d2.rectangle([out.width - tw - 12 * u, out.height - 18 * u, out.width, out.height], fill=(255, 255, 255, 200))
    d2.text((out.width - tw - 6 * u, out.height - 15 * u), attribution, font=f, fill="#5b6573")
    return out


# ----------------------------------------------------------------------------- plan pages


def render_plan_page(pdf_bytes: bytes, annos: list[dict], pack: SymbolPack | None,
                     width: int = 1600, supersample: int = 2, ref_width: int = 1050) -> Image.Image:
    """Render an annotated Objektplan page: the plan PDF's first page via pdfium, then the
    board annotations (relative 0..1 coords — the Whiteboard's model) drawn on top with the
    same primitives as the Kroki. Mirrors the print view's PlanPrintPage (42px symbols,
    non-scaling ~`width`px strokes)."""
    import pypdfium2 as pdfium

    ss = supersample
    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        page = doc[0]
        pw, ph = page.get_size()
        scale = (width * ss) / pw
        base = page.render(scale=scale).to_pil().convert("RGBA")
    finally:
        doc.close()
    return _overlay_board_annos(base, annos, pack, width, supersample, ref_width)


def render_blank_page(aspect: float, annos: list[dict], pack: SymbolPack | None,
                      width: int = 1600, supersample: int = 2, ref_width: int = 800) -> Image.Image:
    """A plan page WITHOUT a PDF behind it (the Gebäude floor-stack): a white base of the
    given aspect (h/w), with the whole page — footprint outlines, floor labels, north dial
    and the board annos — expressed as the client-sent anno list.

    ref_width 800 (not the plan pages' 1050): the sparse outline sheet needs bigger
    glyphs/text/strokes than a dense Modul-PDF to read well on paper."""
    aspect = max(0.2, min(4.0, aspect))
    ss = supersample
    base = Image.new("RGBA", (width * ss, int(round(width * aspect)) * ss), (255, 255, 255, 255))
    return _overlay_board_annos(base, annos, pack, width, supersample, ref_width)


def _overlay_board_annos(base: Image.Image, annos: list[dict], pack: SymbolPack | None,
                         width: int, supersample: int, ref_width: int) -> Image.Image:
    ss = supersample
    u = width / ref_width
    w, h = base.size
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    def pp(x: float, y: float) -> tuple[float, float]:
        return x * w, y * h

    labels: list[tuple[tuple[float, float], list[str], int]] = []
    for a in annos:
        kind = a.get("kind")
        color = a.get("color") or "#1f6feb"
        sw = max(1, int(round((a.get("width") or 4) * u * ss)))
        if kind in ("draw", "area") and len(a.get("pts") or []) >= 2:
            pts = [pp(px_, py_) for px_, py_ in a["pts"]]
            if kind == "area" and len(pts) >= 3:
                draw.polygon(pts, fill=_hex_alpha(color, (a.get("fillOpacity") if a.get("fillOpacity") is not None else 0.14)))
                draw.line([*pts, pts[0]], fill=color, width=sw, joint="curve")
                if a.get("label"):
                    cx = sum(p[0] for p in pts) / len(pts)
                    cy = sum(p[1] for p in pts) / len(pts)
                    labels.append(((cx, cy), [a["label"]], int(14 * u * ss)))
            else:
                if a.get("dashed"):
                    _dashed(draw, pts, color, sw, dash=14 * u * ss, gap=10 * u * ss)
                else:
                    draw.line(pts, fill=color, width=sw, joint="curve")
        elif kind == "symbol":
            svg = a.get("symbolSvg") or (pack.by_name.get(a["symbol"]) if pack and a.get("symbol") else None)
            if not svg:
                continue
            # symbols print at a fixed 42px; generic shapes carry their size as a
            # fraction of the plan width (sizeN) — mirror of the on-screen sizing
            size = int(round(a["sizeN"] * w)) if a.get("sizeN") else int(round(42 * u * ss))
            glyph = raster_svg(svg, size)
            if a.get("rotation"):
                glyph = glyph.rotate(-a["rotation"], expand=True, resample=Image.BICUBIC)
            x, y = pp(a.get("x") or 0, a.get("y") or 0)
            overlay.alpha_composite(glyph, (int(x - glyph.width / 2), int(y - glyph.height / 2)))
        elif kind in ("text", "resource") and (a.get("text") or "").strip():
            x, y = pp(a.get("x") or 0, a.get("y") or 0)
            fs = int(12 * u * ss)
            f = _font(fs)
            t = a["text"]
            tw_ = draw.textlength(t, font=f)
            pad = fs * 0.45
            # keep the pill on the sheet: an anchor near the edge must not clip the text
            half = tw_ / 2 + pad
            x = max(half + 2, min(w - half - 2, x))
            dark = kind == "resource"  # resource chips are ink-on-dark like the app
            draw.rounded_rectangle([x - half, y - fs * 0.9, x + half, y + fs * 0.9],
                                   radius=max(2, fs // 4),
                                   fill="#1b2330" if dark else (255, 255, 255, 240),
                                   outline=None if dark else "#d4dae3", width=1)
            draw.text((x, y), t, font=f, fill="white" if dark else "#1b2330", anchor="mm")
    for xy, lines, fs in labels:
        _label_box(draw, xy, lines, int(fs))

    out = Image.alpha_composite(base, overlay)
    return out.resize((width, int(round(h / ss))), Image.LANCZOS).convert("RGB")

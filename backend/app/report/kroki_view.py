"""The Kroki's print canvas and framing — shared by the Kroki page and the Tafel's Lagekarte.

Split out of the former ``report_pdf.py``; rules for this area: docs/rapport.md.
"""

from __future__ import annotations

import logging
import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .schema import ReportPayload

logger = logging.getLogger(__name__)

# ----------------------------------------------------------------------------- composition

# Print Kroki canvas size — the composer and the tile prewarm share it so both derive the
# same View and hit identical tile-cache keys.
#: ⚠️ Raised 30 % on 18.08. The picture is placed ~180 mm wide, so 1000 px was 141 dpi — every
#: glyph edge and every number on the Kroki was softer on paper than the same picture on screen,
#: which is most of what «das PDF sieht schlechter aus» actually was. 1300 px ≈ 183 dpi, still
#: within what the compositor can hold (it draws at `supersample` × these numbers).
#: ⚠️ This does NOT make symbols bigger relative to the frame — `ref_width` scales the drawing
#: rules with the render, on purpose, so the proportions stay the app's. The size lever is
#: `kroki_symbol_mul`.
_KROKI_PX = (2080, 1222)
#: the same crop turned upright — a portrait Kroki page gets a portrait render, so the picture
#: fills the sheet instead of being letterboxed into a landscape frame
#: the Tafel's Lagekarte box (app/report_board): about the FKS poster's box shape, scaled to A4
_BOARD_MAP_PX = (1200, 880)
_KROKI_PX_PORTRAIT = (1300, 1820)


#: a Lage this small is «compact» — client lib/report · KROKI_COMPACT_SPAN_M
_KROKI_COMPACT_SPAN_M = 30.0


def _kroki_fit_max_z(pts: list[tuple[float, float]]) -> float:
    """The auto-fit's zoom ceiling in THIS projection's terms — client lib/report · krokiFitMaxZoom
    (a MapLibre camera zoom) + 1. 21 is the basemap's last sharp level; a COMPACT Lage may go one
    past it, which doubles the separation of a cluster that otherwise fills 15 % of the sheet."""
    if len(pts) < 2:
        return 21.0
    lngs, lats = [p[0] for p in pts], [p[1] for p in pts]
    lat = (min(lats) + max(lats)) / 2
    span = max((max(lngs) - min(lngs)) * 111320 * math.cos(math.radians(lat)), (max(lats) - min(lats)) * 110540)
    return 22.0 if span < _KROKI_COMPACT_SPAN_M else 21.0


def _kroki_view(pk, kw: int, kh: int):
    """Derive the print View for a Kroki scene — shared by the composer and the tile prewarm."""
    from .. import kroki as kk

    if pk.bounds and len(pk.bounds) == 4:
        view = kk.bounds_view(tuple(pk.bounds), kw, kh)
        # Bounds carry no camera zoom; retain it for print symbol scaling when present.
        view.overlay_z = pk.zoom
        return view
    if pk.center and pk.zoom is not None:
        return kk.center_view(tuple(pk.center), pk.zoom, kw, kh)
    scene = kk.KrokiScene(
        entities=[e.model_dump() for e in pk.entities], drawings=[d.model_dump() for d in pk.drawings]
    )
    pts = [tuple(p) for p in pk.fitPoints] or scene.extent_points()
    # ⚠️ The fallback has to frame like the PANEL does, because it is what prints when no crop was
    # reported (a rapport made before the panel settled). KrokiFramingPanel caps its auto-fit at
    # MapLibre zoom 20 — and a MapLibre zoom is one level TIGHTER than this 256-px projection's
    # (see center_view), so the «mirror» cap of 20 here framed twice the ground: on the 18.09.
    # review the same Lage came out with its symbols merged into one blob. Cap per
    # `_kroki_fit_max_z`, and hand the
    # glyph sizing the camera zoom it gets on every other path (overlay_z).
    view = kk.fit_view(pts, kw, kh, max_z=_kroki_fit_max_z(pts))
    view.overlay_z = view.z - math.log2(512 / kk.TILE)
    return view


def warm_report_tiles(payload: ReportPayload) -> None:
    """Fetch+cache the Kroki base tiles for this report's map view and discard the image, so
    a later compose skips the network round-trips. Pure cache warming; never raises.

    Fired by the print relay's prewarm endpoint when the Rapport modal opens."""
    opt = payload.options
    if not (opt.kroki and payload.kroki is not None and payload.kroki.tiles):
        return
    try:
        from .. import kroki as kk

        view = _kroki_view(payload.kroki, *(_KROKI_PX if opt.krokiLandscape else _KROKI_PX_PORTRAIT))
        kk.render_base(
            view,
            kk.approved_tile_template(payload.kroki.tiles),
            cache=kk.get_tile_cache(),
            max_tile_z=payload.kroki.maxTileZoom or 19,
        )
    except Exception:  # noqa: BLE001 — a cold cache must not fail the rapport
        # A failed prewarm is recoverable (the real render refetches), but silence here is how a
        # permanently unreachable tile source stays invisible.
        logger.warning("Rapport tile prewarm failed; the render will refetch", exc_info=True)

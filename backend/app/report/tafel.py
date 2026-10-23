"""The Tafel's sheets — inside the Rapport and as their own print (compose_tafel_pdf).

Split out of the former ``report_pdf.py``; rules for this area: docs/rapport.md.
"""

from __future__ import annotations

import io
import logging

from pydantic import BaseModel
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
)

from ..report_board import BoardPageFlowable, BoardPageIn, Continuation, page_has_map
from .kroki_view import _BOARD_MAP_PX, _kroki_view
from .labels import L
from .schema import IncidentFacts, KrokiIn
from .styles import _PANEL, _esc, _NumberedCanvas, _styles, _table_style

logger = logging.getLogger(__name__)


def _board_map_png(pk: KrokiIn | None) -> bytes | None:
    """The Tafel's «Lagekarte» box: the scene rendered like the Kroki, auto-framed, at the box's
    shape. None (an empty box to sketch in) without a pack, a base or a working render."""
    if pk is None or not pk.tiles:
        return None
    from .. import kroki as kk

    pack = kk.get_pack()
    if pack is None:
        return None
    kw, kh = _BOARD_MAP_PX
    try:
        view = _kroki_view(pk, kw, kh)
        img = kk.render_kroki(
            kk.KrokiScene(
                entities=[e.model_dump() for e in pk.entities], drawings=[d.model_dump() for d in pk.drawings]
            ),
            pack,
            kk.approved_tile_template(pk.tiles),
            width=kw,
            height=kh,
            view=view,
            cache=kk.get_tile_cache(),
            sym_mul=kk.kroki_symbol_mul(view.overlay_z if view.overlay_z is not None else view.z),
            max_tile_z=pk.maxTileZoom or 19,
            attribution=pk.attribution,
        )
    except Exception:  # noqa: BLE001 — a failed map must not sink the rapport; the box stays blank
        logger.warning("Tafel Lagekarte could not be rendered; box left blank", exc_info=True)
        return None
    b = io.BytesIO()
    img.save(b, "PNG")
    return b.getvalue()


def _tafel_story(
    pages: list[BoardPageIn], board_map: KrokiIn | None, title: str, generated_at: str, head, st, first: bool = False
) -> list:
    """Every Tafel page on a sheet of its own, in its own layout, each followed by its
    «Fortsetzung» — the Rapport's Tafel part and the Tafel's own print (compose_tafel_pdf) alike.
    `first`: the story starts with these sheets (no page break before the first one)."""
    out: list = []
    map_png = _board_map_png(board_map) if any(page_has_map(bp) for bp in pages) else None
    page_caption = f"{title} · {generated_at}"
    for i, bp in enumerate(pages):
        out.append(NextPageTemplate("landscape" if bp.landscape else "portrait"))
        if not (first and i == 0):
            out.append(PageBreak())
        sheet = BoardPageFlowable(
            bp,
            map_png if page_has_map(bp) else None,
            caption=page_caption,
            map_caption=L["boardMapAt"].format(t=generated_at),
        )
        out.append(sheet)
        # what a box could not hold, after the sheet — nothing written is cut off the record
        out.append(Continuation(sheet, lambda ov, w: _board_overflow(ov, head, st, w)))
    # the sheet fills its frame, so whatever follows starts a new page by itself — portrait
    # again, and no PageBreak here (two in a row print an empty sheet)
    out.append(NextPageTemplate("portrait"))
    return out


class TafelPrintPayload(BaseModel):
    """The Tafel's own print (10.10.2026, owner): one page or all of them, from the page's
    «Drucken» — the same sheets the Rapport carries, without the Rapport around them."""

    incident: IncidentFacts
    generatedAt: str  # client-formatted
    boardPages: list[BoardPageIn]
    boardMap: KrokiIn | None = None


def compose_tafel_pdf(payload: TafelPrintPayload) -> bytes:
    """Just the Tafel pages: each on A4 in its template's paper (portrait / landscape), the
    Erste Führung as its poster, the Fortsetzung after it — exactly as in the Rapport."""
    st = _styles()
    buf = io.BytesIO()
    pw, ph = A4
    lw, lh = landscape(A4)
    margin = 14 * mm
    doc = BaseDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=margin,
        bottomMargin=margin,
        title=f"Tafel — {payload.incident.title}",
        author="KP Front",
    )
    doc.addPageTemplates(
        [
            PageTemplate(
                id="portrait",
                frames=[Frame(margin, margin, pw - 2 * margin, ph - 2 * margin, id="p", leftPadding=0, rightPadding=0)],
                pagesize=A4,
            ),
            PageTemplate(
                id="landscape",
                frames=[Frame(margin, margin, lw - 2 * margin, lh - 2 * margin, id="l", leftPadding=0, rightPadding=0)],
                pagesize=landscape(A4),
            ),
        ]
    )

    def head(text: str) -> list:
        hr = HRFlowable(
            width="100%", thickness=1.1, color=colors.HexColor("#282828"), spaceBefore=0, spaceAfter=7, lineCap="butt"
        )
        hr.keepWithNext = 1
        return [Paragraph(_esc(text), st["h2"]), hr]

    story = _tafel_story(
        payload.boardPages, payload.boardMap, payload.incident.title, payload.generatedAt, head, st, first=True
    )
    if payload.boardPages and payload.boardPages[0].landscape:
        # the first sheet's own paper: the document starts on the portrait template otherwise
        doc.pageTemplates.insert(0, doc.pageTemplates.pop(1))
    label = " · ".join(x for x in (payload.incident.title, payload.generatedAt) if x)

    class _Stamped(_NumberedCanvas):
        footer_label = label

    doc.build(story, canvasmaker=_Stamped)
    return buf.getvalue()


def _board_overflow(overflow, head, st: dict[str, ParagraphStyle], width: float) -> list:
    """The «Fortsetzung» tables for rows a Tafel box could not hold (app/report_board) — full-size
    type, as many pages as they need.

    ⚠️ The heading is the table's own first row, repeated with the column heads on every page
    (review of #338): as a separate keep-with-next heading it printed alone at the foot of one
    page with its table starting on the next. And a row may SPLIT across pages (`splitInRow`):
    one cell of 600 words used to fail the Tafel print and the whole Rapport with a LayoutError."""
    out: list = []
    for ov in overflow:
        n = max(1, len(ov.columns))
        title = [Paragraph(f"<b>{_esc(L['boardContinued'].format(t=ov.title))}</b>", st["cell"])] + [""] * (n - 1)
        thead = [Paragraph(_esc(c), st["cellhead"]) for c in ov.columns]
        body = [[Paragraph(_esc(v), st["cell"]) for v in (list(r) + [""] * n)[:n]] for r in ov.rows]
        tbl = Table([title, thead, *body], colWidths=[width / n] * n, repeatRows=2, splitInRow=1)
        style = _table_style()
        style.add("SPAN", (0, 0), (-1, 0))
        style.add("BACKGROUND", (0, 1), (-1, 1), _PANEL)
        tbl.setStyle(style)
        out.append(tbl)
        out.append(Spacer(1, 4 * mm))
    return out

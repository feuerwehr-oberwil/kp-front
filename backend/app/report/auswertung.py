"""The Auswertung sheet — the internal debrief Beilage, drawn as vector swimlanes.

Split out of the former ``report_pdf.py``; rules for this area: docs/rapport.md.
"""

from __future__ import annotations

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    Flowable,
    KeepTogether,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from .schema import AuswertungGroupIn, AuswertungIn, AuswertungLaneIn, AuswertungTimelineIn
from .styles import _DIM_INK, _GRID, _INK, _PANEL, _URGENT, _esc, _fit_text, _str_w

# ----------------------------------------------------------------------------- Auswertung
#
# The internal debrief Beilage (F7, 09.10.2026; payload: AuswertungIn, derived client-side in
# src/lib/auswertung.ts). Vector all the way — the swimlanes are canvas strokes, never a bitmap —
# and legible in GREYSCALE, because most station printers are one: the two contact tiers carry a
# hatch (fällig: sparse diagonal) and a cross-hatch (überfällig: dense) on top of their colour, so
# amber and red stay two different things when both print as grey.

_AW_LABEL_W = 48 * mm  # the lane-name column
_AW_ROW_H = 4.7 * mm
_AW_GROUP_H = 4.4 * mm
_AW_AXIS_H = 5.5 * mm
_AW_MILESTONE_H = 7 * mm
_AW_BAR_H = 3.0 * mm

_AW_TRAVEL = colors.HexColor("#b9c1cc")
_AW_SCENE = colors.HexColor("#3b4656")
_AW_AS = colors.HexColor("#2f6fd6")
_AW_WORK = colors.HexColor("#8a94a3")
_AW_PHASE = colors.HexColor("#c9d6ea")
_AW_FAELLIG = colors.HexColor("#e8a317")
_AW_UEBER = colors.HexColor("#cf3324")
_AW_MILESTONE = colors.HexColor("#178a4a")
_AW_DIM = colors.HexColor(_DIM_INK)


def _aw_hatch(c, x: float, y: float, w: float, h: float, step: float, cross: bool) -> None:
    """Diagonal hatch lines clipped to a rectangle — the greyscale half of a contact tier."""
    if w <= 0 or h <= 0:
        return
    c.saveState()
    p = c.beginPath()
    p.rect(x, y, w, h)
    c.clipPath(p, stroke=0, fill=0)
    c.setStrokeColor(colors.HexColor("#141414"))
    c.setLineWidth(0.45)
    k = -h
    while k < w:
        c.line(x + k, y, x + k + h, y + h)
        if cross:
            c.line(x + k, y + h, x + k + h, y)
        k += step
    c.restoreState()


def _aw_gap_swatch(c, x: float, y: float, w: float, h: float, level: int) -> None:
    c.setFillColor(_AW_UEBER if level >= 2 else _AW_FAELLIG)
    c.rect(x, y, w, h, stroke=0, fill=1)
    _aw_hatch(c, x, y, w, h, 1.6 if level >= 2 else 2.6, cross=level >= 2)


def _aw_diamond(c, cx: float, cy: float, r: float) -> None:
    p = c.beginPath()
    p.moveTo(cx, cy + r)
    p.lineTo(cx + r, cy)
    p.lineTo(cx, cy - r)
    p.lineTo(cx - r, cy)
    p.close()
    c.setFillColor(_AW_MILESTONE)
    c.setStrokeColor(colors.white)
    c.setLineWidth(0.6)
    c.drawPath(p, stroke=1, fill=1)


class _Swimlanes(Flowable):
    """The timeline: an axis, a milestone row, then one row per lane under its group's heading.

    Splits between rows (ReportLab asks via `split`), and every part repeats the axis and the
    milestones, so a sheet pulled out of the stack still reads on its own. A group heading never
    ends a part — it moves to the next one with its first lane.
    """

    def __init__(
        self, tl: AuswertungTimelineIn, rows: list[tuple[str, AuswertungLaneIn | AuswertungGroupIn]], width: float
    ):
        super().__init__()
        self.tl = tl
        self.rows = rows
        self.width = width

    @staticmethod
    def build(tl: AuswertungTimelineIn, width: float) -> _Swimlanes:
        rows: list[tuple[str, AuswertungLaneIn | AuswertungGroupIn]] = []
        for g in tl.groups:
            rows.append(("group", g))
            rows.extend(("lane", lane) for lane in g.lanes)
        return _Swimlanes(tl, rows, width)

    def _head_h(self) -> float:
        return _AW_AXIS_H + (_AW_MILESTONE_H if self.tl.milestones else 0)

    @staticmethod
    def _row_h(kind: str) -> float:
        return _AW_GROUP_H if kind == "group" else _AW_ROW_H

    def wrap(self, aw, ah):
        self.height = self._head_h() + sum(self._row_h(k) for k, _ in self.rows) + 2
        return self.width, self.height

    def split(self, aw, ah):
        room = ah - self._head_h() - 2
        n, used = 0, 0.0
        for kind, _ in self.rows:
            h = self._row_h(kind)
            if used + h > room:
                break
            used += h
            n += 1
        while n > 0 and self.rows[n - 1][0] == "group":
            n -= 1
        if n <= 0 or n >= len(self.rows):
            return [] if n <= 0 else [self]
        return [_Swimlanes(self.tl, self.rows[:n], self.width), _Swimlanes(self.tl, self.rows[n:], self.width)]

    def draw(self):
        c = self.canv
        tl = self.tl
        x0 = _AW_LABEL_W
        pw = self.width - x0 - 2
        span = max(tl.span, 1.0)

        def xpos(t: float) -> float:
            return x0 + max(0.0, min(1.0, t / span)) * pw

        top = self.height
        body_top = top - self._head_h()
        bottom = 2.0
        # axis: tick labels on top, faint gridlines down through every row
        c.setFont("Helvetica", 7)
        for tk in tl.ticks:
            x = xpos(tk.at)
            c.setStrokeColor(_GRID)
            c.setLineWidth(0.4)
            c.line(x, bottom, x, top - _AW_AXIS_H + 1)
            c.setFillColor(_AW_DIM)
            # a label at either end of the axis is kept inside it, not hung off the sheet's margin
            half = _str_w(tk.label, "Helvetica", 7) / 2
            c.drawCentredString(min(max(x, x0 + half), x0 + pw - half), top - _AW_AXIS_H + 2.2, tk.label)
        c.setStrokeColor(_AW_DIM)
        c.setLineWidth(0.6)
        c.line(x0, top - _AW_AXIS_H + 1, x0 + pw, top - _AW_AXIS_H + 1)

        # milestones: numbered diamonds; the words are in the list under the chart
        if tl.milestones:
            y = top - _AW_AXIS_H - _AW_MILESTONE_H / 2 - 0.5
            c.setFillColor(_INK)
            c.setFont("Helvetica-Bold", 7.5)
            c.drawString(0, y - 2.5, _fit_text(c, tl.milestonesLabel, _AW_LABEL_W - 3 * mm, "Helvetica-Bold", 7.5))
            for i, ms in enumerate(tl.milestones, start=1):
                x = xpos(ms.at)
                c.setStrokeColor(_AW_MILESTONE)
                c.setLineWidth(0.5)
                c.setDash(1, 1.5)
                c.line(x, bottom, x, y)
                c.setDash()
                _aw_diamond(c, x, y, 1.9 * mm)
                c.setFillColor(_INK)
                c.setFont("Helvetica-Bold", 6.5)
                c.drawCentredString(x, y + 2.3 * mm, str(i))

        y = body_top
        for kind, item in self.rows:
            h = self._row_h(kind)
            y -= h
            if kind == "group":
                c.setFillColor(_INK)
                c.setFont("Helvetica-Bold", 7.5)
                c.drawString(0, y + 1.3, _fit_text(c, item.label, _AW_LABEL_W - 3 * mm, "Helvetica-Bold", 7.5))
                c.setStrokeColor(_GRID)
                c.setLineWidth(0.5)
                c.line(x0, y + 0.6, x0 + pw, y + 0.6)
                continue
            lane = item
            mid = y + h / 2
            by = mid - _AW_BAR_H / 2
            c.setFillColor(_INK)
            c.setFont("Helvetica", 7.5)
            c.drawString(2.5 * mm, mid - 2.5, _fit_text(c, lane.label, _AW_LABEL_W - 5 * mm, "Helvetica", 7.5))
            # bars, bottom layer first: standby, work, travel/return, scene, phase, AS
            order = {"standby": 0, "work": 1, "travel": 2, "return": 2, "scene": 3, "phase": 3, "as": 4}
            for b in sorted(lane.bars, key=lambda b: order.get(b.kind, 1)):
                bx, ex = xpos(b.start), xpos(b.end)
                w = max(ex - bx, 0.8)
                if b.kind == "standby":
                    c.setStrokeColor(_AW_WORK)
                    c.setLineWidth(0.8)
                    c.setDash(1.5, 1.2)
                    c.line(bx, mid, bx + w, mid)
                    c.setDash()
                elif b.kind == "work":
                    c.setStrokeColor(_AW_WORK)
                    c.setFillColor(colors.white)
                    c.setLineWidth(0.7)
                    c.roundRect(bx, by, w, _AW_BAR_H, 1.2, stroke=1, fill=1)
                elif b.kind == "phase":
                    c.setStrokeColor(_AW_DIM)
                    c.setFillColor(_AW_PHASE)
                    c.setLineWidth(0.4)
                    c.roundRect(bx, by, w, _AW_BAR_H, 1.2, stroke=1, fill=1)
                else:
                    c.setFillColor({"travel": _AW_TRAVEL, "return": _AW_TRAVEL, "scene": _AW_SCENE}.get(b.kind, _AW_AS))
                    c.roundRect(bx, by, w, _AW_BAR_H, 1.2, stroke=0, fill=1)
            for g in lane.gaps:
                gx = xpos(g.start)
                _aw_gap_swatch(c, gx, by, max(xpos(g.end) - gx, 0.8), _AW_BAR_H, g.level)
            # recorded contacts: a white stroke through the bar, readable on every fill
            c.setStrokeColor(colors.white)
            c.setLineWidth(1.0)
            for t in lane.contacts:
                x = xpos(t)
                c.line(x, by + 0.5, x, by + _AW_BAR_H - 0.5)
            for t in lane.marks:
                c.setStrokeColor(_AW_SCENE)
                c.setFillColor(colors.white)
                c.setLineWidth(0.8)
                c.circle(xpos(t), mid, 1.1 * mm, stroke=1, fill=1)
            c.setStrokeColor(_GRID)
            c.setLineWidth(0.3)
            c.line(x0, y, x0 + pw, y)


class _AwLegend(Flowable):
    """One line of swatches + words, wrapped to the width: says what each ink on the chart means."""

    def __init__(self, items: list[tuple[str, str]], width: float):
        super().__init__()
        self.items = items
        self.width = width
        self._lines: list[list[tuple[str, str, float]]] = []

    _SW = 6 * mm
    _GAP = 4 * mm
    _LH = 4.4 * mm

    def wrap(self, aw, ah):
        self._lines = [[]]
        x = 0.0
        for kind, text in self.items:
            w = self._SW + 1.5 * mm + _str_w(text, "Helvetica", 7.5) + self._GAP
            if x + w > self.width and self._lines[-1]:
                self._lines.append([])
                x = 0.0
            self._lines[-1].append((kind, text, x))
            x += w
        self.height = len(self._lines) * self._LH
        return self.width, self.height

    def draw(self):
        c = self.canv
        bh = _AW_BAR_H * 0.8
        for li, line in enumerate(self._lines):
            mid = self.height - (li + 0.5) * self._LH
            for kind, text, x in line:
                by = mid - bh / 2
                sw = self._SW
                if kind == "contact":
                    c.setFillColor(_AW_AS)
                    c.rect(x, by, sw, bh, stroke=0, fill=1)
                    c.setStrokeColor(colors.white)
                    c.setLineWidth(1.0)
                    c.line(x + sw / 2, by + 0.4, x + sw / 2, by + bh - 0.4)
                elif kind in ("faellig", "ueberfaellig"):
                    _aw_gap_swatch(c, x, by, sw, bh, 2 if kind == "ueberfaellig" else 1)
                elif kind == "milestone":
                    _aw_diamond(c, x + sw / 2, mid, 1.6 * mm)
                elif kind == "standby":
                    c.setStrokeColor(_AW_WORK)
                    c.setLineWidth(0.8)
                    c.setDash(1.5, 1.2)
                    c.line(x, mid, x + sw, mid)
                    c.setDash()
                elif kind == "work":
                    c.setStrokeColor(_AW_WORK)
                    c.setFillColor(colors.white)
                    c.setLineWidth(0.7)
                    c.rect(x, by, sw, bh, stroke=1, fill=1)
                elif kind == "phase":
                    c.setStrokeColor(_AW_DIM)
                    c.setFillColor(_AW_PHASE)
                    c.setLineWidth(0.4)
                    c.rect(x, by, sw, bh, stroke=1, fill=1)
                else:
                    c.setFillColor({"travel": _AW_TRAVEL, "scene": _AW_SCENE}.get(kind, _AW_AS))
                    c.rect(x, by, sw, bh, stroke=0, fill=1)
                c.setFillColor(_INK)
                c.setFont("Helvetica", 7.5)
                c.drawString(x + sw + 1.5 * mm, mid - 2.6, text)


def _aw_legend_items(aw: AuswertungIn) -> list[tuple[str, str]]:
    """Only the inks the chart actually carries — a legend entry for something absent is noise."""
    lg = aw.legend
    tl = aw.timeline
    kinds: set[str] = set()
    gap_levels: set[int] = set()
    contacts = False
    if tl is not None:
        for g in tl.groups:
            for lane in g.lanes:
                kinds.update(b.kind for b in lane.bars)
                gap_levels.update(gp.level for gp in lane.gaps)
                contacts = contacts or bool(lane.contacts)
    items: list[tuple[str, str]] = []
    if kinds & {"travel", "return"}:
        words = [w for k, w in (("travel", lg.travel), ("return", lg.back)) if k in kinds]
        items.append(("travel", " / ".join(words)))
    for kind, text in (
        ("scene", lg.scene),
        ("phase", lg.phase),
        ("standby", lg.standby),
        ("work", lg.work),
        ("as", lg.pa),
    ):
        if kind in kinds:
            items.append((kind, text))
    if contacts:
        items.append(("contact", lg.contact))
    if 1 in gap_levels:
        items.append(("faellig", lg.faellig))
    if 2 in gap_levels:
        items.append(("ueberfaellig", lg.ueberfaellig))
    if tl is not None and tl.milestones:
        items.append(("milestone", lg.milestone))
    return items


def _auswertung_story(aw: AuswertungIn, width: float, st: dict[str, ParagraphStyle], head) -> list:
    """The Auswertung sheet: heading, the key figures, the swimlanes + legend, the milestone list,
    the pointer to the Lehren, the figures' definitions."""
    out: list = [*head(aw.heading)]
    if aw.note:
        out.append(Paragraph(_esc(aw.note), st["muted"]))
        out.append(Spacer(1, 4))

    # key figures: one tile each, the definition's number beside the label
    lab = ParagraphStyle("aw_lab", parent=st["cellhead"], fontSize=7.5, leading=9.5)
    val = ParagraphStyle("aw_val", parent=st["body"], fontName="Helvetica-Bold", fontSize=17, leading=20)
    sub = ParagraphStyle("aw_sub", parent=st["muted"], fontSize=7.5, leading=9.5)
    notes = [f for f in aw.figures if f.footnote]
    if aw.figures:
        n_fig = len(aw.figures)
        gutter = 3 * mm
        tile_w = (width - gutter * (n_fig - 1)) / n_fig
        cells: list = []
        widths: list[float] = []
        note_no = 0
        for i, f in enumerate(aw.figures):
            ref = ""
            if f.footnote:
                note_no += 1
                ref = f" <super>{note_no}</super>"
            color = f' color="{_URGENT}"' if f.alert else ""
            body = [Paragraph(_esc(f.label) + ref, lab), Paragraph(f"<font{color}>{_esc(f.value)}</font>", val)]
            if f.sub:
                body.append(Paragraph(_esc(f.sub), sub))
            cells.append(body)
            widths.append(tile_w)
            if i < n_fig - 1:
                cells.append("")
                widths.append(gutter)
        t = Table([cells], colWidths=widths)
        style = [
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]
        for i in range(0, len(cells), 2):
            style.append(("BACKGROUND", (i, 0), (i, 0), _PANEL))
        t.setStyle(TableStyle(style))
        out.append(t)
        out.append(Spacer(1, 8))

    if aw.timeline is not None:
        out.append(_Swimlanes.build(aw.timeline, width))
        legend = _aw_legend_items(aw)
        if legend:
            out.append(Spacer(1, 3))
            out.append(_AwLegend(legend, width))
        if aw.timeline.milestones:
            out.append(Spacer(1, 4))
            line = " · ".join(
                f"<b>{i}</b> {_esc(m.label)}" + (f" {_esc(m.time)}" if m.time else "")
                for i, m in enumerate(aw.timeline.milestones, start=1)
            )
            out.append(Paragraph(f"<b>{_esc(aw.timeline.milestonesLabel)}:</b> {line}", st["cell"]))
    elif aw.noTimeline:
        out.append(Paragraph(_esc(aw.noTimeline), st["muted"]))

    # the pointer to the Lehren before the definitions: the definitions are footnotes, they close
    # the page
    if aw.lehrenNote:
        out.append(Spacer(1, 6))
        out.append(Paragraph(f"<b>{_esc(aw.lehrenNote)}</b>", st["cell"]))

    if notes:
        out.append(Spacer(1, 6))
        fn = ParagraphStyle("aw_fn", parent=st["muted"], fontSize=7.5, leading=9.5)
        block = [Paragraph(f"<b>{_esc(aw.footnotesHead)}</b>", fn)]
        block.extend(
            Paragraph(f"<super>{i}</super> <b>{_esc(f.label)}</b>: {_esc(f.footnote)}", fn)
            for i, f in enumerate(notes, start=1)
        )
        out.append(KeepTogether(block))

    return out

"""Führungsformular «Zeitplan» — the Schichtenplanung as one A4-landscape sheet.

Its own composer, deliberately NOT a section of ``compose_report_pdf``: the rapport is the
record of a finished Einsatz, this is a working sheet you print mid-incident to hang at the
front or hand to the relief. Different lifetime, different page, no shared state — only the
rapport's styles and its page-number canvas are borrowed so both look like the same house.

The layout follows the KKO BS / KFS BL sheet: a ``Wer × Zeit`` grid, names down the left, a
time axis across the top with a heavier rule every full hour. Planned availability is drawn
hollow and assigned time filled — the same language the on-screen Zeitplan uses, so the paper
reads like the tablet. Under each lane runs a thin ink rule for the attendance actually recorded:
the sheet is read by somebody deciding who to send home and who to call in, and «what was planned»
without «what happened» leaves out the half that says whether the plan held. It stays visually
subordinate — plan in accent above, record in ink below — so the page is still a planning form
first. (The Rapport remains the RECORD; this is the working copy of it.) Rows without a plan still
print — a Führungsformular is meant to be written on, and an empty row is where the pen goes.
"""

from __future__ import annotations

import io
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, field_validator
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from reportlab.platypus import BaseDocTemplate, Flowable, Frame, PageBreak, PageTemplate, Paragraph, Spacer

from .report_pdf import _esc, _NumberedCanvas, _styles

#: The station's wall clock. The client sends UTC ISO stamps (`toISOString()`), so every label
#: on this sheet has to be converted before it is printed — rendering the aware datetime directly
#: put the whole Führungsformular two hours out in summer, one in winter.
TZ = ZoneInfo("Europe/Zurich")


def _local(dt: datetime | None) -> datetime | None:
    """Into the station's wall clock. Naive input is assumed to be local already."""
    if dt is None:
        return None
    return dt.astimezone(TZ) if dt.tzinfo else dt


SLOT_MIN = 30
#: rows per sheet — as many lanes as fit under the heading at a height you can still write in
MAX_ROWS = 16
#: how far the axis runs when nothing says otherwise
DEFAULT_WINDOW_H = 12

_INK = colors.HexColor("#1b2330")
_DIM = colors.HexColor("#8a94a3")
_RULE = colors.HexColor("#c9cfd8")
_ACCENT = colors.HexColor("#1f6feb")


class ZeitplanBlock(BaseModel):
    """One planned bar: availability offered (hollow) or, once ``confirmed``, assigned (solid)."""

    start: datetime = Field(alias="from")
    end: datetime | None = Field(default=None, alias="to")
    confirmed: bool = False

    model_config = {"populate_by_name": True}

    @field_validator("start", "end")
    @classmethod
    def _to_local(cls, v: datetime | None) -> datetime | None:
        return _local(v)


class ZeitplanRow(BaseModel):
    name: str
    rank: str | None = None
    blocks: list[ZeitplanBlock] = []
    #: what actually HAPPENED — the recorded attendance for this person, drawn as a thin rule
    #: along the foot of the lane. Defaulted to empty so an older client that never sends the
    #: field still renders a valid (plan-only) sheet.
    actual: list[ZeitplanBlock] = []


class ZeitplanPayload(BaseModel):
    incidentTitle: str
    incidentAddress: str | None = None
    startedAt: datetime | None = None
    printedAt: datetime | None = None
    rows: list[ZeitplanRow] = []

    @field_validator("startedAt", "printedAt")
    @classmethod
    def _to_local(cls, v: datetime | None) -> datetime | None:
        return _local(v)


def _window(payload: ZeitplanPayload) -> tuple[datetime, datetime]:
    """The stretch of time the axis covers: from the incident start (floored to the hour) up to
    the last block, at least ``DEFAULT_WINDOW_H`` wide so a fresh plan is not a sliver."""
    # both halves count: a sheet whose axis stopped at the last PLANNED block would cut the
    # attendance that ran past it, which is exactly the overrun worth seeing
    stamps = [b.start for r in payload.rows for b in (*r.blocks, *r.actual)]
    stamps += [b.end for r in payload.rows for b in (*r.blocks, *r.actual) if b.end]
    anchor = payload.startedAt or payload.printedAt or (min(stamps) if stamps else datetime.now(TZ))
    start = anchor.replace(minute=0, second=0, microsecond=0)
    end = start + timedelta(hours=DEFAULT_WINDOW_H)
    for s in stamps:
        if s > end:
            end = s
    # round the tail up to a full hour so the last column is a whole one
    if end.minute or end.second:
        end = end.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    return start, end


class _Grid(Flowable):
    """The Wer × Zeit grid itself, drawn directly — a Platypus Table cannot express bars that
    start and end between column boundaries."""

    NAME_W = 46 * mm
    HEAD_H = 7 * mm
    ROW_H = 8.2 * mm

    def __init__(self, rows: list[ZeitplanRow], start: datetime, end: datetime, width: float, now: datetime):
        super().__init__()
        self.rows = rows
        self.start = start
        self.end = end
        #: where an still-open attendance block stops. The PRINT time, not the wall clock: the
        #: sheet is a statement about the moment it left the printer, and it must say the same
        #: thing every time the same payload is rendered.
        self.now = now
        self.width = width
        self.height = self.HEAD_H + self.ROW_H * len(rows)

    def wrap(self, *_args):
        return self.width, self.height

    def _x(self, t: datetime) -> float:
        total = (self.end - self.start).total_seconds() or 1
        frac = min(1.0, max(0.0, (t - self.start).total_seconds() / total))
        return self.NAME_W + frac * (self.width - self.NAME_W)

    def draw(self):
        c = self.canv
        top = self.height
        grid_left, grid_right = self.NAME_W, self.width

        # ---- vertical rules: light every half hour, firm on the hour, with the label above
        c.setFont("Helvetica", 6.5)
        t = self.start
        while t <= self.end:
            x = self._x(t)
            on_hour = t.minute == 0
            c.setStrokeColor(_RULE if on_hour else colors.HexColor("#e7eaef"))
            c.setLineWidth(0.7 if on_hour else 0.3)
            c.line(x, 0, x, top - self.HEAD_H)
            if on_hour:
                # midnight carries the DATE, like the screen — on a multi-day sheet the hour alone
                # never said which night, and a dashed rule marks the day boundary
                midnight = t.hour == 0
                if midnight and t > self.start:
                    c.setStrokeColor(_RULE)
                    c.setLineWidth(0.7)
                    c.setDash(2, 2)
                    c.line(x, 0, x, top - self.HEAD_H)
                    c.setDash()
                c.setFillColor(_DIM)
                c.setFont("Helvetica-Bold" if midnight else "Helvetica", 6.5)
                label = t.strftime("%a %d.%m.") if midnight else t.strftime("%H:%M")
                # nudge the outermost labels inside the frame — centred on the very first/last
                # rule they are sliced in half by the grid border
                lx = min(max(x, grid_left + 9 * mm), grid_right - 9 * mm)
                c.drawCentredString(lx, top - self.HEAD_H + 2 * mm, label)
                c.setFont("Helvetica", 6.5)
            t += timedelta(minutes=SLOT_MIN)

        # ---- one lane per person
        c.setFont("Helvetica", 8.5)
        for i, row in enumerate(self.rows):
            y = top - self.HEAD_H - self.ROW_H * (i + 1)
            c.setStrokeColor(_RULE)
            c.setLineWidth(0.4)
            c.line(0, y, grid_right, y)

            label = f"{row.rank} {row.name}".strip() if row.rank else row.name
            c.setFillColor(_INK)
            c.drawString(1.5 * mm, y + self.ROW_H / 2 - 2.6, label[:34])

            for b in row.blocks:
                end = b.end or self.end
                if end <= self.start or b.start >= self.end:
                    continue
                x0, x1 = self._x(b.start), self._x(end)
                if x1 - x0 < 0.6:
                    x1 = x0 + 0.6
                if b.confirmed:
                    c.setFillColor(_ACCENT)
                    c.rect(x0, y + 2.0 * mm, x1 - x0, self.ROW_H - 4.0 * mm, stroke=0, fill=1)
                else:
                    # hollow: offered, not yet assigned
                    c.setStrokeColor(_ACCENT)
                    c.setFillColor(colors.white)
                    c.setLineWidth(0.8)
                    c.rect(x0, y + 1.6 * mm, x1 - x0, self.ROW_H - 3.2 * mm, stroke=1, fill=0)

            # ---- what actually happened, as a heavy rule along the foot of the lane.
            # Under the plan rather than mixed into it, and in ink rather than in the plan's
            # accent, so the sheet still reads plan-first at a glance while the comparison the
            # relief actually makes — «was this covered or not?» — is one glance down the row.
            # An open block (nobody has left yet) runs to the edge of the window like on screen.
            for b in row.actual:
                end = b.end or min(self.end, self.now)
                if end <= self.start or b.start >= self.end:
                    continue
                x0, x1 = self._x(b.start), self._x(end)
                if x1 - x0 < 0.6:
                    x1 = x0 + 0.6
                c.setFillColor(_INK)
                c.rect(x0, y + 0.9 * mm, x1 - x0, 0.9 * mm, stroke=0, fill=1)

        # ---- frame + the head/name separators
        c.setStrokeColor(_RULE)
        c.setLineWidth(0.7)
        c.rect(0, 0, grid_right, top, stroke=1, fill=0)
        c.line(0, top - self.HEAD_H, grid_right, top - self.HEAD_H)
        c.line(grid_left, 0, grid_left, top - self.HEAD_H)

        # the sheet's own «Wer / Zeit» corner, as on the printed form
        c.setFont("Helvetica-Bold", 7.5)
        c.setFillColor(_DIM)
        c.drawString(1.5 * mm, top - self.HEAD_H + 2 * mm, "WER")


def compose_zeitplan_pdf(payload: ZeitplanPayload) -> bytes:
    """One landscape sheet with the Wer × Zeit grid, ready to hang up."""
    st = _styles()
    buf = io.BytesIO()
    lw, lh = landscape(A4)
    margin = 12 * mm
    doc = BaseDocTemplate(
        buf,
        pagesize=landscape(A4),
        leftMargin=margin,
        rightMargin=margin,
        topMargin=margin,
        bottomMargin=margin,
        title=f"Zeitplan — {payload.incidentTitle}",
        author="KP Front",
    )
    frame = Frame(margin, margin, lw - 2 * margin, lh - 2 * margin, id="z", leftPadding=0, rightPadding=0)
    doc.addPageTemplates([PageTemplate(id="zeitplan", frames=[frame], pagesize=landscape(A4))])
    inner_w = lw - 2 * margin

    start, end = _window(payload)
    printed = payload.printedAt or datetime.now(TZ)
    subtitle = " · ".join(
        x
        for x in (
            payload.incidentAddress,
            f"Einsatzbeginn {payload.startedAt.strftime('%d.%m.%Y %H:%M')}" if payload.startedAt else None,
            f"gedruckt {printed.strftime('%d.%m.%Y %H:%M')}",
        )
        if x
    )

    story: list = [
        Paragraph("ZEITPLAN", st["title"]),
        Paragraph(_esc(payload.incidentTitle), st["eyebrow"]),
        Paragraph(_esc(subtitle), st["muted"]),
        Spacer(1, 4 * mm),
    ]

    # a page each, so a big Mannschaft prints as several sheets instead of one unreadable one;
    # every sheet is padded out to full height, because a Führungsformular is meant to be written
    # on and an empty lane is where the pen goes
    rows = payload.rows or []
    pages = [rows[i : i + MAX_ROWS] for i in range(0, max(len(rows), 1), MAX_ROWS)] or [[]]
    for i, page_rows in enumerate(pages):
        if i:
            story.append(PageBreak())
        padded = list(page_rows) + [ZeitplanRow(name="") for _ in range(MAX_ROWS - len(page_rows))]
        story.append(_Grid(padded, start, end, inner_w, printed))

    story.append(Spacer(1, 3 * mm))
    story.append(
        Paragraph(
            "Ausgezogen = verfügbar · ausgefüllt = eingeteilt · schmaler Balken unten = "
            "tatsächlich anwesend. Planungshilfe – massgebend bleibt der Einsatzrapport.",
            st["muted"],
        )
    )

    doc.build(story, canvasmaker=_NumberedCanvas)
    return buf.getvalue()

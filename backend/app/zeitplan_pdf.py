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
import math
from datetime import datetime, timedelta
from typing import Literal
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
#: how far BACK the axis reaches from the print time — enough to see the watch that is ending.
#: Mirrors ``LOOKBACK_HOURS`` on the screen.
LOOKBACK_H = 2
#: hard ceiling on the axis. Four days is already 1.4mm per hour on a landscape A4; a week of
#: Elementarereignis on one sheet is a grey smear, not a Führungsformular. Mirrors the screen's
#: ``MAX_SPAN_HOURS``.
MAX_SPAN_H = 96
#: German weekday abbreviations, indexed by ``date.weekday()``. NOT ``strftime("%a")``: that reads
#: the process locale, which on a server is «C» — so a multi-day sheet in a German app came out of
#: the printer saying «Wed 29.07.». A three-letter table cannot be misconfigured.
WEEKDAYS = ("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So")

#: an hour label needs about this much room before its neighbour crowds it (a «07:00» at 6.5pt is
#: ~9mm wide). Mirrors ``LABEL_PX`` on the screen, in the unit paper is measured in.
LABEL_MM = 13

_INK = colors.HexColor("#1b2330")
_DIM = colors.HexColor("#8a94a3")
_RULE = colors.HexColor("#c9cfd8")
_ACCENT = colors.HexColor("#1f6feb")


class ZeitplanBlock(BaseModel):
    """One planned bar: availability offered (hollow) or, once ``confirmed``, assigned (solid)."""

    start: datetime = Field(alias="from")
    end: datetime | None = Field(default=None, alias="to")
    confirmed: bool = False
    #: the Schichtband this block was entered into, when it was entered into one at all. Only the
    #: «Schichtplan» sheet reads it; this sheet prints every block regardless, which is the whole
    #: reason it is the one that exists without bands.
    band_id: str | None = Field(default=None, alias="bandId")

    model_config = {"populate_by_name": True}

    @field_validator("start", "end")
    @classmethod
    def _to_local(cls, v: datetime | None) -> datetime | None:
        return _local(v)


class ZeitplanBand(BaseModel):
    """One named window — a column of the «Schichtplan» sheet."""

    id: str
    label: str = ""
    start: datetime = Field(alias="from")
    end: datetime = Field(alias="to")

    model_config = {"populate_by_name": True}

    @field_validator("start", "end")
    @classmethod
    def _to_local(cls, v: datetime) -> datetime:
        return _local(v)  # type: ignore[return-value]


class ZeitplanRow(BaseModel):
    name: str
    rank: str | None = None
    blocks: list[ZeitplanBlock] = []
    #: what actually HAPPENED — the recorded attendance for this person, drawn as a thin rule
    #: along the foot of the lane. Defaulted to empty so an older client that never sends the
    #: field still renders a valid (plan-only) sheet.
    actual: list[ZeitplanBlock] = []


class ZeitplanPayload(BaseModel):
    #: which of the two sheets to compose — «Verfügbarkeiten» (this module) or «Schichtplan»
    #: (schichtplan_pdf). They answer different questions, so the surface asks which one rather
    #: than guessing; the endpoint simply dispatches. Defaulted for a client from before the
    #: split, which only ever meant this one.
    sheet: Literal["verfuegbarkeiten", "schichtplan"] = "verfuegbarkeiten"
    incidentTitle: str
    incidentAddress: str | None = None
    startedAt: datetime | None = None
    printedAt: datetime | None = None
    #: the named windows, in the grid's own order. Empty on the availability sheet.
    bands: list[ZeitplanBand] = []
    rows: list[ZeitplanRow] = []

    @field_validator("startedAt", "printedAt")
    @classmethod
    def _to_local(cls, v: datetime | None) -> datetime | None:
        return _local(v)


def _window(payload: ZeitplanPayload) -> tuple[datetime, datetime]:
    """The stretch of time the axis covers — and, just as importantly, the stretch it REFUSES.

    Anchored the way the on-screen axis is (``shifts.timelineSpan``): near the print time, not at
    the incident start. On day eight of an Elementarereignis those are a week apart, and a sheet
    that began at the alarm spent seven-eighths of its width on a past nobody is planning any more
    — while the hours that matter were squeezed into the last centimetre. A YOUNG incident still
    starts at its own beginning, because that is nearer than the look-back.

    Then it is CAPPED. Without a ceiling one long deployment put 192 hours on one landscape sheet:
    384 half-hour rules 0.7mm apart (a solid grey band) under 192 hour labels printed on top of one
    another. The axis now stops at ``MAX_SPAN_H`` and the sheet says so in its footnote rather than
    pretending to show a week.
    """
    # both halves count: a sheet whose axis stopped at the last PLANNED block would cut the
    # attendance that ran past it, which is exactly the overrun worth seeing
    stamps = [b.start for r in payload.rows for b in (*r.blocks, *r.actual)]
    stamps += [b.end for r in payload.rows for b in (*r.blocks, *r.actual) if b.end]
    printed = payload.printedAt or datetime.now(TZ)
    began = payload.startedAt or (min(stamps) if stamps else printed)
    anchor = max(began, printed - timedelta(hours=LOOKBACK_H))
    start = anchor.replace(minute=0, second=0, microsecond=0)
    end = start + timedelta(hours=DEFAULT_WINDOW_H)
    for s in stamps:
        if s > end:
            end = s
    # round the tail up to a full hour so the last column is a whole one
    if end.minute or end.second:
        end = end.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    return start, min(end, start + timedelta(hours=MAX_SPAN_H))


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

        # ---- vertical rules and their labels, THINNED to the room they actually have.
        # How often a rule or a label appears is decided by millimetres per hour, never by the
        # clock: at 12h an hour gets 22mm and every half hour can have its own hairline, at 96h it
        # gets 2.8mm and even hourly rules would merge into a grey band. Drawing all of them anyway
        # is how one long deployment produced 384 rules 0.7mm apart under 192 labels printed on top
        # of one another. Same reasoning as the screen's `hours` memo, in the unit paper uses.
        hours = max(1.0, (self.end - self.start).total_seconds() / 3600)
        mm_per_hour = (self.width - self.NAME_W) / hours / mm
        label_step = max(1, math.ceil(LABEL_MM / mm_per_hour)) if mm_per_hour > 0 else 24
        # a rule per label at the very least; finer where there is room for it
        rule_min = 1 if mm_per_hour >= 3 else label_step
        half_hours = mm_per_hour >= 12

        # Which hours get a LABEL is settled before anything is drawn, because it is a question
        # about neighbours: a label is only placeable if the one before it left room. Deciding that
        # inside the drawing loop is how «23:00» and «Mi 29.07.» came out overprinted as
        # «23:0Mo0d 29.07.», and how a clamped edge label landed on top of the next hour.
        labels: list[tuple[datetime, float, bool]] = []  # (t, x already clamped, midnight)
        t = self.start
        while t <= self.end:
            midnight = t.hour == 0
            if midnight or t.hour % label_step == 0:
                # nudge the outermost labels inside the frame — centred on the very first/last
                # rule they are sliced in half by the grid border
                lx = min(max(self._x(t), grid_left + 9 * mm), grid_right - 9 * mm)
                # MIDNIGHT WINS a collision: it carries the date, and on a multi-day sheet losing
                # which night this is costs more than losing one «23:00».
                while labels and lx - labels[-1][1] < LABEL_MM * mm:
                    if not midnight:
                        break
                    labels.pop()
                else:
                    labels.append((t, lx, midnight))
            t += timedelta(hours=1)
        label_x = {lt: lx for lt, lx, _ in labels}

        c.setFont("Helvetica", 6.5)
        t = self.start
        while t <= self.end:
            on_hour = t.minute == 0
            if not on_hour and not half_hours:
                t += timedelta(minutes=SLOT_MIN)
                continue
            x = self._x(t)
            midnight = on_hour and t.hour == 0
            if not on_hour or t in label_x or t.hour % rule_min == 0:
                c.setStrokeColor(_RULE if on_hour else colors.HexColor("#e7eaef"))
                c.setLineWidth(0.7 if on_hour else 0.3)
                c.line(x, 0, x, top - self.HEAD_H)
            if midnight and t > self.start:
                # the day boundary, dashed — it separates, it does not compete with the bars
                c.setStrokeColor(_RULE)
                c.setLineWidth(0.7)
                c.setDash(2, 2)
                c.line(x, 0, x, top - self.HEAD_H)
                c.setDash()
            if on_hour and t in label_x:
                c.setFillColor(_DIM)
                c.setFont("Helvetica-Bold" if midnight else "Helvetica", 6.5)
                label = f"{WEEKDAYS[t.weekday()]} {t.strftime('%d.%m.')}" if midnight else t.strftime("%H:%M")
                c.drawCentredString(label_x[t], top - self.HEAD_H + 2 * mm, label)
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
        title=f"Verfügbarkeiten — {payload.incidentTitle}",
        author="KP Front",
    )
    frame = Frame(margin, margin, lw - 2 * margin, lh - 2 * margin, id="z", leftPadding=0, rightPadding=0)
    doc.addPageTemplates([PageTemplate(id="zeitplan", frames=[frame], pagesize=landscape(A4))])
    inner_w = lw - 2 * margin

    start, end = _window(payload)
    printed = payload.printedAt or datetime.now(TZ)
    # The axis is anchored near the print time and capped (see _window), so on a long deployment
    # it does NOT begin at the alarm. The heading has to say which stretch is on the paper, or the
    # sheet quietly implies it shows the whole Einsatz.
    span_label = f"{start.strftime('%d.%m. %H:%M')} – {end.strftime('%d.%m. %H:%M')}"
    subtitle = " · ".join(
        x
        for x in (
            payload.incidentAddress,
            f"Einsatzbeginn {payload.startedAt.strftime('%d.%m.%Y %H:%M')}" if payload.startedAt else None,
            f"gedruckt {printed.strftime('%d.%m.%Y %H:%M')}",
            f"Zeitraum {span_label}",
        )
        if x
    )

    story: list = [
        # «VERFÜGBARKEITEN», not «ZEITPLAN»: the paper menu offers the two sheets by name, and a
        # page headed differently from the entry that produced it is the first thing that makes
        # somebody wonder whether they printed the wrong one.
        Paragraph("VERFÜGBARKEITEN", st["title"]),
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

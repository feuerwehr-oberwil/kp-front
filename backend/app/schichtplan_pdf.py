"""Führungsformular «Schichtplan» — the watches across the top, the names down the side.

The SECOND of the two sheets the Schichtenplanung produces, and deliberately its own composer
rather than a flag inside :mod:`zeitplan_pdf`. The two answer different questions and therefore
have different shapes:

* «Verfügbarkeiten» (:mod:`zeitplan_pdf`) is a Wer × Zeit grid over CONTINUOUS time — every
  block anybody offered, band or no band, drawn where it actually falls. It is the only sheet on
  which a freihändig 09–14 appears at all, and it exists with or without bands.
* «Schichtplan» (this module) is a Wer × Schicht table over DISCRETE time — one column per named
  window, a tick in between. It is the BGV/KKO form the crew knows, and it is meaningless
  without bands, so the surface only offers it once one exists.

A table, not a hand-drawn canvas: with the time axis gone the columns are fixed, so the thing the
Zeitplan's grid had to draw by hand (bars starting between column boundaries) cannot occur here.

A cell whose shift has drifted off its band's hours prints that shift's REAL time instead of a
tick — the same thing the on-screen cell shows, so paper and tablet read alike. Empty cells stay
empty: a Führungsformular is written on when the battery dies, and an empty cell is where the pen
goes.
"""

from __future__ import annotations

import io
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import BaseDocTemplate, Frame, PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle

from .report_pdf import _esc, _NumberedCanvas, _styles
from .zeitplan_pdf import TZ, ZeitplanBand, ZeitplanBlock, ZeitplanPayload, ZeitplanRow

#: rows per sheet — as many names as fit UNDER the heading and ABOVE the Deckung line at a height
#: you can still write in. Measured, not guessed: 297mm less the margins, the title block and the
#: footnote leaves ~218mm for names at 7.4mm a row.
MAX_ROWS = 28
#: columns beyond this and the cells stop being writable; the rest go to a second sheet
MAX_BANDS = 8

_INK = colors.HexColor("#1b2330")
_DIM = colors.HexColor("#8a94a3")
_RULE = colors.HexColor("#c9cfd8")
_ACCENT = colors.HexColor("#1f6feb")

#: eingeteilt · verfügbar. Two MARKS rather than two colours: the station printer is monochrome
#: (a colour cartridge is a consumable) and a photocopy of a colour-only distinction says nothing.
#: The heavier mark is the stronger commitment, which is the whole reading of a column.
#:
#: Both are plain ASCII, deliberately. These PDFs use the base-14 Helvetica, whose encoding is
#: WinAnsi — the ✚/○ of the drawing have no glyph there and would print as blank boxes on the one
#: sheet that has to survive the battery dying. A lowercase «o» IS that hollow circle in Helvetica,
#: at a size you can read across a Kommandoposten; a bullet at 10pt is a speck.
_MARK_CONFIRMED = "X"
_MARK_AVAILABLE = "o"


def _hhmm(dt: datetime) -> str:
    return dt.strftime("%H:%M")


def _range(a: datetime, b: datetime) -> str:
    """«07:00–12:00» — always the full clock on both ends, as on the screen. The bare hour read
    fine until one end carried minutes and the other did not: «20:30–21» is two notations in one
    range, and on paper there is nobody to ask."""
    return f"{_hhmm(a)}–{_hhmm(b)}"


def _band_title(b: ZeitplanBand) -> str:
    """What a column is called. The label is optional on the surface, so a band nobody named
    prints as its own hours rather than as a blank heading."""
    return b.label.strip() or _range(b.start, b.end)


def _cover_fraction(block_start: datetime, block_end: datetime | None, band: ZeitplanBand) -> float:
    """How much of a band one block covers, as 0..1 of the BAND's length.

    Mirrors ``bandCoverFraction`` in the frontend, on purpose: the Deckung line on paper must say
    the same number the column head on the tablet says, or the sheet and the screen argue.
    """
    length = (band.end - band.start).total_seconds()
    if length <= 0 or block_end is None or block_end <= block_start:
        return 0.0
    overlap = (min(block_end, band.end) - max(block_start, band.start)).total_seconds()
    return min(1.0, max(0.0, overlap) / length)


def _fmt_count(n: float) -> str:
    """«8», «7,6» — one decimal only where the pro-rata counting produced one."""
    r = round(n, 1)
    return str(int(r)) if r == int(r) else f"{r:.1f}".replace(".", ",")


def _cell_block(row: ZeitplanRow, band: ZeitplanBand) -> tuple[ZeitplanBlock | None, bool]:
    """The block one cell is about, and whether it is a stored MEMBER of this band.

    Mirrors ``bandCell`` in the frontend, and for the same reason the screen has it: **availability
    is a fact about time, assignment is a decision.** Somebody who drew 10:00–20:00 on the axis is
    available for a 12:00–17:00 watch whether or not anybody has filed them under it, so the sheet
    says so. Being ASSIGNED is only ever what somebody stored (``bandId`` + ``confirmed``).

    A stored member always wins the cell; failing that, the offer covering most of the window does.
    """
    for b in row.blocks:
        # …but only while it still TOUCHES the window. A member can end up wholly outside its own
        # band (the band was re-timed and nobody was dragged along, or the bar was moved on the
        # axis), and it then printed hours contradicting the column heading above them — «20:30–21»
        # inside a 12–17 watch, counted as one assigned person covering none of it.
        if b.band_id == band.id and _cover_fraction(b.start, b.end, band) > 0:
            return b, True
    # failing that: an assignment outranks an availability, and only then the wider overlap wins
    best: ZeitplanBlock | None = None
    best_key = (0, 0.0)
    for b in row.blocks:
        cover = _cover_fraction(b.start, b.end, band)
        if cover <= 0:
            continue
        key = (1 if b.confirmed else 0, cover)
        if best is None or key > best_key:
            best, best_key = b, key
    return best, False


def _cell(row: ZeitplanRow, band: ZeitplanBand) -> str:
    """What one cell prints: a mark where the window is wholly covered, otherwise the hours —
    CLAMPED to this column, exactly as on the screen. «05–08» in a watch that ends at 06:00 is
    05–06 as far as this column is concerned; the full stretch belongs on «Verfügbarkeiten»."""
    block, member = _cell_block(row, band)
    if block is None:
        return ""
    exact = member and block.end is not None and block.start == band.start and block.end == band.end
    if not exact and _cover_fraction(block.start, block.end, band) < 1:
        start = max(block.start, band.start)
        end = min(block.end or band.end, band.end)
        # every cell overlaps its band by construction (_cell_block drops one that no longer
        # does), so there is always a slice; the fallback is for unreadable stamps only
        return _range(start, end) if end > start else _range(block.start, block.end or band.end)
    # `confirmed` is the SHIFT's own state, read wherever the shift lies: somebody geplant
    # 10:00–20:00 is geplant for every watch those hours reach, filed under one or not
    return _MARK_CONFIRMED if block.confirmed else _MARK_AVAILABLE


def _is_assigned(row: ZeitplanRow, bands: list[ZeitplanBand]) -> bool:
    """Is this person ON one of these watches? Asked through the cells, so the answer is exactly
    what the sheet would show: somebody geplant 10:00–20:00 is on the 12:00–17:00 watch whether or
    not anybody filed them under it. Merely being available is not, and belongs on the other
    sheet."""
    return any((b := _cell_block(row, band))[0] is not None and b[0].confirmed for band in bands)


def _deckung(rows: list[ZeitplanRow], band: ZeitplanBand) -> str:
    """How many are ON this watch, as WHOLE people. One number, not «verfügbar / eingeteilt»: this
    sheet lists only the people who were assigned, so a second figure counting the available ones
    would point at names that are deliberately not on the page.

    Whole, not pro rata: «0,8» is not a headcount, and this line has to be checkable by counting
    the marks in the column above it — which is the only thing that makes a printed figure
    trustworthy once the tablet is out of battery.

    A «·» is appended when at least one of them does NOT cover the watch end to end: «2» alone
    would say two people are on it, when the first hours may have one."""
    n = 0
    partial = False
    for row in rows:
        block, _member = _cell_block(row, band)
        if block is None or not block.confirmed:
            continue
        n += 1
        if _cover_fraction(block.start, block.end, band) < 1:
            partial = True
    return f"{n}·" if partial else str(n)


def _page(rows: list[ZeitplanRow], bands: list[ZeitplanBand], width: float, with_deckung: bool) -> Table:
    # the hours go on a second line only when the first one is a real NAME — a band nobody named
    # already prints as its own hours, and «12–17 / 12–17» is a column head arguing with itself
    head = ["WER"] + [
        f"{_band_title(b)}\n{_range(b.start, b.end)}" if b.label.strip() else _band_title(b) for b in bands
    ]
    data: list[list[str]] = [head]
    for row in rows:
        label = f"{row.rank} {row.name}".strip() if row.rank else row.name
        data.append([label[:34]] + [_cell(row, b) for b in bands])
    if with_deckung:
        data.append(["EINGETEILT"] + [_deckung(rows, b) for b in bands])

    name_w = 62 * mm
    cell_w = (width - name_w) / max(1, len(bands))
    t = Table(data, colWidths=[name_w] + [cell_w] * len(bands), rowHeights=[11 * mm] + [7.4 * mm] * (len(data) - 1))
    style = [
        ("GRID", (0, 0), (-1, -1), 0.4, _RULE),
        ("BOX", (0, 0), (-1, -1), 0.7, _RULE),
        ("LINEBELOW", (0, 0), (-1, 0), 0.7, _RULE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 7.5),
        ("TEXTCOLOR", (0, 0), (-1, 0), _DIM),
        ("ALIGN", (1, 0), (-1, -1), "CENTER"),
        ("FONT", (0, 1), (0, -1), "Helvetica", 8.5),
        ("TEXTCOLOR", (0, 1), (0, -1), _INK),
        ("LEFTPADDING", (0, 0), (0, -1), 3 * mm),
        # the ticks: bigger than the names, because they are what the sheet is scanned for
        ("FONT", (1, 1), (-1, -1), "Helvetica", 10),
        ("TEXTCOLOR", (1, 1), (-1, -1), _ACCENT),
    ]
    if with_deckung:
        style += [
            ("FONT", (0, -1), (-1, -1), "Helvetica-Bold", 7.5),
            ("TEXTCOLOR", (0, -1), (-1, -1), _DIM),
            ("LINEABOVE", (0, -1), (-1, -1), 0.7, _RULE),
        ]
    t.setStyle(TableStyle(style))
    return t


def compose_schichtplan_pdf(payload: ZeitplanPayload) -> bytes:
    """One portrait A4 per ~34 names, ready to hang up."""
    st = _styles()
    buf = io.BytesIO()
    pw, ph = A4
    margin = 14 * mm
    doc = BaseDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=margin,
        bottomMargin=margin,
        title=f"Schichtplan — {payload.incidentTitle}",
        author="KP Front",
    )
    frame = Frame(margin, margin, pw - 2 * margin, ph - 2 * margin, id="s", leftPadding=0, rightPadding=0)
    doc.addPageTemplates([PageTemplate(id="schichtplan", frames=[frame], pagesize=A4)])
    inner_w = pw - 2 * margin

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

    bands = payload.bands[:MAX_BANDS]
    # ONLY the people who were actually assigned. This is the sheet that goes on the wall to say who
    # is on which watch; somebody merely available is not an answer to that question, and sixty
    # names with two ticks between them is a sheet nobody reads. Everyone's times — assigned or not
    # — are on «Verfügbarkeiten», which exists for exactly that.
    assigned = [r for r in (payload.rows or []) if _is_assigned(r, bands)]
    # …unless NOBODY is assigned yet. Then this is a blank form somebody is about to fill in by
    # hand, and a blank form still needs its names: an empty page helps no one.
    rows = assigned or (payload.rows or [])
    # the sheet says whose names are on it, so «where is everybody else» has an answer on the page
    footnote_scope = (
        "Aufgeführt sind nur eingeteilte Personen; alle Zeiten stehen auf dem Blatt «Verfügbarkeiten»."
        if assigned
        else "Noch niemand eingeteilt – die ganze Mannschaft steht zum Ausfüllen von Hand."
    )
    story: list = [
        Paragraph("SCHICHTPLAN", st["title"]),
        Paragraph(_esc(payload.incidentTitle), st["eyebrow"]),
        Paragraph(_esc(subtitle), st["muted"]),
        Spacer(1, 4 * mm),
    ]

    if not bands:
        # cannot happen from the surface (the menu withholds this sheet without bands) but a
        # payload can always be posted directly, and an empty table is not an answer
        story.append(Paragraph("Keine Schichten definiert.", st["muted"]))
        doc.build(story, canvasmaker=_NumberedCanvas)
        return buf.getvalue()

    # a page per ~28 names, every one padded out to full height: the sheet is meant to be written
    # on, and an empty row is where the pen goes
    pages = [rows[i : i + MAX_ROWS] for i in range(0, max(len(rows), 1), MAX_ROWS)] or [[]]
    for i, page_rows in enumerate(pages):
        if i:
            story.append(PageBreak())
        padded = list(page_rows) + [ZeitplanRow(name="") for _ in range(MAX_ROWS - len(page_rows))]
        # the Deckung line counts the WHOLE crew, not the names on this sheet — a per-page total
        # would say something true about the page and false about the Einsatz
        story.append(_page(padded, bands, inner_w, with_deckung=(i == len(pages) - 1)))
        if i == len(pages) - 1:
            story.append(Spacer(1, 3 * mm))
            story.append(
                Paragraph(
                    f"{_MARK_CONFIRMED} eingeteilt · {_MARK_AVAILABLE} verfügbar · eine Uhrzeit = "
                    "deckt die Schicht nur teilweise · leere Zellen zum Nachtragen von Hand. "
                    f"{footnote_scope} Planungshilfe – massgebend bleibt der Einsatzrapport.",
                    ParagraphStyle("schichtfoot", parent=st["muted"], leading=9),
                )
            )

    doc.build(story, canvasmaker=_NumberedCanvas)
    return buf.getvalue()

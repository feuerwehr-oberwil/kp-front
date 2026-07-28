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


def _short(dt: datetime) -> str:
    """«07» on the hour, «07:30» otherwise — a column head has room for one line."""
    return dt.strftime("%H") if dt.minute == 0 else _hhmm(dt)


def _range(a: datetime, b: datetime) -> str:
    return f"{_short(a)}–{_short(b)}"


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
        if b.band_id == band.id:
            return b, True
    best: ZeitplanBlock | None = None
    best_cover = 0.0
    for b in row.blocks:
        cover = _cover_fraction(b.start, b.end, band)
        if cover > best_cover:
            best, best_cover = b, cover
    return best, False


def _cell(row: ZeitplanRow, band: ZeitplanBand) -> str:
    """What one cell prints: a mark where the window is wholly covered, the person's REAL hours
    where it is only partly covered — «verfügbar» there would promise time nobody offered."""
    block, member = _cell_block(row, band)
    if block is None:
        return ""
    exact = member and block.end is not None and block.start == band.start and block.end == band.end
    if not exact and _cover_fraction(block.start, block.end, band) < 1:
        return _range(block.start, block.end or band.end)
    # assignment is never derived — an offer filed under another band is still only an offer here
    return _MARK_CONFIRMED if (member and block.confirmed) else _MARK_AVAILABLE


def _deckung(rows: list[ZeitplanRow], band: ZeitplanBand) -> str:
    """«8 / 5» — verfügbar over eingeteilt, counted per PERSON (one cell is one count, exactly as on
    the screen) with partial cover pro rata."""
    available = 0.0
    confirmed = 0.0
    for row in rows:
        block, member = _cell_block(row, band)
        if block is None:
            continue
        f = _cover_fraction(block.start, block.end, band)
        if member and block.confirmed:
            confirmed += f
        else:
            available += f
    return f"{_fmt_count(available)} / {_fmt_count(confirmed)}"


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
        data.append(["DECKUNG"] + [_deckung(rows, b) for b in bands])

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
    rows = payload.rows or []
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

    # a page per ~34 names, every one padded out to full height: the sheet is meant to be written
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
                    "in der Schicht, hält sie aber nicht ein · leere Zellen zum Nachtragen von Hand. "
                    "Wer eigene Zeiten ausserhalb jeder Schicht hat, steht auf dem Blatt "
                    "«Verfügbarkeiten». Planungshilfe – massgebend bleibt der Einsatzrapport.",
                    ParagraphStyle("schichtfoot", parent=st["muted"], leading=9),
                )
            )

    doc.build(story, canvasmaker=_NumberedCanvas)
    return buf.getvalue()

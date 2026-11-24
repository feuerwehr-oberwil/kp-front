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
import math
from datetime import datetime, timedelta

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import BaseDocTemplate, Frame, PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle

from .report.styles import _esc, _logo_flowable, _NumberedCanvas, _styles
from .zeitplan_pdf import TZ, ZeitplanBand, ZeitplanPayload, ZeitplanRow, wall

#: rows per sheet — as many names as fit UNDER the heading and ABOVE the Deckung line at a height
#: you can still write in. Measured, not guessed: 297mm less the margins, the title block and the
#: footnote leaves ~218mm for names at 7.4mm a row.
MAX_ROWS = 28
#: columns beyond this and the cells stop being writable; the rest go to a second sheet
MAX_BANDS = 8

_INK = colors.HexColor("#1b2330")
_DIM = colors.HexColor("#8a94a3")
_RULE = colors.HexColor("#c9cfd8")

#: eingeteilt · verfügbar. Two MARKS rather than two colours: the station printer is monochrome
#: (a colour cartridge is a consumable) and a photocopy of a colour-only distinction says nothing.
#: The heavier mark is the stronger commitment, which is the whole reading of a column. Printed in
#: plain ink (_INK), not an accent — there was never a second colour to tell apart, only the two
#: marks, so the ink stayed the only ink this sheet needed.
#:
#: Both are plain ASCII, deliberately. These PDFs use the base-14 Helvetica, whose encoding is
#: WinAnsi — the ✚/○ of the drawing have no glyph there and would print as blank boxes on the one
#: sheet that has to survive the battery dying. A lowercase «o» IS that hollow circle in Helvetica,
#: at a size you can read across a Kommandoposten; a bullet at 10pt is a speck.
_MARK_CONFIRMED = "X"
_MARK_AVAILABLE = "o"


def _hhmm(dt: datetime) -> str:
    """«07:00»; in the hour the autumn change shows twice, with its zone – «02:15 MESZ» /
    «02:15 MEZ» – or a watch across the change reads «02:15–02:15»."""
    naive = dt.replace(tzinfo=None)
    twice = naive.replace(tzinfo=TZ, fold=0).utcoffset() != naive.replace(tzinfo=TZ, fold=1).utcoffset()
    if not twice or dt.tzinfo is None:
        return dt.strftime("%H:%M")
    return dt.strftime("%H:%M") + (" MESZ" if dt.utcoffset() == timedelta(hours=2) else " MEZ")


def _range(a: datetime, b: datetime) -> str:
    """«07:00–12:00» — always the full clock on both ends, as on the screen. The bare hour read
    fine until one end carried minutes and the other did not: «20:30–21» is two notations in one
    range, and on paper there is nobody to ask.

    A band that crosses midnight says which day it lands on: «22:00–06:00» is the shape a night
    shift has, and on a wall sheet whose whole purpose is a multi-day rota there is nothing else
    to read it against. Same treatment the Zeitplan axis already gives its midnight tick."""
    if a.date() == b.date():
        return f"{_hhmm(a)}–{_hhmm(b)}"
    return f"{_hhmm(a)}–{b.strftime('%d.%m.')} {_hhmm(b)}"


def _band_title(b: ZeitplanBand) -> str:
    """What a column is called. The label is optional on the surface, so a band nobody named
    prints as its own hours rather than as a blank heading."""
    return b.label.strip() or _range(b.start, b.end)


def _band_chunks(bands: list[ZeitplanBand]) -> list[list[ZeitplanBand]]:
    """The bands split into the column groups one sheet can hold, in order.

    The exact counterpart of the row pagination: a sheet too wide gets continued on the next
    page rather than cut off. It used to be cut off — ``bands[:MAX_BANDS]`` — and because the
    same truncated list also decided WHO is printed, somebody whose only watch was a ninth band
    fell off the roster entirely, not just off the right-hand edge.

    Never empty when there are bands; an empty list stays empty (the caller says so in words).
    """
    return [bands[i : i + MAX_BANDS] for i in range(0, len(bands), MAX_BANDS)]


def _fmt_count(n: float) -> str:
    """«8», «7,6» — one decimal only where the pro-rata counting produced one."""
    r = round(n, 1)
    return str(int(r)) if r == int(r) else f"{r:.1f}".replace(".", ",")


Segment = tuple[datetime, datetime, bool]  # (from, to, confirmed), clamped to one band


def _merge(spans: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    out: list[tuple[datetime, datetime]] = []
    for a, b in sorted(spans):
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def _subtract(
    spans: list[tuple[datetime, datetime]], cut: list[tuple[datetime, datetime]]
) -> list[tuple[datetime, datetime]]:
    out: list[tuple[datetime, datetime]] = []
    for a, b in spans:
        pieces = [(a, b)]
        for c0, c1 in cut:
            pieces = [p for x0, x1 in pieces for p in ((x0, min(x1, c0)), (max(x0, c1), x1)) if p[1] > p[0]]
        out.extend(pieces)
    return out


def _segments(row: ZeitplanRow, band: ZeitplanBand) -> list[Segment]:
    """How this person's time lies across one band, in time order – the paper twin of
    ``bandCellSegments`` on the tablet (src/lib/shifts.ts), so the sheet shows what the screen
    shows (hunt 24.11.2026, simplification F8: two assigned stretches in one watch printed as
    the later one only). Assigned wins wherever it reaches; what is left of the offers fills the
    gaps; whatever neither covers is the hole. Availability is a fact about time, so an offer
    counts whether or not anybody filed it under this band. A block with no end covers nothing."""
    confirmed: list[tuple[datetime, datetime]] = []
    offered: list[tuple[datetime, datetime]] = []
    for b in row.blocks:
        if b.end is None:
            continue
        a, z = max(b.start, band.start), min(b.end, band.end)
        if z > a:
            (confirmed if b.confirmed else offered).append((a, z))
    conf = _merge(confirmed)
    segs = [(a, z, True) for a, z in conf] + [(a, z, False) for a, z in _subtract(_merge(offered), conf)]
    return sorted(segs)


def _assigned_share(row: ZeitplanRow, band: ZeitplanBand) -> float:
    """How much of the band this person is ASSIGNED for, 0..1 (all assigned stretches together)."""
    length = (band.end - band.start).total_seconds()
    if length <= 0:
        return 0.0
    return min(1.0, sum((z - a).total_seconds() for a, z, c in _segments(row, band) if c) / length)


def _cell(row: ZeitplanRow, band: ZeitplanBand) -> str:
    """What one cell prints, one line per stretch: a mark where one stretch covers the whole
    window, otherwise each stretch's hours CLAMPED to this column, exactly as on the screen – an
    offer marked « o» behind its hours. «05–08» in a watch that ends at 06:00 is 05–06 as far as
    this column is concerned; the full stretch belongs on «Verfügbarkeiten»."""
    segs = _segments(row, band)
    if len(segs) == 1 and segs[0][0] == band.start and segs[0][1] == band.end:
        return _MARK_CONFIRMED if segs[0][2] else _MARK_AVAILABLE
    return "\n".join(_range(a, z) + ("" if c else f" {_MARK_AVAILABLE}") for a, z, c in segs)


def _is_assigned(row: ZeitplanRow, bands: list[ZeitplanBand]) -> bool:
    """Is this person ON one of these watches? Asked through the cells, so the answer is exactly
    what the sheet would show: somebody geplant 10:00–20:00 is on the 12:00–17:00 watch whether or
    not anybody filed them under it. Merely being available is not, and belongs on the other
    sheet."""
    return any(_assigned_share(row, band) > 0 for band in bands)


def _deckung(rows: list[ZeitplanRow], band: ZeitplanBand) -> str:
    """How many are ON this watch, as WHOLE people. One number, not «verfügbar / eingeteilt»: this
    sheet lists only the people who were assigned, so a second figure counting the available ones
    would point at names that are deliberately not on the page.

    Whole, not pro rata: «0,8» is not a headcount, and this line has to be checkable by counting
    the marks in the column above it — which is the only thing that makes a printed figure
    trustworthy once the tablet is out of battery. Two stretches of one person are one person.

    A «·» is appended when at least one of them does NOT cover the watch end to end: «2» alone
    would say two people are on it, when the first hours may have one."""
    shares = [x for x in (_assigned_share(row, band) for row in rows) if x > 0]
    return f"{len(shares)}·" if any(x < 1 for x in shares) else str(len(shares))


#: a row is 7.4mm – one «slot». A cell with several stretches sets them at 6.5pt on 7.5pt lines
#: and its row grows by whole slots (_slots), so nothing overprints the row below.
ROW_MM = 7.4
STACK_PT, STACK_LEAD = 6.5, 7.5
CELL_PAD_PT = 6  # Table's default 3pt top + 3pt bottom


def _slots(row: ZeitplanRow, bands: list[ZeitplanBand]) -> int:
    """How many 7.4mm slots this person's row needs, over EVERY band – so the row has the same
    height and the same page on each sheet of columns."""
    lines = max((_cell(row, b).count("\n") + 1 for b in bands), default=1)
    return 1 if lines == 1 else max(1, math.ceil((lines * STACK_LEAD + CELL_PAD_PT) / (ROW_MM * mm)))


def _pages(rows: list[ZeitplanRow], bands: list[ZeitplanBand]) -> list[list[ZeitplanRow]]:
    """The names dealt onto sheets of MAX_ROWS slots each – a tall row takes more than one."""
    pages: list[list[ZeitplanRow]] = [[]]
    used = 0
    for row in rows:
        need = min(_slots(row, bands), MAX_ROWS)
        if used + need > MAX_ROWS and pages[-1]:
            pages.append([])
            used = 0
        pages[-1].append(row)
        used += need
    return pages


def _page(
    rows: list[ZeitplanRow],
    bands: list[ZeitplanBand],
    width: float,
    with_deckung: bool,
    deckung_rows: list[ZeitplanRow] | None = None,
    all_bands: list[ZeitplanBand] | None = None,
) -> Table:
    """One sheet: the ``bands`` columns against the ``rows`` names, padded rows and all.

    ``deckung_rows`` is who the EINGETEILT line counts — the whole crew, not the names that
    happen to be on this page, because a per-page total says something true about the page and
    false about the Einsatz. Defaults to the printed rows, which is the same thing on a sheet
    that fits on one page.
    """
    # the hours go on a second line only when the first one is a real NAME — a band nobody named
    # already prints as its own hours, and «12–17 / 12–17» is a column head arguing with itself
    head = ["WER"] + [
        f"{_band_title(b)}\n{_range(b.start, b.end)}" if b.label.strip() else _band_title(b) for b in bands
    ]
    data: list[list[str]] = [head]
    #: cells with more than one stretch, set smaller (see _slots)
    stacked: list[tuple[int, int]] = []
    heights = [11 * mm]
    for r, row in enumerate(rows, start=1):
        label = f"{row.rank} {row.name}".strip() if row.rank else row.name
        cells = [_cell(row, b) for b in bands]
        stacked += [(c, r) for c, text in enumerate(cells, start=1) if "\n" in text]
        data.append([label[:34], *cells])
        heights.append(_slots(row, all_bands or bands) * ROW_MM * mm)
    if with_deckung:
        counted = rows if deckung_rows is None else deckung_rows
        data.append(["EINGETEILT"] + [_deckung(counted, b) for b in bands])

    name_w = 62 * mm
    cell_w = (width - name_w) / max(1, len(bands))
    heights += [ROW_MM * mm] * (len(data) - len(heights))  # the EINGETEILT line
    t = Table(data, colWidths=[name_w] + [cell_w] * len(bands), rowHeights=heights)
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
        ("TEXTCOLOR", (1, 1), (-1, -1), _INK),
    ]
    for c, r in stacked:
        style.append(("FONT", (c, r), (c, r), "Helvetica", STACK_PT, STACK_LEAD))
    if with_deckung:
        style += [
            ("FONT", (0, -1), (-1, -1), "Helvetica-Bold", 7.5),
            ("TEXTCOLOR", (0, -1), (-1, -1), _DIM),
            ("LINEABOVE", (0, -1), (-1, -1), 0.7, _RULE),
        ]
    t.setStyle(TableStyle(style))
    return t


def compose_schichtplan_pdf(payload: ZeitplanPayload, logo: bytes | None = None) -> bytes:
    """One portrait A4 per 28 names × 8 Schichten, ready to hang up.

    Both axes paginate, and neither truncates: more names continue on the next page, more watches
    continue on the next set of pages — with the same roster on each, so the sheets read together.

    ``logo`` is the station's already-resolved letterhead mark (see
    ``api/report.py::_resolve_logo``) — this module never reaches into the deployment config
    itself. Missing or unreadable, exactly like the rapport, simply prints no logo.
    """
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

    printed = payload.printedAt or wall(datetime.now(TZ))
    subtitle = " · ".join(
        x
        for x in (
            payload.incidentAddress,
            f"Einsatzbeginn {payload.startedAt.strftime('%d.%m.%Y %H:%M')}" if payload.startedAt else None,
            f"gedruckt {printed.strftime('%d.%m.%Y %H:%M')}",
        )
        if x
    )

    # ALL of them — who is printed is decided against every watch there is, and the columns are
    # then dealt out over as many sheets as they need (see _band_chunks). Deciding it against a
    # truncated list once meant a ninth-band person was dropped from the roster, not just from
    # the columns that did not fit.
    bands = list(payload.bands or [])
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
        else "Noch niemand eingeteilt. Verfügbarkeiten sind als Zeiten dargestellt; "
        "die Einteilung kann von Hand ergänzt werden."
    )
    title_block = [
        Paragraph("SCHICHTPLAN", st["title"]),
        Paragraph(_esc(payload.incidentTitle), st["eyebrow"]),
        Paragraph(_esc(subtitle), st["muted"]),
    ]
    # Same letterhead shape as the rapport: mark and title on one line, modest — a Führungsformular
    # stays a working sheet, not a cover page.
    story: list
    logo_img = _logo_flowable(logo)
    if logo_img is None:
        story = [*title_block, Spacer(1, 4 * mm)]
    else:
        lw = logo_img.drawWidth + 5 * mm
        head_tbl = Table([[logo_img, title_block]], colWidths=[lw, inner_w - lw])
        head_tbl.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                    ("TOPPADDING", (0, 0), (-1, -1), 0),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                ]
            )
        )
        story = [head_tbl, Spacer(1, 4 * mm)]

    if not bands:
        # cannot happen from the surface (the menu withholds this sheet without bands) but a
        # payload can always be posted directly, and an empty table is not an answer
        story.append(Paragraph("Keine Schichten definiert.", st["muted"]))
        doc.build(story, canvasmaker=_NumberedCanvas)
        return buf.getvalue()

    # a page per ~28 names, every one padded out to full height: the sheet is meant to be written
    # on, and an empty row is where the pen goes
    pages = _pages(rows, bands)
    # …and a sheet per 8 watches, the same way round: too many columns continue on the next sheet
    # instead of falling off the edge. EVERY chunk carries the SAME names — the roster was chosen
    # against all the bands — so a person's row is on each sheet even where their columns are
    # empty, which is what makes the sheets cross-readable side by side on the wall.
    chunks = _band_chunks(bands)
    started = False
    for c, chunk in enumerate(chunks):
        for i, page_rows in enumerate(pages):
            if started:
                story.append(PageBreak())
            started = True
            free = MAX_ROWS - sum(min(_slots(r, bands), MAX_ROWS) for r in page_rows)
            padded = list(page_rows) + [ZeitplanRow(name="") for _ in range(max(0, free))]
            last = i == len(pages) - 1
            # the Deckung line counts the WHOLE crew, not the names on this sheet — a per-page
            # total would say something true about the page and false about the Einsatz. It sits
            # under the last names of EVERY chunk, because it is a figure per column.
            story.append(_page(padded, chunk, inner_w, with_deckung=last, deckung_rows=rows, all_bands=bands))
            if not last:
                continue
            first_no = c * MAX_BANDS + 1
            # which watches these columns are, once there is more than one sheet of them
            chunk_scope = (
                f"Schichten {first_no}–{first_no + len(chunk) - 1} von {len(bands)}; "
                "die übrigen stehen auf den weiteren Blättern. "
                if len(chunks) > 1
                else ""
            )
            story.append(Spacer(1, 3 * mm))
            story.append(
                Paragraph(
                    f"{_MARK_CONFIRMED} eingeteilt · {_MARK_AVAILABLE} verfügbar · eine Uhrzeit = "
                    "deckt die Schicht nur teilweise · leere Zellen zum Nachtragen von Hand. "
                    f"{chunk_scope}{footnote_scope} Planungshilfe – massgebend bleibt der Einsatzrapport.",
                    ParagraphStyle("schichtfoot", parent=st["muted"], leading=9),
                )
            )

    doc.build(story, canvasmaker=_NumberedCanvas)
    return buf.getvalue()

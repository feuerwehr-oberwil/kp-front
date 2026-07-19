#!/usr/bin/env python3
"""Generate the synthetic Schloss Musterdorf object-plan module PDFs.

The diagrams are intentionally fictional but useful enough to demonstrate KP Front's
module rail, PDF viewer, and multi-page floor-plan flow. Markers use the app's OWN
tactical-symbol pack (public/tactical-symbols.json, rasterised with the backend's resvg
wrapper) so the demo plans speak the same symbol language as the Lage/Plan surfaces.
Keep the output deterministic so regenerating the plans only changes Git when the
drawing instructions change.

Run from the repository root (uses the backend's reportlab + resvg dependencies):

    cd backend && uv run python ../examples/demo-data/gen_plans.py
"""

import sys
from pathlib import Path

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "backend"))
from app.kroki import SymbolPack  # noqa: E402  (needs the backend on sys.path first)

OBJECT = "Schloss Musterdorf"
ADDRESS = "Schlossgasse 9, 4104 Musterdorf"

RED = HexColor("#c4161c")
INK = HexColor("#172033")
MUTED = HexColor("#657087")
LINE = HexColor("#aeb7c7")
PAPER = HexColor("#f5f7fa")
ROAD = HexColor("#d8dde6")
BLUE = HexColor("#1769aa")
GREEN = HexColor("#277a4b")

PACK = SymbolPack(ROOT / "public" / "tactical-symbols.json")
GLYPH_PX = 256  # raster resolution per glyph (crisp at the ~10 mm print size)


def glyph(c: canvas.Canvas, name: str, x: float, y: float, size: float = 10 * mm) -> None:
    """Draw a pack symbol centred on (x, y) at `size` (points). White chip behind the
    glyph keeps line-art legible on coloured ground — same trick as the app's map chip."""
    img = PACK.raster(name, GLYPH_PX)
    if img is None:
        raise SystemExit(f"unknown symbol {name!r} — check public/tactical-symbols.json")
    c.setFillColor(white)
    c.setStrokeColor(LINE)
    c.setLineWidth(0.6)
    c.roundRect(x - size / 2 - 1 * mm, y - size / 2 - 1 * mm, size + 2 * mm, size + 2 * mm, 1.5 * mm, fill=1, stroke=1)
    c.drawImage(ImageReader(img), x - size / 2, y - size / 2, size, size, mask="auto")


def new_canvas(path: Path, pagesize=A4) -> canvas.Canvas:
    path.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(path), pagesize=pagesize, pageCompression=1, invariant=1)
    c.setTitle(f"{OBJECT} - synthetischer Demo-Objektplan")
    c.setAuthor("KP Front Demo")
    c.setSubject("Vollständig synthetische Demonstrationsdaten")
    return c


def header(c: canvas.Canvas, w: float, h: float, module: str, title: str) -> float:
    c.setFillColor(RED)
    c.rect(0, h - 25 * mm, w, 25 * mm, fill=1, stroke=0)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(13 * mm, h - 11 * mm, OBJECT)
    c.setFont("Helvetica-Bold", 11)
    c.drawRightString(w - 13 * mm, h - 10 * mm, module)
    c.setFont("Helvetica", 9)
    c.drawRightString(w - 13 * mm, h - 16 * mm, title)
    c.setFillColor(INK)
    c.setFont("Helvetica", 8.5)
    c.drawString(13 * mm, h - 31 * mm, ADDRESS)
    c.setFillColor(MUTED)
    c.drawRightString(w - 13 * mm, h - 31 * mm, "DEMO - synthetisch, keine echten Objektdaten")
    c.setStrokeColor(LINE)
    c.line(13 * mm, h - 34 * mm, w - 13 * mm, h - 34 * mm)
    return h - 40 * mm


def footer(c: canvas.Canvas, w: float, page: str) -> None:
    c.setStrokeColor(LINE)
    c.line(13 * mm, 12 * mm, w - 13 * mm, 12 * mm)
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 7.5)
    c.drawString(13 * mm, 7 * mm, "Demo-Objektplan - alle Inhalte frei erfunden")
    c.drawRightString(w - 13 * mm, 7 * mm, page)


def box_label(c: canvas.Canvas, x: float, y: float, text: str, color=INK) -> None:
    tw = c.stringWidth(text, "Helvetica-Bold", 7.5)
    c.setFillColor(white)
    c.setStrokeColor(color)
    c.roundRect(x, y, tw + 6 * mm, 7 * mm, 2 * mm, fill=1, stroke=1)
    c.setFillColor(color)
    c.setFont("Helvetica-Bold", 7.5)
    c.drawString(x + 3 * mm, y + 2.3 * mm, text)


def legend(c: canvas.Canvas, x: float, y: float, w: float, items: list[tuple[str, str]], cols: int = 1, title: str = "LEGENDE") -> None:
    """Symbol legend card — glyph + name per entry (recognition over recall, on paper too)."""
    row_h = 9 * mm
    rows = -(-len(items) // cols)
    h = 9 * mm + rows * row_h
    col_w = (w - 8 * mm) / cols
    c.setFillColor(white)
    c.setStrokeColor(LINE)
    c.roundRect(x, y, w, h, 2 * mm, fill=1, stroke=1)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(x + 4 * mm, y + h - 6.5 * mm, title)
    for i, (name, label) in enumerate(items):
        cx = x + 4 * mm + (i % cols) * col_w
        cy = y + h - 13.5 * mm - (i // cols) * row_h
        glyph(c, name, cx + 4.5 * mm, cy, 7 * mm)
        c.setFillColor(INK)
        c.setFont("Helvetica", 7.5)
        c.drawString(cx + 11 * mm, cy - 1.1 * mm, label)


def arrow(c: canvas.Canvas, x1: float, y1: float, x2: float, y2: float, color=BLUE, width=3) -> None:
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(width)
    c.line(x1, y1, x2, y2)
    dx, dy = x2 - x1, y2 - y1
    length = max((dx * dx + dy * dy) ** 0.5, 1)
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    size = 4 * mm
    c.line(x2, y2, x2 - ux * size + px * size / 2, y2 - uy * size + py * size / 2)
    c.line(x2, y2, x2 - ux * size - px * size / 2, y2 - uy * size - py * size / 2)


def north_arrow(c: canvas.Canvas, x: float, y: float) -> None:
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 9)
    c.drawCentredString(x, y + 13 * mm, "N")
    c.setStrokeColor(INK)
    c.setLineWidth(1.5)
    c.line(x, y, x, y + 11 * mm)
    c.setFillColor(INK)
    c.wedge(x - 2 * mm, y + 8 * mm, x + 2 * mm, y + 13 * mm, 0, 180, fill=1, stroke=0)


def building(c: canvas.Canvas, x: float, y: float, w: float, h: float, label: str = "SCHLOSS") -> None:
    c.setFillColor(PAPER)
    c.setStrokeColor(INK)
    c.setLineWidth(1.5)
    c.rect(x, y, w, h, fill=1, stroke=1)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(x + w / 2, y + h / 2 + 2 * mm, label)
    c.setFont("Helvetica", 7.5)
    c.drawCentredString(x + w / 2, y + h / 2 - 3 * mm, "EG + 2 OG")


def draw_modul1(path: Path) -> None:
    w, h = A4
    c = new_canvas(path)
    top = header(c, w, h, "MODUL 1", "Übersicht")

    x0, y0 = 17 * mm, 31 * mm
    dw, dh = w - 34 * mm, top - y0 - 3 * mm
    c.setFillColor(HexColor("#eef3ea"))
    c.setStrokeColor(LINE)
    c.rect(x0, y0, dw, dh, fill=1, stroke=1)

    c.setFillColor(ROAD)
    c.rect(x0, y0, 25 * mm, dh, fill=1, stroke=0)
    c.rect(x0, y0, dw, 22 * mm, fill=1, stroke=0)
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 8)
    c.saveState()
    c.translate(x0 + 11 * mm, y0 + dh / 2)
    c.rotate(90)
    c.drawCentredString(0, 0, "SCHLOSSGASSE")
    c.restoreState()

    bx, by, bw, bh = x0 + 58 * mm, y0 + 91 * mm, 76 * mm, 56 * mm
    building(c, bx, by, bw, bh)
    c.setStrokeColor(GREEN)
    c.setDash(4, 3)
    c.roundRect(bx - 9 * mm, by - 9 * mm, bw + 18 * mm, bh + 18 * mm, 4 * mm, fill=0, stroke=1)
    c.setDash()
    box_label(c, bx + 21 * mm, by + bh + 11 * mm, "OBJEKTGRENZE", GREEN)

    arrow(c, x0 + 12 * mm, y0 + 14 * mm, bx + 7 * mm, by + 8 * mm)
    box_label(c, x0 + 28 * mm, y0 + 37 * mm, "ZUFAHRT FEUERWEHR", BLUE)

    # markers straight from the app's symbol pack — the demo plan speaks Kroki.
    # No text pills: the legend names them (recognition over recall on paper too).
    glyph(c, "SI Ueberflurhydrant", x0 + 14 * mm, y0 + 68 * mm)
    glyph(c, "VKF KP Front", x0 + 38 * mm, y0 + 11 * mm)
    glyph(c, "VKF Sammelstelle", bx + bw + 15 * mm, by + 18 * mm)
    glyph(c, "GB Schluesseldepot", bx - 12 * mm, by + bh - 8 * mm)

    north_arrow(c, x0 + dw - 14 * mm, y0 + dh - 27 * mm)

    # bottom-right stack: legend, then the hints card above it with a clear gap
    lx, lw = x0 + dw - 62 * mm, 54 * mm
    legend(c, lx, y0 + 5 * mm, lw, [
        ("SI Ueberflurhydrant", "Überflurhydrant"),
        ("VKF KP Front", "KP Front"),
        ("VKF Sammelstelle", "Sammelstelle"),
        ("GB Schluesseldepot", "Schlüsseldepot"),
    ])
    hints_y = y0 + 57 * mm
    c.setFillColor(white)
    c.setStrokeColor(LINE)
    c.roundRect(lx, hints_y, lw, 27 * mm, 2 * mm, fill=1, stroke=1)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(lx + 4 * mm, hints_y + 20 * mm, "EINSATZHINWEISE")
    c.setFont("Helvetica", 7.5)
    for i, text in enumerate(("- Zufahrt nur via Schlossgasse", "- Innenhof für ADL freihalten", "- Hydrant H-17: DN 150")):
        c.drawString(lx + 4 * mm, hints_y + (13 - i * 5) * mm, text)

    footer(c, w, "Modul 1 / 1")
    c.showPage()
    c.save()


def draw_modul23(path: Path) -> None:
    w, h = landscape(A4)
    c = new_canvas(path, pagesize=landscape(A4))
    top = header(c, w, h, "MODUL 2/3", "Zugang und Objekt")

    margin, gap = 13 * mm, 7 * mm
    panel_y, panel_h = 25 * mm, top - 27 * mm
    left_w = 91 * mm
    right_x = margin + left_w + gap
    right_w = w - right_x - margin

    for x, pw, title in ((margin, left_w, "ANFAHRT UND ZUGANG"), (right_x, right_w, "ERDGESCHOSS - ÜBERSICHT")):
        c.setFillColor(PAPER)
        c.setStrokeColor(LINE)
        c.roundRect(x, panel_y, pw, panel_h, 2 * mm, fill=1, stroke=1)
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 9)
        c.drawString(x + 5 * mm, panel_y + panel_h - 8 * mm, title)

    # Access panel.
    c.setFillColor(ROAD)
    c.rect(margin + 7 * mm, panel_y + 9 * mm, 19 * mm, panel_h - 25 * mm, fill=1, stroke=0)
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 7)
    c.saveState()
    c.translate(margin + 15 * mm, panel_y + panel_h / 2)
    c.rotate(90)
    c.drawCentredString(0, 0, "SCHLOSSGASSE")
    c.restoreState()
    building(c, margin + 48 * mm, panel_y + 42 * mm, 32 * mm, 42 * mm, "OBJEKT")
    arrow(c, margin + 17 * mm, panel_y + 20 * mm, margin + 50 * mm, panel_y + 47 * mm)
    box_label(c, margin + 31 * mm, panel_y + 12 * mm, "HAUPTZUGANG", BLUE)
    glyph(c, "VKF Drehleiter", margin + 44 * mm, panel_y + 100 * mm, 12 * mm)
    glyph(c, "SI Ueberflurhydrant", margin + 33 * mm, panel_y + 27 * mm, 9 * mm)
    north_arrow(c, margin + left_w - 11 * mm, panel_y + panel_h - 28 * mm)

    # Object panel — the floor sketch sits above the legend strip. Each room carries one
    # centred symbol (no text pills — the legend names them); the room name rides the box top.
    fx, fy = right_x + 10 * mm, panel_y + 46 * mm
    fw, fh = right_w - 20 * mm, panel_h - 62 * mm
    c.setFillColor(white)
    c.setStrokeColor(INK)
    c.setLineWidth(1.4)
    c.rect(fx, fy, fw, fh, fill=1, stroke=1)
    c.line(fx + fw * 0.34, fy, fx + fw * 0.34, fy + fh)
    c.line(fx + fw * 0.70, fy, fx + fw * 0.70, fy + fh)
    c.line(fx + fw * 0.34, fy + fh * 0.48, fx + fw, fy + fh * 0.48)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 8)
    for rx, ry, text in (
        (0.17, 0.90, "FOYER"), (0.52, 0.90, "SAAL"), (0.85, 0.74, "KÜCHE"),
        (0.52, 0.40, "TECHNIK"), (0.85, 0.40, "LAGER"),
    ):
        c.drawCentredString(fx + fw * rx, fy + fh * ry, text)

    # door at the FOYER wall (marker only, no label)
    c.setFillColor(BLUE)
    c.rect(fx - 1.5 * mm, fy + fh * 0.10, 3 * mm, 13 * mm, fill=1, stroke=0)

    # one symbol centred per room box
    glyph(c, "GB Treppe 8", fx + fw * 0.17, fy + fh * 0.50, 12 * mm)          # FOYER
    glyph(c, "GB Brandmeldezentrale", fx + fw * 0.52, fy + fh * 0.72, 12 * mm)  # SAAL
    glyph(c, "GB Elektrotableau", fx + fw * 0.52, fy + fh * 0.22, 11 * mm)     # TECHNIK
    glyph(c, "SI Schieber", fx + fw * 0.85, fy + fh * 0.22, 11 * mm)          # LAGER

    legend(c, fx, panel_y + 5 * mm, fw, [
        ("SI Ueberflurhydrant", "Überflurhydrant"),
        ("GB Brandmeldezentrale", "Brandmeldezentrale (BMA)"),
        ("VKF Drehleiter", "ADL-Stellfläche"),
        ("GB Elektrotableau", "Elektrotableau"),
        ("GB Treppe 8", "Treppenhaus"),
        ("SI Schieber", "Gas-Absperrung"),
    ], cols=2)

    footer(c, w, "Modul 2/3 / 1")
    c.showPage()
    c.save()


def floor_plan(c: canvas.Canvas, w: float, h: float, floor: str, page_no: int, ground: bool = False) -> None:
    top = header(c, w, h, "MODUL 6", f"Gebäudepläne - {floor}")
    x, y = 27 * mm, 31 * mm
    fw, fh = w - 54 * mm, top - y - 4 * mm
    c.setFillColor(white)
    c.setStrokeColor(INK)
    c.setLineWidth(1.6)
    c.rect(x, y, fw, fh, fill=1, stroke=1)
    c.setFillColor(PAPER)
    c.rect(x + fw * 0.32, y, fw * 0.36, fh, fill=1, stroke=0)
    c.setStrokeColor(INK)
    c.rect(x, y, fw, fh, fill=0, stroke=1)
    c.line(x + fw * 0.32, y, x + fw * 0.32, y + fh)
    c.line(x + fw * 0.68, y, x + fw * 0.68, y + fh)
    c.line(x, y + fh * 0.51, x + fw, y + fh * 0.51)

    # Room names ride the top of each box so the centred symbol stays clear.
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 8)
    for name, rx, ry in (
        ("RAUM A", 0.16, 0.93), ("RAUM B", 0.84, 0.93),
        ("RAUM C", 0.16, 0.44), ("RAUM D", 0.84, 0.44),
    ):
        c.drawCentredString(x + fw * rx, y + fh * ry, name)

    # One symbol centred per box — no tread lines, no text pills; the symbols speak.
    glyph(c, "GB Treppe 8", x + fw * 0.50, y + fh * 0.755, 12 * mm)       # stair core (top-middle)
    glyph(c, "VKF Innenhydrant", x + fw * 0.50, y + fh * 0.255, 10 * mm)  # corridor (bottom-middle)

    # exit at the building edge (marker only)
    c.setFillColor(BLUE)
    c.rect(x + fw / 2 - 6 * mm, y - 1.5 * mm, 12 * mm, 3 * mm, fill=1, stroke=0)

    if ground:
        glyph(c, "GB Brandmeldezentrale", x + fw * 0.16, y + fh * 0.755, 11 * mm)  # RAUM A
        glyph(c, "GB Elektrotableau", x + fw * 0.16, y + fh * 0.255, 11 * mm)      # RAUM C

    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(x, top + 1 * mm, floor)
    north_arrow(c, x + fw + 11 * mm, y + fh - 22 * mm)
    footer(c, w, f"Modul 6 / {page_no} von 3")
    c.showPage()


def draw_modul6(path: Path) -> None:
    w, h = A4
    c = new_canvas(path)
    floor_plan(c, w, h, "ERDGESCHOSS", 1, ground=True)
    floor_plan(c, w, h, "1. OBERGESCHOSS", 2)
    floor_plan(c, w, h, "2. OBERGESCHOSS", 3)
    c.save()


def main() -> int:
    plans = [
        (HERE / "plans/schloss-musterdorf/modul1.pdf", draw_modul1),
        (HERE / "plans/schloss-musterdorf/modul2-3.pdf", draw_modul23),
        (HERE / "plans/schloss-musterdorf/modul6.pdf", draw_modul6),
    ]
    for path, draw in plans:
        draw(path)
    print(f"OK: wrote {len(plans)} synthetic plan PDF(s) under {HERE / 'plans/schloss-musterdorf'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

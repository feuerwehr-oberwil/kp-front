"""Erzeugt `sample-modul6.pdf` – ein A3-Musterblatt mit den drei Marker-Typen.

Aufruf aus dem Repo-Wurzelverzeichnis:

    uv run --project backend python docs/plan-markers/make-sample.py

Das Blatt ist bewusst simpel (zwei schematische Grundrisse, EG und 1OG, nebeneinander),
aber es trägt jede Regel aus `README.md`:

* eine Geschoss-Marke pro Grundriss, beide exakt auf derselben Treppenhaus-Ecke;
* Eck-Marken um beide Grundrisse, weil zwei Zeichnungen auf einer Seite liegen;
* zwei `§GEO`-Marken auf dem EG, weit auseinander, massstabsgerecht zu «1:500».

Alle Tags sind echter Text in 3.5 pt – prüfbar mit `pdftotext -bbox-layout`.
"""

from __future__ import annotations

from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

BLUE = HexColor("#1f6feb")
INK = HexColor("#333333")
TAG_PT = 3.5  # Schriftgrösse der Tags in Punkt – winzig, aber extrahierbar

PAGE_W, PAGE_H = 420 * mm, 297 * mm  # A3 quer
DRAW_W, DRAW_H = 160 * mm, 210 * mm  # Kasten pro Grundriss
SCALE = 500  # gedruckter Massstab 1:500 – 1 mm Papier = 0.5 m Gelände

# Ursprung (links unten) der beiden Grundrisse und die Geländekoordinaten der
# beiden vermassten Punkte auf dem EG. 140 mm / 180 mm Papierabstand → 70 m / 90 m.
FLOORS = [("EG", 20 * mm, 40 * mm), ("1OG", 230 * mm, 40 * mm)]
GEO_A = (30 * mm, 55 * mm, 2612345.6, 1264321.2)
GEO_B = (170 * mm, 235 * mm, 2612415.6, 1264411.2)


def tag(c: canvas.Canvas, x: float, y: float, text: str, anchor: str = "middle") -> None:
    """Setzt einen Tag so, dass die MITTE seines Textkastens auf (x, y) liegt.

    Der Parser liest genau diese Mitte – darum wird die Grundlinie um eine halbe
    x-Höhe nach unten versetzt statt den Text einfach auf die Grundlinie zu stellen.
    """
    c.setFillColor(BLUE)
    c.setFont("Helvetica", TAG_PT)
    baseline = y - 0.35 * TAG_PT
    {"middle": c.drawCentredString, "start": c.drawString, "end": c.drawRightString}[anchor](x, baseline, text)


def ring(c: canvas.Canvas, x: float, y: float, gap: bool = False) -> None:
    """Zielkreuz im Ring um den Punkt – die Zierde von storey.svg / geo.svg.

    ``gap`` öffnet den Ring waagrecht, damit ein breiter Tag (`§GEO …`) frei durchläuft.
    """
    c.setStrokeColor(BLUE)
    c.setLineWidth(0.2 * mm)
    r = 2.6 * mm
    if gap:
        for start in (16, 196):
            c.arc(x - r, y - r, x + r, y + r, start, 148)
    else:
        c.circle(x, y, r)
    ticks = ((0, 1), (0, -1)) if gap else ((0, 1), (0, -1), (1, 0), (-1, 0))
    for dx, dy in ticks:
        c.line(x + dx * 3.5 * mm, y + dy * 3.5 * mm, x + dx * 2.7 * mm, y + dy * 2.7 * mm)


def storey_mark(c: canvas.Canvas, x: float, y: float, label: str) -> None:
    """Geschoss-Marke auf dem Treppenhaus; die Textmitte ist der Verbindungspunkt."""
    ring(c, x, y)
    tag(c, x, y, f"§{label}")


def corner_mark(c: canvas.Canvas, x: float, y: float, text: str, top_left: bool) -> None:
    """Eck-Marke; die Textmitte sitzt exakt auf der Bereichsecke (x, y).

    Die Schenkel lassen dem Tag den Platz frei – die Ecke ist der Schnittpunkt ihrer
    Verlängerungen, also die Textmitte.
    """
    c.setStrokeColor(BLUE)
    c.setLineWidth(0.2 * mm)
    sx, sy = (1, -1) if top_left else (-1, 1)
    c.line(x + sx * 1.9 * mm, y, x + sx * 3.7 * mm, y)
    c.line(x, y + sy * 0.9 * mm, x, y + sy * 3.7 * mm)
    tag(c, x, y, text)


def geo_mark(c: canvas.Canvas, x: float, y: float, east: float, north: float) -> None:
    """Koordinaten-Marke; die Textmitte liegt auf dem vermassten Punkt."""
    ring(c, x, y, gap=True)
    tag(c, x, y, f"§GEO {east:.1f} {north:.1f}")


def floor_plan(c: canvas.Canvas, ox: float, oy: float, label: str) -> tuple[float, float]:
    """Schematischer Grundriss; gibt die Treppenhaus-Mitte zurück (auf jedem Geschoss gleich)."""
    c.setStrokeColor(INK)
    c.setLineWidth(0.6 * mm)
    c.rect(ox, oy, DRAW_W, DRAW_H, stroke=1, fill=0)
    c.setLineWidth(0.3 * mm)
    c.line(ox, oy + 120 * mm, ox + DRAW_W, oy + 120 * mm)
    c.line(ox + 60 * mm, oy + 120 * mm, ox + 60 * mm, oy + DRAW_H)
    c.line(ox + 110 * mm, oy, ox + 110 * mm, oy + 120 * mm)
    stair = (ox + 65 * mm, oy + 90 * mm, 30 * mm, 40 * mm)
    c.rect(*stair, stroke=1, fill=0)
    for i in range(1, 8):
        c.line(stair[0], stair[1] + i * 5 * mm, stair[0] + 30 * mm, stair[1] + i * 5 * mm)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 28)
    c.drawString(ox + 4 * mm, oy + DRAW_H + 6 * mm, label)
    return stair[0] + 15 * mm, stair[1] + 20 * mm


def main() -> None:
    out = Path(__file__).with_name("sample-modul6.pdf")
    c = canvas.Canvas(str(out), pagesize=(PAGE_W, PAGE_H))
    c.setTitle("Modul 6 – Marker-Musterblatt")

    for label, ox, oy in FLOORS:
        cx, cy = floor_plan(c, ox, oy, label)
        storey_mark(c, cx, cy, label)
        corner_mark(c, ox - 8 * mm, oy + DRAW_H + 14 * mm, f"§[{label}", top_left=True)
        corner_mark(c, ox + DRAW_W + 8 * mm, oy - 14 * mm, f"§{label}]", top_left=False)

    for gx, gy, east, north in (GEO_A, GEO_B):
        geo_mark(c, gx, gy, east, north)

    c.setFillColor(INK)
    c.setFont("Helvetica", 11)
    c.drawString(20 * mm, 18 * mm, f"Musterblatt Marker – Modul 6 – Massstab 1:{SCALE} – A3 quer")
    c.setFont("Helvetica", 8)
    c.drawString(20 * mm, 12 * mm, "Erzeugt von docs/plan-markers/make-sample.py – kein echtes Objekt.")

    c.showPage()
    c.save()
    print(f"geschrieben: {out}")


if __name__ == "__main__":
    main()

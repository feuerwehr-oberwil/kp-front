#!/usr/bin/env python3
"""Generate the KP-Front-authored tactical symbol pack.

Own artwork following the Swiss FKS Faltkarte sign conventions — geometric primitives
(circles, polylines, letters), NOT the FireGIS path data (their circles are 48-segment
arc chains; ours are real <circle> elements). Names/categories stay verbatim so the pack
is a drop-in for public/firegis-symbols.json.

Contract: origin-centered viewBox, unit radius ≈ 1, no width/height,
colors baked (#000000 = glyph, first non-black = accent for symColor()), outline-only
symbols carry the literal fill="none" (needsWhite() chip), letters use
dominant-baseline="central" (the loader rewrites it for Safari).

Usage:
  python3 tools/gen_symbols.py emit     # (re)write public/tactical-symbols.json — the shipped pack
  python3 tools/gen_symbols.py review   # tools/symbols-review.html (vs. the FireGIS pack when present)
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# --- palette (matches the conventions the crews learned) -----------------------------
BLACK = "#000000"
BLUE = "#00a0ff"      # persons / zones / Führung outline blue
VBLUE = "#006dff"     # vehicle outline blue
ORANGE = "#ff8000"
RED = "#ff0000"
YELLOW = "#ffff00"
GREEN = "#008040"
WATER = "#0000ff"
GREY = "#6b7280"      # Rauch (smoke)


# --- tiny SVG builder -----------------------------------------------------------------
def fnum(v: float) -> str:
    s = f"{v:.2f}"
    return s.rstrip("0").rstrip(".") if "." in s else s


def path(pts, stroke=BLACK, sw=0.06, fill="none", close=False, cap=None) -> str:
    d = "M " + " L ".join(f"{fnum(x)} {fnum(y)}" for x, y in pts) + (" Z" if close else "")
    capattr = f' stroke-linecap="{cap}"' if cap else ""
    return (f'<path d="{d}" fill="{fill}" stroke="{stroke}" '
            f'stroke-width="{fnum(sw)}" stroke-linejoin="round"{capattr}/>')


def line(x1, y1, x2, y2, stroke=BLACK, sw=0.06, cap=None) -> str:
    return path([(x1, y1), (x2, y2)], stroke=stroke, sw=sw, cap=cap)


def circle(cx, cy, r, stroke=BLACK, sw=0.06, fill="none") -> str:
    return (f'<circle cx="{fnum(cx)}" cy="{fnum(cy)}" r="{fnum(r)}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="{fnum(sw)}"/>')


def text(t, fs, fill=BLACK, x=0.0, y=0.0) -> str:
    return (f'<text x="{fnum(x)}" y="{fnum(y)}" text-anchor="middle" dominant-baseline="central" '
            f'font-family="Arial,sans-serif" font-weight="bold" font-size="{fnum(fs)}" '
            f'fill="{fill}">{t}</text>')


def svg(elements, vb=2.6, viewbox: str | None = None) -> str:
    box = viewbox or f"{fnum(-vb / 2)} {fnum(-vb / 2)} {fnum(vb)} {fnum(vb)}"
    return (f'<svg viewBox="{box}" xmlns="http://www.w3.org/2000/svg" '
            f'preserveAspectRatio="xMidYMid meet">' + "".join(elements) + "</svg>")


# --- shared sign parts ----------------------------------------------------------------
def vehicle_body(stroke, sw):
    """FKS vehicle: rectangle with a chevron nose at the front (right)."""
    return [
        path([(-1, -0.4), (1, -0.4), (1, 0.4), (-1, 0.4)], stroke=stroke, sw=sw, close=True),
        line(0.46, -0.4, 0.46, 0.4, stroke=stroke, sw=sw),
        path([(0.46, -0.4), (1, 0), (0.46, 0.4)], stroke=stroke, sw=sw),
    ]


def letter_disc(letter, fill):
    """Schadenlage disc: colored circle, black outline, big black letter."""
    return svg([circle(0, 0, 1, stroke=BLACK, sw=0.06, fill=fill), text(letter, 1.5)], vb=2.6)


def smoke(fill=GREY):
    """Rauch: a grey four-lobe smoke puff (the same silhouette as the app's cloud glyph),
    black outline like the other Schadenlage signs; fill-opacity keeps it reading as smoke."""
    d = ("M -0.624 0.624 Q -0.984 0.624 -0.984 0.288 Q -0.984 -0.024 -0.648 0 "
         "Q -0.648 -0.384 -0.24 -0.36 Q -0.024 -0.624 0.288 -0.408 "
         "Q 0.696 -0.456 0.672 -0.048 Q 0.984 0 0.888 0.336 Q 0.792 0.624 0.432 0.624 Z")
    puff = (f'<path d="{d}" fill="{fill}" fill-opacity="0.6" stroke="{BLACK}" '
            f'stroke-width="0.06" stroke-linejoin="round" stroke-linecap="round"/>')
    return svg([puff], vb=2.6)


def zone_circle(label):
    """Bereich: open blue circle with the unit label."""
    return svg([circle(0, 0, 1, stroke=BLUE, sw=0.1), text(label, 0.8, fill=BLUE)], vb=2.6)


def holding_box(letter):
    """Sammelplatz / Warteraum: wide open rectangle with a big letter."""
    return svg(
        [path([(-2, -1.3), (2, -1.3), (2, 1.3), (-2, 1.3)], stroke=BLUE, sw=0.1, close=True),
         text(letter, 2.0, fill=BLUE)],
        viewbox="-2.2 -2.3 4.6 4.6",
    )


def hazard_triangle(extra, viewbox="-1.3 -1.4 2.6 2.6"):
    """Gefahren warning triangle (orange, apex up) with content inside."""
    tri = path([(0, -0.9), (-1, 0.7), (1, 0.7)], stroke=ORANGE, sw=0.1, close=True)
    return svg([tri] + extra, viewbox=viewbox)


def person_post(extra):
    """Personen tall rectangle (Sammelstelle family) with distinguishing content."""
    box = path([(-0.4, -1), (0.4, -1), (0.4, 1), (-0.4, 1)], stroke=BLUE, sw=0.1, close=True)
    return svg([box] + extra, vb=2.6)


def basin(fill_color, sw):
    """Open water basin: filled trapezoid with flaring rim lines (Löschweier family)."""
    return [
        path([(-0.55, 0.6), (-0.75, 0.25), (0.75, 0.25), (0.55, 0.6)],
             stroke=fill_color, sw=sw, fill=fill_color, close=True),
        line(0.75, 0.25, 1.1, -0.35, stroke=fill_color, sw=sw),
        line(-0.75, 0.25, -1.1, -0.35, stroke=fill_color, sw=sw),
    ]


# --- the pack -------------------------------------------------------------------------
# (cat, name, svg) — names verbatim from the current pack (compatibility keys).
def build() -> list[dict]:
    syms: list[tuple[str, str, str]] = []
    add = lambda cat, name, s: syms.append((cat, name, s))  # noqa: E731

    # ── Schadenlage
    add("Schadenlage", "VKF Feuer", letter_disc("F", RED))
    add("Schadenlage", "VKF Rauch", smoke())
    add("Schadenlage", "VKF Rettungen", letter_disc("R", YELLOW))
    add("Schadenlage", "VKF Unfall", letter_disc("U", GREEN))
    add("Schadenlage", "VKF Gefaehrliche Stoffe", letter_disc("C", ORANGE))
    add("Schadenlage", "VKF Wasser", letter_disc("W", WATER))
    add("Schadenlage", "FW Gefahr Ex", hazard_triangle([text("Ex", 0.7, fill=ORANGE, y=0.2)]))

    # damage / Naturereignis signatures (FKS Faltkarte 11/2022: red diagonal-cross lattices —
    # the stroke count per direction encodes severity — and the Überschwemmung ellipse+arrow)
    def lattice(offsets):
        els = []
        for o in offsets:
            els.append(path([(-0.8 + o, -0.8 - o), (0.8 + o, 0.8 - o)], stroke=RED, sw=0.1, cap="round"))
            els.append(path([(0.8 + o, -0.8 - o), (-0.8 + o, 0.8 - o)], stroke=RED, sw=0.1, cap="round"))
        return svg(els, vb=2.6)

    add("Schadenlage", "FW Beschaedigung", lattice([0]))
    add("Schadenlage", "FW Teilzerstoerung", lattice([-0.2, 0.2]))
    add("Schadenlage", "FW Totalzerstoerung", lattice([-0.33, 0, 0.33]))
    add("Schadenlage", "FW Ueberschwemmung", svg(
        [f'<ellipse cx="-0.25" cy="0" rx="0.72" ry="0.42" fill="none" stroke="{RED}" stroke-width="0.12"/>',
         line(0.55, 0, 1.0, 0, stroke=RED, sw=0.1),
         path([(0.95, -0.14), (1.25, 0), (0.95, 0.14)], stroke=RED, sw=0.06, fill=RED, close=True)],
        vb=2.6,
    ))

    # ── Gefahren
    add("Gefahren", "FW Gefahr Tafel", svg(
        [path([(-1.2, -0.7), (1.2, -0.7), (1.2, 0.7), (-1.2, 0.7)], stroke=ORANGE, sw=0.1, close=True),
         line(-1.2, 0, 1.2, 0, stroke=ORANGE, sw=0.1)],
        vb=3.0,
    ))
    add("Gefahren", "FW Gefahr allgemein", hazard_triangle([
        line(0, 0, 0, -0.4, stroke=ORANGE, sw=0.2, cap="round"),  # exclamation bar
        circle(0, 0.35, 0.11, stroke=ORANGE, sw=0.02, fill=ORANGE),  # …and its dot
    ]))
    add("Gefahren", "FW Gefahr G", hazard_triangle([text("G", 0.7, fill=ORANGE, y=0.2)]))
    add("Gefahren", "FW Gefahr C", hazard_triangle([text("C", 0.7, fill=ORANGE, y=0.2)]))
    add("Gefahren", "FW Gefahr Radioaktiv", hazard_triangle([
        circle(0, 0.2, 0.35, stroke=ORANGE, sw=0.06),
        # trefoil: three filled blades around the hub at (0, 0.2)
        path([(0, 0.2), (0.35, 0.2), (0.3, 0.38), (0.17, 0.5)], stroke=ORANGE, sw=0.06, fill=ORANGE, close=True),
        path([(0, 0.2), (-0.17, 0.5), (-0.3, 0.38), (-0.35, 0.2)], stroke=ORANGE, sw=0.06, fill=ORANGE, close=True),
        path([(0, 0.2), (-0.17, -0.1), (0, -0.15), (0.17, -0.1)], stroke=ORANGE, sw=0.06, fill=ORANGE, close=True),
    ]))
    add("Gefahren", "FW Gefahr W", hazard_triangle([
        # spray crown + crossing jets (Wasser-Gefahr / water-reactive)
        path([(-0.2, 0), (-0.1, 0.4), (0, 0.1), (0.1, 0.4), (0.2, 0)], stroke=ORANGE, sw=0.07),
        line(-0.4, 0, 0.4, 0.5, stroke=ORANGE, sw=0.06),
        line(0.4, 0, -0.4, 0.5, stroke=ORANGE, sw=0.06),
    ]))
    add("Gefahren", "FW Elektroanlage", svg(
        [path([(0.7, -1.0), (0, -0.1), (0.7, 0.5), (0.4, 1.1), (0.2, 1.0), (0.3, 1.6),
               (0.8, 1.3), (0.6, 1.2), (1.0, 0.4), (0.4, -0.1), (1.4, -0.9)],
              stroke=ORANGE, sw=0.06, fill=ORANGE, close=True)],
        viewbox="-0.9 -1.3 3.2 3.2",
    ))

    # ── Führung
    add("Führung", "VKF KP Front", svg(
        [circle(0, -0.35, 0.4, stroke=BLUE, sw=0.1),
         text("F", 0.7, fill=BLUE, y=-0.35),
         line(-0.4, -0.35, -0.4, 0.64, stroke=BLUE, sw=0.1),
         circle(-0.4, 0.65, 0.08, stroke=BLUE, sw=0.1)],
        viewbox="-1.08 -1.05 2.08 2.08",
    ))
    add("Führung", "VKF Einsatzleiter", svg(
        # circle sits LOW (centre y=+0.4); the three bars hang off the pole top with clear
        # air above the circle — the "three-bar EL flag" the crews learned. Pole + top bar
        # are ONE polyline so the corner joins flush (no butt-cap notch).
        [circle(0, 0.4, 0.3, stroke=BLUE, sw=0.1),
         path([(0, 0.1), (0, -0.7), (0.4, -0.7)], stroke=BLUE, sw=0.1)]
        + [line(0, y, 0.4, y, stroke=BLUE, sw=0.1) for y in (-0.5, -0.3)],
        viewbox="-0.95 -1.0 2.0 2.0",
    ))
    add("Führung", "FW Offizier", svg(
        # pole + top bar as one polyline → flush corner (see Einsatzleiter)
        [circle(0, 0, 0.4, stroke=BLUE, sw=0.1),
         path([(0, -0.4), (0, -1.4), (0.8, -1.4)], stroke=BLUE, sw=0.1),
         line(0, -1.0, 0.8, -1.0, stroke=BLUE, sw=0.1)],
        viewbox="-1.0 -1.7 2.4 2.4",
    ))
    add("Führung", "FW Sammelplatz", holding_box("S"))
    add("Führung", "FW Warteraum", holding_box("W"))
    add("Führung", "VKF Kontrollposten", person_post([
        # the watch-eye across the post: horizontal lens spanning the full width + oval pupil
        f'<path d="M -0.4 0 A 0.65 0.65 0 0 1 0.4 0 A 0.65 0.65 0 0 1 -0.4 0 Z" fill="none" stroke="{BLUE}" stroke-width="0.07"/>',
        f'<ellipse cx="0" cy="0" rx="0.15" ry="0.1" fill="{BLUE}" stroke="{BLUE}" stroke-width="0.06"/>',
    ]))
    add("Führung", "VKF Informationszentrum", svg(
        [path([(0, -1), (1, 0), (0, 1), (-1, 0)], stroke=BLUE, sw=0.1, close=True),
         text("i", 1.2, fill=BLUE)],
        vb=2.6,
    ))
    add("Führung", "VKF Bereich Materialdepot", zone_circle("M"))
    add("Führung", "FW Absperrung", svg(
        # plain barrier bar with upturned ends — the unbewachte Absperrung
        # (Behelf Schadenplatz); the überwacht variant below adds the watch flags
        [path([(-0.7, 0.2), (-0.5, 0), (0.5, 0), (0.7, 0.2)], stroke=BLUE, sw=0.1)],
        viewbox="-1.1 -0.9 2.2 2.2",
    ))
    add("Führung", "VKF Verkehrssperre ueberwacht", svg(
        # barrier bar with upturned ends, a small watch flag on each
        [path([(-0.7, 0.2), (-0.5, 0), (0.5, 0), (0.7, 0.2)], stroke=BLUE, sw=0.1),
         path([(-0.8, 0.2), (-0.6, 0.2), (-0.7, 0.4)], stroke=BLUE, sw=0.06, close=True),
         path([(0.6, 0.2), (0.8, 0.2), (0.7, 0.4)], stroke=BLUE, sw=0.06, close=True)],
        viewbox="-1.1 -0.9 2.2 2.2",
    ))

    # ── Fahrzeuge / Mittel
    # same blue as the rest of the vehicle family (the FireGIS original used a darker
    # #006dff one-off; unified per corps review 2026-07-02)
    add("Fahrzeuge / Mittel", "VKF Fahrzeug", svg(vehicle_body(BLUE, 0.06), vb=2.6))
    add("Fahrzeuge / Mittel", "VKF Drehleiter", svg(
        vehicle_body(BLUE, 0.1)
        + [line(-1, -0.2, 0.4, -0.2, stroke=BLUE, sw=0.1),
           line(-1, 0.2, 0.4, 0.2, stroke=BLUE, sw=0.1)]
        + [line(x, -0.2, x, 0.2, stroke=BLUE, sw=0.1)
           for x in (-0.9, -0.7, -0.5, -0.3, -0.1, 0.1, 0.3)],
        vb=2.6,
    ))
    # Ladder-only overlay for the composite Drehleiter — the aerial ladder rendered as a
    # separately-rotatable layer over the plain vehicle body (like the Grosslüfter fan), so the
    # ladder slews independently of the truck heading. Pivots at the turntable (glyph centre 0,0)
    # and extends to one side; rotation2=0 points it back/left, matching the static thumbnail.
    # Render-only (hidden from the palette — useSymbols filters it); the palette shows the full
    # VKF Drehleiter glyph above.
    add("Fahrzeuge / Mittel", "VKF Drehleiter Leiter", svg(
        [line(0, -0.17, -1.15, -0.17, stroke=BLUE, sw=0.1),
         line(0, 0.17, -1.15, 0.17, stroke=BLUE, sw=0.1)]
        + [line(x, -0.17, x, 0.17, stroke=BLUE, sw=0.1)
           for x in (-0.15, -0.35, -0.55, -0.75, -0.95)],
        vb=2.6,
    ))
    add("Fahrzeuge / Mittel", "VKF Hubretter", svg(
        vehicle_body(BLUE, 0.1)
        + [path([(-1, 0.38), (0, 0.18), (-0.86, -0.02)], stroke=BLUE, sw=0.1)],
        vb=2.6,
    ))
    # Boom-only overlay for the composite Hubretter — the articulated Gelenkmast (two-segment boom
    # with a rescue cage at the tip) as a separately-rotatable layer over the plain body (see VKF
    # Drehleiter Leiter). The base sits at the turntable (glyph centre 0,0). Render-only (hidden from
    # the palette); the full VKF Hubretter glyph above is the palette thumbnail.
    add("Fahrzeuge / Mittel", "VKF Hubretter Arm", svg(
        [path([(0.1, 0.12), (-0.6, 0.1), (-1.05, -0.42)], stroke=BLUE, sw=0.1),
         path([(-1.22, -0.28), (-0.95, -0.62), (-0.78, -0.44)], stroke=BLUE, sw=0.1, close=True)],
        vb=2.6,
    ))
    # NOTE: the composite Grosslüfter (VKF Fahrzeug + VKF Luefter mobil) is synthesised in
    # lib/useSymbols and inserted into the palette RIGHT HERE (after the Hubretter, before the Boot)
    # — the order the crews asked for: Fahrzeug, Drehleiter, Hubretter, Grosslüfter, Boot, Pumpe, …
    # Boot / Rettungsboot — side profile, bow to the right, with a small wheelhouse (BLUE outline
    # like the other Fahrzeuge). Rotatable so the heading can be aimed on the map.
    add("Fahrzeuge / Mittel", "FW Boot", svg(
        [path([(-0.85, -0.1), (1.05, -0.1), (0.6, 0.45), (-0.55, 0.45)],
              stroke=BLUE, sw=0.1, fill="none", close=True),
         path([(-0.5, -0.1), (-0.5, -0.5), (0.05, -0.5), (0.05, -0.1)],
              stroke=BLUE, sw=0.1, fill="none", close=True),
         line(-0.55, 0.45, 0.6, 0.45, stroke=BLUE, sw=0.1)],
        vb=2.6,
    ))
    add("Fahrzeuge / Mittel", "VKF Pumpe Typ2", svg(
        [path([(-1, -1), (1, -1), (1, 1), (-1, 1)], stroke=BLUE, sw=0.1, close=True),
         text("MS", 0.8, fill=BLUE, y=-0.4), text("2", 0.8, fill=BLUE, y=0.4)],
        vb=2.6,
    ))
    # ── the smaller Mittel (after the vehicles) ──
    add("Fahrzeuge / Mittel", "VKF Luefter mobil", svg(
        [path([(-0.9, -0.4), (-0.6, -0.4), (-0.3, -0.7), (-0.3, 0.7), (-0.6, 0.4), (-0.9, 0.4)],
              stroke=BLACK, sw=0.06, fill=YELLOW, close=True),
         path([(-0.15, -0.1), (0.4, -0.1), (0.4, -0.4), (0.9, 0), (0.4, 0.4), (0.4, 0.1), (-0.15, 0.1)],
              stroke=BLACK, sw=0.06, fill=YELLOW, close=True),
         line(-0.6, -0.4, -0.6, 0.4, stroke=BLACK, sw=0.06)],
        viewbox="-1.2 -1.2 2.4 2.4",
    ))
    # The extract/Absaugen airflow variant of the mobile Lüfter: SAME fan housing, but the airflow
    # arrow reversed to point INTO the fan (air drawn in from the right → sucked out of the space).
    # Reached only via the Lüfter's Luftrichtung toggle (SymbolProps.extract) — NOT a separate palette
    # entry: useSymbols keeps it in `byName` for rendering but filters it out of the picker. The arrow
    # is the base arrow reflected about its own centre (x'=0.75-x), so it stays in the same box.
    add("Fahrzeuge / Mittel", "VKF Luefter mobil saugend", svg(
        [path([(-0.9, -0.4), (-0.6, -0.4), (-0.3, -0.7), (-0.3, 0.7), (-0.6, 0.4), (-0.9, 0.4)],
              stroke=BLACK, sw=0.06, fill=YELLOW, close=True),
         path([(0.9, -0.1), (0.35, -0.1), (0.35, -0.4), (-0.15, 0), (0.35, 0.4), (0.35, 0.1), (0.9, 0.1)],
              stroke=BLACK, sw=0.06, fill=YELLOW, close=True),
         line(-0.6, -0.4, -0.6, 0.4, stroke=BLACK, sw=0.06)],
        viewbox="-1.2 -1.2 2.4 2.4",
    ))
    add("Fahrzeuge / Mittel", "FW Kleinloeschgeraet", svg(
        [path([(-0.3, 0.6), (0, -0.4), (0.3, 0.6)], stroke=BLUE, sw=0.1, close=True)],
        viewbox="-0.8 -0.7 1.6 1.6",
    ))
    # Drohne — top-down quadcopter: an X-frame of two arms with a rotor ring at each tip and a
    # filled hub. Own-pack aviation glyph (FKS has none); stays upright (no rotation) like a
    # hovering-asset marker.
    # drawn to ~0.85× the unit radius so the square 4-rotor footprint reads at the same visual
    # size as the thin Einsatzleiter/vehicle glyphs (a full-unit square looks noticeably larger)
    add("Fahrzeuge / Mittel", "VKF Drohne", svg(
        [line(-0.6, -0.6, 0.6, 0.6, stroke=BLUE, sw=0.1),
         line(-0.6, 0.6, 0.6, -0.6, stroke=BLUE, sw=0.1),
         circle(-0.6, -0.6, 0.26, stroke=BLUE, sw=0.1),
         circle(0.6, -0.6, 0.26, stroke=BLUE, sw=0.1),
         circle(-0.6, 0.6, 0.26, stroke=BLUE, sw=0.1),
         circle(0.6, 0.6, 0.26, stroke=BLUE, sw=0.1),
         circle(0, 0, 0.19, stroke=BLUE, sw=0.1, fill=BLUE)],
        vb=2.6,
    ))
    add("Fahrzeuge / Mittel", "VKF Helilandeplatz", svg(
        [path([(-1, -1), (1, -1), (1, 1), (-1, 1)], stroke=BLUE, sw=0.1, close=True),
         line(-1, 0, 1, 0, stroke=BLUE, sw=0.1),
         # rope-knot (lying eight) in the top half: centre cross + two side loops
         line(0, -0.5, -0.2, -0.4, stroke=BLUE, sw=0.1),
         line(0, -0.5, 0.2, -0.6, stroke=BLUE, sw=0.1),
         line(0, -0.5, 0.2, -0.4, stroke=BLUE, sw=0.1),
         line(0, -0.5, -0.2, -0.6, stroke=BLUE, sw=0.1),
         f'<path d="M -0.2 -0.6 L -0.4 -0.7 A 0.21 0.21 0 0 0 -0.7 -0.5 A 0.23 0.23 0 0 0 -0.4 -0.3 A 0.81 0.81 0 0 0 -0.2 -0.4" fill="none" stroke="{BLUE}" stroke-width="0.1" stroke-linejoin="round"/>',
         f'<path d="M 0.2 -0.6 L 0.4 -0.7 A 0.21 0.21 0 0 1 0.7 -0.5 A 0.23 0.23 0 0 1 0.4 -0.3 A 0.81 0.81 0 0 1 0.2 -0.4" fill="none" stroke="{BLUE}" stroke-width="0.1" stroke-linejoin="round"/>'],
        vb=2.6,
    ))
    add("Fahrzeuge / Mittel", "FW Entrauchung", svg(
        [path([(-0.5, 0.4), (0.5, 0.4), (-0.5, -0.6)], stroke=BLUE, sw=0.1, fill=BLUE, close=True),
         path([(-0.5, -0.6), (0.5, -0.6), (0.5, 0.4), (-0.5, 0.4)], stroke=BLUE, sw=0.1, close=True),
         line(-0.1, -0.8, -0.1, -1.4, stroke=BLUE, sw=0.1),
         line(0.1, -0.8, 0.1, -1.4, stroke=BLUE, sw=0.1),
         path([(-0.2, -1.4), (0.2, -1.4), (0, -1.9)], stroke=BLUE, sw=0.1, close=True)],
        viewbox="-1.45 -2.2 2.9 2.9",
    ))
    add("Fahrzeuge / Mittel", "FW Sprungretter", svg(
        [path([(-1, -1), (1, -1), (1, 1), (-1, 1)], stroke=BLUE, sw=0.1, close=True)]
        + [line(x, y, x / 2, y / 2, stroke=BLUE, sw=0.1)
           for x, y in ((1, -1), (-1, 1), (-1, -1), (1, 1))],
        vb=2.6,
    ))
    add("Fahrzeuge / Mittel", "FW Leiter", svg(
        # two stiles with rounded tips + rungs (top/bottom rungs sit inset from the tips)
        [line(x, -0.8, x, 0.8, stroke=BLUE, sw=0.1, cap="round") for x in (-0.4, 0.4)]
        + [line(-0.4, y, 0.4, y, stroke=BLUE, sw=0.1)
           for y in (-0.7, -0.5, -0.3, -0.1, 0.1, 0.3, 0.5, 0.7)],
        viewbox="-1.1 -1.1 2.2 2.2",
    ))

    # ── Personen / Sanität
    add("Personen / Sanität", "VKF Sammelstelle", person_post([
        line(-0.4, -0.06, 0.4, -0.06, stroke=BLUE, sw=0.07),
        line(-0.4, 0.06, 0.4, 0.06, stroke=BLUE, sw=0.07),
    ]))
    add("Personen / Sanität", "VKF Patientensammelstelle", person_post([
        line(-0.4, 0, 0.4, 0, stroke=BLUE, sw=0.07),
        line(0, -1, 0, 1, stroke=BLUE, sw=0.07),
    ]))
    add("Personen / Sanität", "VKF Sanitaetshilfsstelle", person_post([
        line(-0.4, -0.06, 0.4, -0.06, stroke=BLUE, sw=0.07),
        line(-0.4, 0.06, 0.4, 0.06, stroke=BLUE, sw=0.07),
        line(0, -1, 0, 1, stroke=BLUE, sw=0.07),
    ]))
    add("Personen / Sanität", "VKF Totensammelstelle", person_post([
        line(-0.28, -0.4, 0.28, -0.4, stroke=BLUE, sw=0.07),
        line(0, -0.72, 0, 0.7, stroke=BLUE, sw=0.07),
    ]))
    add("Personen / Sanität", "FW Verwundetennest", svg(
        [path([(-1, -1.4), (1, -1.4), (1, 1.4), (-1, 1.4)], stroke=BLUE, sw=0.1, close=True),
         line(0, -1.4, 0, 1.4, stroke=BLUE, sw=0.1),
         line(-1, 0, 1, 0, stroke=BLUE, sw=0.1)],
        viewbox="-1.7 -1.7 3.4 3.4",
    ))
    add("Personen / Sanität", "VKF Bereich Sanitaet", zone_circle("SAN"))

    # ── Partner
    add("Partner", "VKF Bereich Feuerwehr", zone_circle("FW"))
    add("Partner", "VKF Bereich Polizei", zone_circle("P"))
    add("Partner", "VKF Bereich Chemiewehr", zone_circle("CW"))
    add("Partner", "VKF Bereich Zivilschutz", zone_circle("ZS"))

    # ── Wasser
    add("Wasser", "SI Ueberflurhydrant", svg(
        [circle(0, 0, 0.6, stroke=BLACK, sw=0.06),
         circle(0, 0, 0.2, stroke=BLACK, sw=0.06, fill=BLACK)],
        vb=1.8,
    ))
    add("Wasser", "SI Unterflurhydrant", svg([circle(0, 0, 0.6, stroke=BLACK, sw=0.06)], vb=1.8))
    add("Wasser", "VKF Innenhydrant", svg(
        [path([(-1, -0.5), (1, -0.5), (1, 0.5), (-1, 0.5)], stroke="#0032cc", sw=0.06, close=True),
         circle(0, 0, 0.5, stroke="#0032cc", sw=0.06, fill="#0032cc")],
        vb=2.6,
    ))
    add("Wasser", "SI Wasserloeschposten", svg(
        [path([(-0.9, -0.6), (0.9, -0.6), (0.9, 0.6), (-0.9, 0.6)], stroke=BLACK, sw=0.06, close=True),
         circle(0, 0, 0.6, stroke=BLACK, sw=0.06),
         # left half of the disc filled
         f'<path d="M 0 0.6 A 0.6 0.6 0 0 1 0 -0.6 L 0 0.6 Z" fill="{BLACK}" stroke="{BLACK}" stroke-width="0.06"/>'],
        vb=2.4,
    ))
    add("Wasser", "WV Loeschweier", svg(basin("#0080ff", 0.1), viewbox="-1.15 -1.05 2.3 2.3"))
    add("Wasser", "SI Wasserbezugsort", svg(basin(BLACK, 0.1), viewbox="-1.15 -1.05 2.3 2.3"))
    add("Wasser", "SI Wasserdruckversorgung", svg(
        [circle(0, 0, 1, stroke=BLACK, sw=0.03),
         line(-1, 0, 1, 0, stroke=BLACK, sw=0.03),
         line(0, 0, 0, 1, stroke=BLACK, sw=0.03)],
        vb=2.3,
    ))

    # ── Gebäude
    # fire-resistance walls: the tick count encodes the rating (1=F30, 2=F60, 3=F180)
    add("Gebäude", "GB BA Wand F30", svg(
        [line(-0.6, 0, 0.6, 0, stroke=BLACK, sw=0.1), line(0, -0.3, 0, 0.3, stroke=BLACK, sw=0.06)],
        vb=1.8,
    ))
    add("Gebäude", "GB BA Wand F60", svg(
        [line(-0.6, 0, 0.6, 0, stroke=BLACK, sw=0.1)]
        + [line(x, -0.3, x, 0.3, stroke=BLACK, sw=0.06) for x in (-0.1, 0.1)],
        vb=1.8,
    ))
    add("Gebäude", "GB BA Wand F180", svg(
        [line(-0.6, 0, 0.6, 0, stroke=BLACK, sw=0.1)]
        + [line(x, -0.3, x, 0.3, stroke=BLACK, sw=0.06) for x in (-0.2, 0, 0.2)],
        vb=1.8,
    ))

    def door(extra, viewbox="-0.9 -0.9 1.8 1.8"):
        # grey wall band + black leaf line with jamb ticks
        return svg(
            [path([(-0.6, 0.1), (0.6, 0.1), (0.6, -0.1), (-0.6, -0.1)], stroke="#bbbbbb", sw=0.06, close=True),
             line(-0.6, 0, 0.6, 0, stroke=BLACK, sw=0.06),
             line(-0.6, -0.3, -0.6, 0.3, stroke=BLACK, sw=0.06),
             line(0.6, -0.3, 0.6, 0.3, stroke=BLACK, sw=0.06)] + extra,
            viewbox=viewbox,
        )

    add("Gebäude", "GB Ture BS R30", door(
        [text("R30", 0.4, y=-0.3)], viewbox="-0.9 -1.0 1.8 1.8"))
    add("Gebäude", "GB Ture Durchgang", door([]))
    add("Gebäude", "GB Lift", svg(
        [path([(-1, -1), (1, -1), (1, 1), (-1, 1)], stroke=BLACK, sw=0.06, close=True),
         line(-1, -1, 1, 1, stroke=BLACK, sw=0.06),
         line(1, -1, -1, 1, stroke=BLACK, sw=0.06)],
        vb=2.6,
    ))

    def half_square(extra, viewbox="-0.9 -0.9 1.8 1.8"):
        # square with the lower-left half filled (Kamin / Abzug family)
        return svg(
            [path([(-0.6, 0.6), (0.6, 0.6), (-0.6, -0.6)], stroke=BLACK, sw=0.06, fill=BLACK, close=True),
             path([(-0.6, -0.6), (0.6, -0.6), (0.6, 0.6), (-0.6, 0.6)], stroke=BLACK, sw=0.06, close=True)]
            + extra,
            viewbox=viewbox,
        )

    add("Gebäude", "GB Kamin", half_square([]))
    add("Gebäude", "GB Abzug", half_square([text("RWA", 0.4, y=0.9)], viewbox="-1.15 -0.9 2.3 2.3"))
    add("Gebäude", "SI Schieber", svg(
        [path([(0, 0), (-0.25, -0.35), (0.25, -0.35)], stroke=BLACK, sw=0.06, fill=BLACK, close=True),
         path([(0, 0), (-0.25, 0.35), (0.25, 0.35)], stroke=BLACK, sw=0.06, fill=BLACK, close=True)],
        vb=1.3,
    ))
    add("Gebäude", "GB Elektrotableau", svg(
        [path([(-1.5, -0.5), (1.5, -0.5), (1.5, 0.5), (-1.5, 0.5)], stroke=BLACK, sw=0.06, close=True),
         path([(-1.1, 0.3), (0, -0.3), (-0.2, 0.3), (0.7, 0)], stroke=BLACK, sw=0.1, fill=BLACK, close=True),
         path([(0.6, -0.2), (0.8, 0.3), (1.1, -0.1)], stroke=BLACK, sw=0.1, fill=BLACK, close=True)],
        vb=3.6,
    ))
    add("Gebäude", "GB Sprinklerzentrale", svg(
        [path([(0, 0), (-0.7, 0.5), (-0.7, -0.5)], stroke=BLACK, sw=0.06, fill=BLACK, close=True),
         path([(0, 0), (0.7, 0.5), (0.7, -0.5)], stroke=BLACK, sw=0.06, fill=BLACK, close=True),
         circle(0.7, 0.6, 0.1, stroke=BLACK, sw=0.06),
         circle(-0.7, -0.6, 0.1, stroke=BLACK, sw=0.06)],
        vb=2.2,
    ))
    add("Gebäude", "GB Brandmeldezentrale", svg(
        [path([(-0.9, -0.6), (0.9, -0.6), (0.9, 0.6), (-0.9, 0.6)], stroke=BLACK, sw=0.06, close=True),
         circle(-0.6, 0.3, 0.15, stroke=BLACK, sw=0.06, fill=BLACK),
         line(-0.6, -0.4, -0.6, 0, stroke=BLACK, sw=0.1)],
        vb=2.4,
    ))
    add("Gebäude", "GB BMA Melder", svg(
        # single detector as drawn on the BMA-Anlageplan: circle with a RED centre dot —
        # marks the Melder that tripped / where the crew went to check
        [circle(0, 0, 0.75, stroke=BLACK, sw=0.06),
         circle(0, 0, 0.16, stroke=RED, sw=0.06, fill=RED)],
        vb=2.0,
    ))
    add("Gebäude", "GB Fernsignaltableau", svg(
        [path([(-0.9, -0.6), (0.9, -0.6), (0.9, 0.6), (-0.9, 0.6)], stroke=BLACK, sw=0.06, close=True),
         circle(-0.4, 0, 0.3, stroke=BLACK, sw=0.06),
         line(-0.6, -0.2, -0.2, 0.2, stroke=BLACK, sw=0.06),
         line(-0.2, -0.2, -0.6, 0.2, stroke=BLACK, sw=0.06)],
        vb=2.4,
    ))
    add("Gebäude", "GB Schluesseldepot", svg(
        [path([(-0.6, -0.6), (0.6, -0.6), (0.6, 0.6), (-0.6, 0.6)], stroke=BLACK, sw=0.06, close=True),
         circle(0, -0.3, 0.16, stroke=BLACK, sw=0.06),
         path([(0, -0.14), (0, 0.4), (0.3, 0.4)], stroke=BLACK, sw=0.06),
         line(0.2, 0.2, 0, 0.2, stroke=BLACK, sw=0.06)],
        vb=1.8,
    ))
    add("Gebäude", "GB Treppe 8", svg(
        # closed outer border (flush corners) + 7 inner treads + up-arrow centre line
        [path([(0, 0), (0.8, 0), (0.8, 1.6), (0, 1.6)], stroke=BLACK, sw=0.06, close=True)]
        + [line(0, y, 0.8, y, stroke=BLACK, sw=0.06) for y in (0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4)]
        + [line(0.4, 1.6, 0.4, 0.4, stroke=BLACK, sw=0.06),
           path([(0.4, 0), (0.2, 0.4), (0.6, 0.4)], stroke=BLACK, sw=0.06, fill=BLACK, close=True)],
        viewbox="-0.7 -0.3 2.2 2.2",
    ))

    # ── Karte
    add("Karte", "SI Windrichtung", svg(
        [path([(0, 1.25), (0.05, 1.25), (0.05, -0.95), (0.35, -0.95), (0, -1.55),
               (-0.3, -0.95), (-0.05, -0.95), (-0.05, 1.25)],
              stroke=BLACK, sw=0.06, fill=BLACK, close=True),
         path([(-0.3, 1.2), (-0.3, 1.3), (0.3, 1.3), (0.3, 1.2)],
              stroke=BLACK, sw=0.06, fill=BLACK, close=True)],
        viewbox="-1.7 -1.85 3.45 3.45",
    ))
    add("Karte", "SI Nordpfeil", svg(
        [path([(-0.4, 0.7), (-0.4, -0.4), (0.4, 0.7), (0.5, 0.7), (0.5, -0.5), (0.4, -0.5),
               (0.4, 0.57), (-0.35, -0.5), (-0.5, -0.5), (-0.5, 0.7)],
              stroke=BLACK, sw=0.06, fill=BLACK, close=True),
         path([(0, 1.25), (0.05, 1.25), (0.05, -0.95), (0.35, -0.95), (0, -1.55),
               (-0.3, -0.95), (-0.05, -0.95), (-0.05, 1.25)],
              stroke=BLACK, sw=0.06, fill=BLACK, close=True)],
        viewbox="-1.7 -1.85 3.4 3.4",
    ))

    return [{"cat": c, "name": n, "svg": s} for c, n, s in syms]


ORDER = ["Schadenlage", "Gefahren", "Führung", "Fahrzeuge / Mittel",
         "Personen / Sanität", "Partner", "Wasser", "Gebäude", "Karte"]


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "review"
    # compare against the historical FireGIS pack when it still exists (pre-swap trees);
    # afterwards the review page simply shows the authored pack alone.
    old_file = ROOT / "public/firegis-symbols.json"
    old_by = ({s["name"]: s["svg"] for s in json.loads(old_file.read_text())["symbols"]}
              if old_file.exists() else {})
    new = build()

    if mode == "emit":
        # every loader reads the known keys (order/symbols), so the marker rides along harmlessly
        out = {
            "_generated": "Do not edit — generated by tools/gen_symbols.py; "
                          "run: python3 tools/gen_symbols.py emit",
            "order": ORDER, "symbols": new,
        }
        (ROOT / "public/tactical-symbols.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
        print(f"wrote public/tactical-symbols.json ({len(new)} symbols)")
        return

    # review page: old (FireGIS) vs new (ours) side by side, on light AND dark strips
    rows = []
    for s in new:
        o = old_by.get(s["name"], "<i>–</i>")
        rows.append(
            f'<tr><td class="n">{s["cat"]}<br><b>{s["name"]}</b></td>'
            f'<td class="g">{o}</td><td class="g">{s["svg"]}</td>'
            f'<td class="g dark">{o}</td><td class="g dark">{s["svg"]}</td></tr>'
        )
    page = (
        '<!doctype html><meta charset="utf-8"><title>Symbol review — alt vs. neu</title>'
        "<style>body{font:13px sans-serif;margin:16px}table{border-collapse:collapse}"
        "td,th{border:1px solid #ccc;padding:6px;text-align:center}"
        ".g svg{width:72px;height:72px}.g{background:#f2efe9}.g.dark{background:#20262e}"
        ".n{text-align:left;min-width:180px}</style>"
        "<h2>Symbol pack review — FireGIS (alt) vs. KP Front (neu)</h2>"
        "<table><tr><th>Symbol</th><th>alt · hell</th><th>NEU · hell</th>"
        "<th>alt · dunkel</th><th>NEU · dunkel</th></tr>" + "".join(rows) + "</table>"
    )
    (ROOT / "tools/symbols-review.html").write_text(page)
    print(f"wrote tools/symbols-review.html ({len(new)} symbols)")


if __name__ == "__main__":
    main()

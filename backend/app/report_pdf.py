"""Server-side Einsatzrapport PDF composition (ReportLab).

The rapport is a FORM, not a data export:
stable automatic facts print as values, missing human fields print as labeled write-in lines,
and printing never blocks on completeness. The signed part flows continuously to minimise
paper: Details box → Kurzbericht → Zeiten-Stubs → Partner → Bemerkungen → Personal (full
roster as tick-off rows with von–bis) → Material worksheet → Unterschriften; then the
Beilagen (Journal when non-empty, Kroki, Pläne, Atemschutz). Stunden are NOT printed or
computed — WinFAP derives them from von–bis.

The Kroki and the annotated Objektpläne are rendered HERE, server-side (app/kroki.py:
raster tiles + the shared symbol pack + pdfium) from pure data the client sends — no
browser capture, no headless browser. Legacy
clients may still upload captured figure PNGs for one release.

Structural labels (section headings, column headers) are German — the app's canonical domain
language and the only deployment locale today (a future enhancement could pass them in). VALUE
labels that depend on locale/state (Trupp status, journal area) are resolved on the client and
sent as strings, so the PDF matches the on-screen report exactly.
"""

from __future__ import annotations

import io

from pydantic import BaseModel
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as _canvas
from reportlab.platypus import (
    BaseDocTemplate,
    CondPageBreak,
    Flowable,
    Frame,
    HRFlowable,
    Image,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

# ----------------------------------------------------------------------------- payload models


class PartnerContact(BaseModel):
    org: str | None = None
    name: str | None = None
    phone: str | None = None
    note: str | None = None


class ReportMetaIn(BaseModel):
    alarmText: str | None = None
    summary: str | None = None
    endedAt: str | None = None  # already display-formatted by the client
    remarks: str | None = None
    lehren: str | None = None
    kontaktperson: str | None = None
    einsatzleiter: str | None = None
    kommandant: str | None = None  # station Kdt from the deployment config (identity.kommandant)
    alarmiertAt: str | None = None
    ausgeruecktAt: str | None = None
    partnerContacts: list[PartnerContact] = []
    gerettete: str | None = None  # pre-formatted, e.g. "2 Personen · 1 Tier"
    rueckmeldungElz: str | None = None  # pre-formatted, e.g. "Muster Hans · 17:15"
    # Alarmierungs-/Ausrückzeiten grid rows, pre-formatted [label, value] pairs — only sent
    # when the paper must double as the capture medium (no digital times recorded yet);
    # digitally recorded times stay digital-only (field-classification decision A).
    zeiten: list[list[str]] = []
    erfasser: str | None = None  # who recorded via the capture view (comma-joined)


class IncidentFacts(BaseModel):
    title: str
    type: str | None = None
    address: str | None = None
    id: str


class JournalRowIn(BaseModel):
    timeLabel: str
    area: str
    text: str
    transcript: str | None = None
    photoKey: str | None = None  # legacy: figure key of a client-uploaded photo
    photoUrl: str | None = None  # server-relative /api/media/<id> — resolved server-side


class KrokiEntityIn(BaseModel):
    """One placed tactical symbol for the server-rendered Kroki. Dynamic glyphs
    (live vehicles, placards) arrive as the client-resolved SVG string."""

    coord: list[float]  # [lng, lat] WGS84
    symbol: str | None = None
    symbolSvg: str | None = None
    kind: str = "symbol"
    rotation: float | None = None
    floor: int | None = None
    floorFrom: int | None = None
    floorTo: int | None = None
    count: int | None = None
    spread: dict | None = None  # {h: 'E'|'W', hBounded, up, down, vBounded}
    caption: str | None = None
    sizeM: float | None = None  # generic shapes: ground size in metres (client shapePx)
    color: str | None = None  # team dot colour


class KrokiDrawingIn(BaseModel):
    """One Lage drawing (client src/types.ts Drawing, incl. FKS hose-line decor)."""

    kind: str  # 'line' | 'area' | 'circle'
    coords: list[list[float]] = []
    color: str | None = None
    width: float | None = None
    dashed: bool = False
    arrow: bool = False
    marker: str | None = None
    label: str | None = None
    showDistance: bool = False
    fillOpacity: float | None = None
    radiusM: float | None = None
    teilstueck: bool = False
    lineNo: int | None = None
    content: str | None = None
    floorTag: int | None = None


class KrokiIn(BaseModel):
    """The Kroki as DATA — the server stitches tiles + draws everything (app/kroki.py)."""

    entities: list[KrokiEntityIn] = []
    drawings: list[KrokiDrawingIn] = []
    # explicit extent (operationalExtentPoints) — empty → derived from the scene
    fitPoints: list[list[float]] = []
    # «aktuelle Ansicht»: explicit centre + zoom win over the fit
    center: list[float] | None = None
    zoom: float | None = None
    # literal MapLibre viewport [west, south, east, north] — preferred over center/zoom
    bounds: list[float] | None = None
    maxTileZoom: int | None = None
    tiles: str | None = None  # active base layer's XYZ template
    attribution: str = "© CARTO, © OpenStreetMap-Mitwirkende"


class PlanAnnoIn(BaseModel):
    """One Whiteboard annotation on a plan page (relative 0..1 coords)."""

    kind: str  # 'draw' | 'area' | 'symbol' | 'text' | 'resource'
    x: float | None = None
    y: float | None = None
    pts: list[list[float]] | None = None
    color: str | None = None
    width: float | None = None
    dashed: bool = False
    fillOpacity: float | None = None
    label: str | None = None
    text: str | None = None
    symbol: str | None = None
    symbolSvg: str | None = None
    rotation: float | None = None
    # generic shapes (Pfeil/Rauch/Rechteck) arrive as kind 'symbol' with a client-resolved
    # svg + their size as a fraction of the plan width (overrides the fixed symbol size)
    sizeN: float | None = None


class PlanPageIn(BaseModel):
    """An annotated Objektplan: the server loads the PDF from its own reference store
    (`url` = /api/reference/<dataset_id>) and renders page 1 + annotations."""

    label: str
    url: str | None = None
    annos: list[PlanAnnoIn] = []
    # Gebäude floor-stack pages have no PDF: a white base of this aspect (h/w) instead,
    # with outline/labels/dial travelling as regular annos (composed client-side)
    blankAspect: float | None = None


class ReadingIn(BaseModel):
    t: str
    kindLabel: str
    bar: str | None = None


class TruppIn(BaseModel):
    name: str
    statusLabel: str
    members: list[str] = []
    auftrag: str | None = None
    ziel: str | None = None
    lineNumber: str | None = None
    entryTime: str | None = None
    exitTime: str | None = None
    readings: list[ReadingIn] = []


class PersonalRowIn(BaseModel):
    """One roster row on the Personal-/Soldblatt: printed tick when digitally recorded,
    blank checkbox + write-in stubs otherwise. Clocks are client-formatted HH:MM."""

    name: str
    erfasst: bool = False
    von: str | None = None
    bis: str | None = None


class PlanRef(BaseModel):
    key: str  # figure key
    label: str
    landscape: bool = False


class MittelFormRowIn(BaseModel):
    """One Material worksheet row: the full catalogue prints with amount stubs, recorded
    amounts print bold (client merges catalogue + recorded lines)."""

    label: str
    menge: str | None = None  # client-formatted "3" — None prints the write-in stub
    unit: str = "Stk"


class ReportOptionsIn(BaseModel):
    kroki: bool = True
    atemschutz: bool = True
    attendance: bool = True
    mittel: bool = True
    journal: bool = True


class ReportPayload(BaseModel):
    incident: IncidentFacts
    meta: ReportMetaIn = ReportMetaIn()
    options: ReportOptionsIn = ReportOptionsIn()
    generatedAt: str  # client-formatted
    # server-side rendering (the current path): Kroki as data + plan refs
    kroki: KrokiIn | None = None
    krokiCaption: str | None = None
    planPages: list[PlanPageIn] = []
    # legacy client-captured figures (one-release compat window)
    krokiKey: str | None = None
    plans: list[PlanRef] = []
    trupps: list[TruppIn] = []
    # Personal-/Soldblatt: the FULL roster (recorded people ticked), guests appended
    personal: list[PersonalRowIn] = []
    # Material worksheet: full catalogue with stubs, recorded amounts filled
    mittelForm: list[MittelFormRowIn] = []
    # Partnerorganisationen presets — tick-off row when none were recorded digitally
    partnerPresets: list[str] = []
    journal: list[JournalRowIn] = []


# ----------------------------------------------------------------------------- German labels

L = {
    "eyebrow": "Einsatzrapport",
    "keyword": "Stichwort",
    "address": "Adresse / Objekt",
    "einsatzleiter": "Einsatzleiter",
    "kontaktperson": "Kontaktperson",
    "alarmierung": "Alarmierung",
    "ausgerueckt": "Ausgerückt",
    "incidentEnd": "Einsatzende",
    "incidentId": "Einsatz-ID",
    "alarmMessage": "Alarmmeldung",
    "summary": "Kurzbericht / durchgeführte Arbeiten",
    "lehren": "Lehren / Sicherheit",
    "remarks": "Bemerkungen",
    "partnerOrgs": "Partnerorganisationen",
    "partnerOther": "Weitere",
    "kroki": "Kroki",
    "atemschutz": "Atemschutzüberwachung",
    "members": "Mitglieder",
    "auftrag": "Auftrag / Ziel",
    "line": "Leitung",
    "entry": "Eintritt",
    "exit": "Austritt",
    "colTime": "Zeit",
    "colKind": "Art",
    "colPressure": "Druck bar",
    "noPressureLog": "Kein Druckverlauf erfasst.",
    "personal": "Personal / Anwesenheit",
    "personalHint": "Abhaken, ggf. von–bis ergänzen",
    "journal": "Einsatzjournal",
    "colArea": "Bereich",
    "colEntry": "Eintrag",
    "transcript": "Transkript",
    "noEntries": "Keine Einträge.",
    "signoff": "Unterschriften",
    "sigOrtDatum": "Ort, Datum",
    "sigKommandant": "Kommandant",
    "generatedAt": "Erstellt",
    "mittel": "Material (Menge eintragen)",
    "gerettete": "Gerettete (Personen / Tiere)",
    "rueckmeldungElz": "Rückmeldung ELZ",
    "zeiten": "Alarmierungs- / Ausrückzeiten",
    "erfasser": "Erfasst durch",
}

# two underscores per side: Helvetica digits and «_» share the same 556/1000 advance,
# so a blank stub lines up column-exact with a machine-filled HH:MM next to it
_TIME_STUB = "__:__"
_LINE_STUB = " "  # write-in rows: empty cell, the ruled underline is the affordance


# ----------------------------------------------------------------------------- styles


class _NumberedCanvas(_canvas.Canvas):
    """Two-pass canvas: buffers pages, then stamps «n / total» bottom-right on save —
    ReportLab has no forward page count in a single pass."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_states: list[dict] = []

    def showPage(self):  # noqa: N802 — ReportLab API name
        self._saved_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved_states)
        for state in self._saved_states:
            self.__dict__.update(state)
            w = self._pagesize[0]
            self.setFont("Helvetica", 8)
            self.setFillColor(colors.HexColor("#8a94a3"))
            self.drawRightString(w - 14 * mm, 8 * mm, f"{self._pageNumber} / {total}")
            _canvas.Canvas.showPage(self)
        _canvas.Canvas.save(self)


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    ink = colors.HexColor("#1b2330")
    dim = colors.HexColor("#5b6573")
    return {
        # the built-in Title style is CENTERED; force left so titles/headings sit at the margin
        # (the real alignment fix is zeroing the Frame side padding below).
        "title": ParagraphStyle("rp_title", parent=base["Title"], fontSize=20, leading=24, textColor=ink,
                                spaceAfter=2, alignment=TA_LEFT, leftIndent=0),
        "eyebrow": ParagraphStyle("rp_eyebrow", parent=base["Normal"], fontSize=10, leading=12, textColor=dim,
                                  spaceAfter=1, fontName="Helvetica-Bold", alignment=TA_LEFT, leftIndent=0),
        # section heading matching the Erfassungsblatt: 11.5pt bold with a solid dark rule
        # right underneath (the rule is a separate HRFlowable, see head() in the composer)
        "h2": ParagraphStyle("rp_h2", parent=base["Heading2"], fontSize=11.5, leading=14, textColor=ink,
                             spaceBefore=16, spaceAfter=2, alignment=TA_LEFT, leftIndent=0),
        "h3": ParagraphStyle("rp_h3", parent=base["Heading3"], fontSize=12, leading=15, textColor=ink,
                             spaceBefore=6, spaceAfter=3, alignment=TA_LEFT, leftIndent=0),
        "body": ParagraphStyle("rp_body", parent=base["Normal"], fontSize=10, leading=13.5, textColor=ink, alignment=TA_LEFT),
        "label": ParagraphStyle("rp_label", parent=base["Normal"], fontSize=8.5, leading=11, textColor=dim,
                               fontName="Helvetica-Bold", spaceAfter=0),
        "cell": ParagraphStyle("rp_cell", parent=base["Normal"], fontSize=9, leading=12, textColor=ink),
        "cellhead": ParagraphStyle("rp_cellhead", parent=base["Normal"], fontSize=8, leading=10, textColor=dim,
                                  fontName="Helvetica-Bold"),
        "muted": ParagraphStyle("rp_muted", parent=base["Normal"], fontSize=9, leading=12, textColor=dim),
        "mono": ParagraphStyle("rp_mono", parent=base["Normal"], fontSize=8.5, leading=11, textColor=ink, fontName="Courier"),
        "stub": ParagraphStyle("rp_stub", parent=base["Normal"], fontSize=9, leading=12,
                               textColor=colors.HexColor("#969696")),
        # the tick inside a checkbox square — centered in its narrow cell
        "check": ParagraphStyle("rp_check", parent=base["Normal"], fontSize=8.5, leading=10,
                                textColor=ink, alignment=TA_CENTER),
        # compact worksheet rows (roster / Material) — tight leading so a 66er roster
        # plus Material plus signatures still lands on two sheets
        "rcell": ParagraphStyle("rp_rcell", parent=base["Normal"], fontSize=8.5, leading=10, textColor=ink),
        "rstub": ParagraphStyle("rp_rstub", parent=base["Normal"], fontSize=8.5, leading=10,
                                textColor=colors.HexColor("#969696")),
    }


_GRID = colors.HexColor("#d7dde5")
_PANEL = colors.HexColor("#eef2f7")
_WRITE = colors.HexColor("#969696")  # write-in dotted leaders/stubs (jsPDF gray 150)
_INK = colors.HexColor("#141414")  # form ink (jsPDF gray 20)
_LABEL = colors.HexColor("#3c3c3c")  # field labels (jsPDF gray 60)


def _esc(s: str | None) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _fit_text(c, text: str, max_w: float, font: str = "Helvetica", size: float = 9) -> str:
    """Truncate to the field width with an ellipsis (jsPDF splitTextToSize[0] equivalent)."""
    if c.stringWidth(text, font, size) <= max_w:
        return text
    while text and c.stringWidth(text + "…", font, size) > max_w:
        text = text[:-1]
    return text + "…"


class _FormRows(Flowable):
    """Dotted-leader form fields exactly like the jsPDF Erfassungsblatt: `Label: ······`,
    with a recorded value printed ON the line (as handwriting would be). Each row is a list
    of fields `{label, w (fraction), value?, time?}`; `time` fields render the `__:__`
    stub instead of a leader. `boxed` draws the Details frame around the block."""

    def __init__(self, width: float, rows: list[list[dict]], boxed: bool = False, pitch: float = 8 * mm):
        super().__init__()
        self.width = width
        self.rows = rows
        self.boxed = boxed
        self.pitch = pitch
        self.pad = 3 * mm if boxed else 0
        self.height = len(rows) * self.pitch + 2 * self.pad - (2.5 * mm if not boxed else 0)

    def wrap(self, availWidth: float, availHeight: float):  # noqa: N803 — ReportLab API
        return self.width, self.height

    def draw(self):
        c = self.canv
        if self.boxed:
            c.setStrokeColor(colors.HexColor("#282828"))
            c.setLineWidth(1.1)
            c.rect(0, 0, self.width, self.height)
        inner = self.width - 2 * self.pad
        for i, row in enumerate(self.rows):
            y = self.height - self.pad - (i + 1) * self.pitch + 2.4 * mm  # text baseline
            x = self.pad
            for f in row:
                w = inner * f["w"]
                label = f"{f['label']}:"
                c.setFont("Helvetica", 9.5)
                c.setFillColor(_LABEL)
                c.drawString(x, y, label)
                lx = x + c.stringWidth(label, "Helvetica", 9.5) + 2 * mm
                value = f.get("value") or ""
                if f.get("time"):
                    c.setFont("Helvetica", 9.5)
                    c.setFillColor(_INK if value else _WRITE)
                    c.drawString(lx, y, value or _TIME_STUB)
                else:
                    # dotted leader to the field end; the value (if any) prints on the line
                    c.saveState()
                    c.setStrokeColor(_WRITE)
                    c.setLineWidth(0.5)
                    c.setDash(0.8, 0.8)
                    c.line(lx, y - 0.6 * mm, x + w - 2 * mm, y - 0.6 * mm)
                    c.restoreState()
                    if value:
                        c.setFont("Helvetica", 9)
                        c.setFillColor(_INK)
                        c.drawString(lx + 1 * mm, y, _fit_text(c, value, w - (lx - x) - 4 * mm))
                x += w


def _fit_image(data: bytes | None, max_w: float, max_h: float) -> Image | None:
    if not data:
        return None
    try:
        iw, ih = ImageReader(io.BytesIO(data)).getSize()
    except Exception:
        return None
    if iw <= 0 or ih <= 0:
        return None
    scale = min(max_w / iw, max_h / ih)
    return Image(io.BytesIO(data), width=iw * scale, height=ih * scale)


# ----------------------------------------------------------------------------- composition

# Print Kroki canvas size — the composer and the tile prewarm share it so both derive the
# same View and hit identical tile-cache keys.
_KROKI_PX = (1600, 940)


def _kroki_view(pk, kw: int, kh: int):
    """Derive the print View for a Kroki scene — shared by the composer and the tile prewarm."""
    from . import kroki as kk

    if pk.bounds and len(pk.bounds) == 4:
        view = kk.bounds_view(tuple(pk.bounds), kw, kh)
        # Bounds carry no camera zoom; retain it for print symbol scaling when present.
        view.overlay_z = pk.zoom
        return view
    if pk.center and pk.zoom is not None:
        return kk.center_view(tuple(pk.center), pk.zoom, kw, kh)
    scene = kk.KrokiScene(entities=[e.model_dump() for e in pk.entities],
                          drawings=[d.model_dump() for d in pk.drawings])
    pts = [tuple(p) for p in pk.fitPoints] or scene.extent_points()
    return kk.fit_view(pts, kw, kh)


def warm_report_tiles(payload: ReportPayload) -> None:
    """Fetch+cache the Kroki base tiles for this report's map view and discard the image, so
    a later compose skips the network round-trips. Pure cache warming; never raises."""
    opt = payload.options
    if not (opt.kroki and payload.kroki is not None and payload.kroki.tiles):
        return
    try:
        from . import kroki as kk

        view = _kroki_view(payload.kroki, *_KROKI_PX)
        kk.render_base(view, payload.kroki.tiles, cache=kk.get_tile_cache(),
                       max_tile_z=payload.kroki.maxTileZoom or 19)
    except Exception:
        pass


def compose_report_pdf(payload: ReportPayload, figures: dict[str, bytes],
                       plan_pdfs: dict[str, bytes] | None = None) -> bytes:
    """Compose the full rapport. `figures` carries legacy client-captured PNGs plus
    server-resolved journal photos (key `photo:<url>`); `plan_pdfs` maps a planPage url
    to the plan-PDF bytes the API layer loaded from the reference store."""
    st = _styles()
    buf = io.BytesIO()
    plan_pdfs = plan_pdfs or {}

    pw, ph = A4
    lw, lh = landscape(A4)
    margin = 14 * mm
    doc = BaseDocTemplate(
        buf, pagesize=A4, leftMargin=margin, rightMargin=margin, topMargin=margin, bottomMargin=margin,
        title=f"Einsatzrapport — {payload.incident.title}", author="KP Front",
    )
    # leftPadding/rightPadding=0: ReportLab Frames default to 6pt side padding, which paragraphs
    # honour but the full-width tables render flush to the frame edge — so headings/paragraphs sat
    # ~6pt right of the tables. Zero it so every flowable is flush at the doc margin.
    portrait_frame = Frame(margin, margin, pw - 2 * margin, ph - 2 * margin, id="p", leftPadding=0, rightPadding=0)
    land_frame = Frame(margin, margin, lw - 2 * margin, lh - 2 * margin, id="l", leftPadding=0, rightPadding=0)
    doc.addPageTemplates([
        PageTemplate(id="portrait", frames=[portrait_frame], pagesize=A4),
        PageTemplate(id="landscape", frames=[land_frame], pagesize=landscape(A4)),
    ])
    inner_w = pw - 2 * margin
    land_inner_w, land_inner_h = lw - 2 * margin, lh - 2 * margin

    story: list = []
    m, opt = payload.meta, payload.options

    def head(text: str, cond: bool = True) -> list:
        """Section heading matching the Erfassungsblatt: bold line + solid dark rule.
        The CondPageBreak keeps a heading from being orphaned at a page foot — if less
        than heading + two content lines fit, the whole section starts on the next page.
        `cond=False` for headings already inside a KeepTogether (a nested page break
        would confuse its measuring)."""
        return [
            *( [CondPageBreak(26 * mm)] if cond else [] ),
            Paragraph(_esc(text), st["h2"]),
            HRFlowable(width="100%", thickness=1.1, color=colors.HexColor("#282828"),
                       spaceBefore=0, spaceAfter=6, lineCap="butt"),
        ]

    def write_lines(n: int, row_h: float = 8 * mm) -> Table:
        """N dotted write-in lines (the Erfassungsblatt's Notizen look)."""
        t = Table([[Paragraph(_LINE_STUB, st["body"])] for _ in range(n)], colWidths=[inner_w], rowHeights=[row_h] * n)
        t.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (-1, -1), 0.5, _WRITE, 1, (0.8, 0.8)),
            ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ]))
        return t

    # --- page 1: Haupt-Rapport ------------------------------------------------------------
    story.append(Paragraph(_esc(payload.incident.title), st["title"]))
    iid = payload.incident.id
    short_id = f"{iid[:8]}…{iid[-4:]}" if len(iid) > 14 else iid
    footer_bits = [f"{L['generatedAt']}: {payload.generatedAt}", f"{L['incidentId']}: {short_id}"]
    if m.erfasser:
        footer_bits.append(f"{L['erfasser']}: {m.erfasser}")
    story.append(Paragraph(_esc(" · ".join(footer_bits)), st["muted"]))
    story.append(Spacer(1, 10))

    # The Details box — same frame + dotted-leader fields as the Erfassungsblatt, with the
    # automatic facts and any recorded human facts printed ON the lines. Missing values stay
    # writable by hand; nothing blocks the print.
    half = 0.5
    story.append(_FormRows(inner_w, [
        [{"label": L["keyword"], "w": half, "value": payload.incident.type},
         {"label": L["alarmierung"], "w": half, "value": m.alarmiertAt}],
        [{"label": L["address"], "w": 1.0, "value": payload.incident.address}],
        [{"label": L["ausgerueckt"], "w": half, "value": m.ausgeruecktAt},
         {"label": L["incidentEnd"], "w": half, "value": m.endedAt}],
        [{"label": L["einsatzleiter"], "w": half, "value": m.einsatzleiter},
         {"label": L["gerettete"], "w": half, "value": m.gerettete}],
        [{"label": L["kontaktperson"], "w": 1.0, "value": m.kontaktperson}],
        [{"label": L["rueckmeldungElz"], "w": 1.0, "value": m.rueckmeldungElz}],
    ], boxed=True))
    story.append(Spacer(1, 2))

    # Kurzbericht — the form's central human field: printed text or dotted write lines
    story.extend(head(L["summary"]))
    if m.summary:
        story.append(Paragraph(_esc(m.summary), st["body"]))
    else:
        story.append(write_lines(4))

    # Zeiten-stub grid: ONLY when nothing was recorded digitally — then the paper is the
    # capture medium (otherwise the times stay digital-only and never print).
    if m.zeiten:
        story.extend(head(L["zeiten"]))
        zrows = [[Paragraph(_esc(val or _TIME_STUB), st["stub" if not val else "cell"]),
                  Paragraph(_esc(lab), st["cell"])] for lab, val in m.zeiten]
        # 3-up columns to keep the grid compact
        cols = 3
        n_rows = -(-len(zrows) // cols)
        grid: list[list] = []
        for r in range(n_rows):
            row: list = []
            for c in range(cols):
                i = c * n_rows + r
                row.extend(zrows[i] if i < len(zrows) else ["", ""])
            grid.append(row)
        cw = inner_w / cols
        zt = Table(grid, colWidths=[cw * 0.32, cw * 0.68] * cols)
        zt.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(zt)

    if m.partnerContacts:
        story.extend(head(L["partnerOrgs"]))
        prows = [[Paragraph(_esc(c.org), st["cell"]), Paragraph(_esc(c.name), st["cell"]),
                  Paragraph(_esc(c.phone), st["mono"]), Paragraph(_esc(c.note), st["cell"])]
                 for c in m.partnerContacts]
        pt = Table(prows, colWidths=[inner_w * x for x in (0.3, 0.25, 0.22, 0.23)])
        pt.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.4, _GRID),
                                ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                                ("LEFTPADDING", (0, 0), (0, -1), 0)]))
        story.append(pt)
    elif payload.partnerPresets:
        # nothing recorded → tick-off row like the Erfassungsblatt
        story.extend(head(L["partnerOrgs"]))
        items = [*payload.partnerPresets, f"{L['partnerOther']}: ______________"]
        story.append(_check_grid(items, set(), inner_w, st, cols=3))

    # Bemerkungen only when digitally filled (2026-07-18): the Kurzbericht is the
    # hand-writing field — an extra empty ruled block just cost paper
    if m.remarks:
        story.extend(head(L["remarks"]))
        story.append(Paragraph(_esc(m.remarks), st["body"]))
    if m.lehren:
        story.extend(head(L["lehren"]))
        story.append(Paragraph(_esc(m.lehren), st["body"]))

    # --- Personal / Anwesenheit — flows right after the form fields (no forced page
    # break: the roster table splits at row boundaries, so a small Einsatz stays on
    # one sheet and a big roster continues on the next page) ------------------------------
    if opt.attendance and payload.personal:
        story.extend(head(L["personal"]))
        story.append(Paragraph(_esc(L["personalHint"]), st["muted"]))
        story.append(Spacer(1, 4))
        story.append(_personal_table(payload.personal, inner_w, st))

    # --- Material worksheet: the full catalogue with amount stubs --------------------------
    if opt.mittel and payload.mittelForm:
        story.extend(head(L["mittel"]))
        story.append(_mittel_table(payload.mittelForm, inner_w, st))

    # Unterschriften close the SIGNED part (Haupt-Rapport + Personal + Material — one
    # unit, kantonale Vorlage 11-01-003): Einsatzleitung AND Kommandant, each with an own
    # Ort/Datum leader — same Visum look as the Erfassungsblatt. The signed paper is the
    # record — no digital proof section replaces it (field-classification decision E).
    el = L["einsatzleiter"] + (f" · {m.einsatzleiter}" if m.einsatzleiter else "")
    kdt = L["sigKommandant"] + (f" · {m.kommandant}" if m.kommandant else "")
    sig = _FormRows(inner_w, [
        [{"label": L["sigOrtDatum"], "w": 0.4}, {"label": el, "w": 0.6}],
        [{"label": L["sigOrtDatum"], "w": 0.4}, {"label": kdt, "w": 0.6}],
    ], pitch=9.5 * mm)
    story.append(KeepTogether([*head(L["signoff"], cond=False), sig]))

    # --- Einsatzjournal (Beilage) — only when there are entries; an empty journal table
    # would just cost paper on the blank form -----------------------------------------------
    if opt.journal and payload.journal:
        story.extend(head(L["journal"]))
        thead = [Paragraph(_esc(L[c]), st["cellhead"]) for c in ("colTime", "colArea", "colEntry")]
        body: list[list] = []
        for r in payload.journal:
            entry_cells: list = [Paragraph(_esc(r.text), st["cell"])]
            if r.transcript:
                entry_cells.append(Paragraph(f"<b>{_esc(L['transcript'])}:</b> {_esc(r.transcript)}", st["muted"]))
            photo_bytes = (figures.get(r.photoKey) if r.photoKey else None) \
                or (figures.get(f"photo:{r.photoUrl}") if r.photoUrl else None)
            photo = _fit_image(photo_bytes, inner_w * 0.45, 45 * mm)
            if photo:
                entry_cells.append(Spacer(1, 2))
                entry_cells.append(photo)
            body.append([Paragraph(_esc(r.timeLabel), st["cell"]), Paragraph(_esc(r.area), st["cell"]), entry_cells])
        # time column wide enough for the full "DD.MM.YYYY, HH:MM" label so it never wraps onto
        # a second line (which inflated every journal row).
        tbl = Table([thead, *body], colWidths=[36 * mm, 24 * mm, inner_w - 60 * mm], repeatRows=1)
        tbl.setStyle(_table_style())
        story.append(tbl)

    # --- Anhang: Kroki + annotated plans ALWAYS at the end (decided 2026-07-14) — the data
    # sections above are the identical main section; visual material is appended, never
    # interleaved. The Kroki is rendered HERE, server-side (app/kroki.py); the figure-based
    # branches remain as the one-release compat window for old clients.
    kroki_png: bytes | None = None
    if opt.kroki and payload.kroki is not None:
        from . import kroki as kk

        pack = kk.get_pack()
        if pack is not None and payload.kroki.tiles:
            kw, kh = _KROKI_PX
            scene = kk.KrokiScene(
                entities=[e.model_dump() for e in payload.kroki.entities],
                drawings=[d.model_dump() for d in payload.kroki.drawings],
            )
            view = _kroki_view(payload.kroki, kw, kh)
            symbol_zoom = view.overlay_z if view.overlay_z is not None else view.z
            img_out = kk.render_kroki(scene, pack, payload.kroki.tiles, width=kw, height=kh,
                                     view=view, cache=kk.get_tile_cache(),
                                     sym_mul=kk.kroki_symbol_mul(symbol_zoom),
                                     max_tile_z=payload.kroki.maxTileZoom or 19,
                                     attribution=payload.kroki.attribution)
            b = io.BytesIO()
            img_out.save(b, "PNG")
            kroki_png = b.getvalue()
    if kroki_png is None and opt.kroki and payload.krokiKey:
        kroki_png = figures.get(payload.krokiKey)

    # server-rendered plan pages (pdfium + board annos, blank-base Gebäude stacks);
    # legacy captured figures fall back. Rendered BEFORE the Kroki page is appended so
    # the Kroki's trailing page break can be skipped when plan pages follow (each plan
    # page issues its own template+break — two breaks in a row print an empty page).
    plan_imgs: list[tuple[str, bytes, bool]] = []
    for pp in payload.planPages:
        pdf_bytes = plan_pdfs.get(pp.url or "")
        if not pdf_bytes and not pp.blankAspect:
            continue
        try:
            from . import kroki as kk

            rendered = (
                kk.render_plan_page(pdf_bytes, [a.model_dump() for a in pp.annos], kk.get_pack())
                if pdf_bytes
                else kk.render_blank_page(pp.blankAspect or 1.0, [a.model_dump() for a in pp.annos], kk.get_pack())
            )
        except Exception:
            continue  # a broken plan PDF must not sink the whole rapport
        b = io.BytesIO()
        rendered.save(b, "PNG")
        plan_imgs.append((pp.label, b.getvalue(), rendered.width >= rendered.height))
    for p in payload.plans:
        data = figures.get(p.key)
        if data:
            plan_imgs.append((p.label, data, p.landscape))

    if kroki_png:
        story.append(NextPageTemplate("landscape"))
        story.append(PageBreak())
        story.extend(head(L["kroki"]))
        if payload.krokiCaption:
            story.append(Paragraph(_esc(payload.krokiCaption), st["muted"]))
        img = _fit_image(kroki_png, land_inner_w, land_inner_h - 22 * mm)
        if img:
            story.append(Spacer(1, 4))
            story.append(img)
        if not plan_imgs:
            story.append(NextPageTemplate("portrait"))
            story.append(PageBreak())

    for label, data, is_landscape in plan_imgs:
        story.append(NextPageTemplate("landscape" if is_landscape else "portrait"))
        story.append(PageBreak())
        story.extend(head(label))
        mw = land_inner_w if is_landscape else inner_w
        mh = (land_inner_h if is_landscape else (ph - 2 * margin)) - 22 * mm
        img = _fit_image(data, mw, mh)
        if img:
            story.append(Spacer(1, 4))
            story.append(img)
    if plan_imgs:
        story.append(NextPageTemplate("portrait"))
        story.append(PageBreak())

    # Atemschutzüberwachung closes the Anhang: protocol for reconstruction, not primary
    if opt.atemschutz and payload.trupps:
        story.extend(head(L["atemschutz"]))
        for tr in payload.trupps:
            story.append(Paragraph(f"{_esc(tr.name)} — {_esc(tr.statusLabel)}", st["h3"]))
            meta_bits = []
            if tr.members:
                meta_bits.append((L["members"], ", ".join(tr.members)))
            if tr.auftrag or tr.ziel:
                meta_bits.append((L["auftrag"], " · ".join([x for x in (tr.auftrag, tr.ziel) if x])))
            if tr.lineNumber:
                meta_bits.append((L["line"], str(tr.lineNumber)))
            if tr.entryTime:
                meta_bits.append((L["entry"], tr.entryTime))
            if tr.exitTime:
                meta_bits.append((L["exit"], tr.exitTime))
            for k, v in meta_bits:
                story.append(Paragraph(f"<b>{_esc(k)}:</b> {_esc(v)}", st["cell"]))
            thead = [Paragraph(_esc(L[c]), st["cellhead"]) for c in ("colTime", "colKind", "colPressure")]
            body = [[Paragraph(_esc(r.t), st["cell"]), Paragraph(_esc(r.kindLabel), st["cell"]),
                     Paragraph(_esc(r.bar), st["cell"])] for r in tr.readings]
            if not body:
                body = [[Paragraph(_esc(L["noPressureLog"]), st["muted"]), "", ""]]
            tbl = Table([thead, *body], colWidths=[inner_w * x for x in (0.45, 0.35, 0.2)], repeatRows=1)
            tbl.setStyle(_table_style())
            story.append(Spacer(1, 3))
            story.append(tbl)
            story.append(Spacer(1, 6))

    doc.build(story, canvasmaker=_NumberedCanvas)
    return buf.getvalue()


def _personal_table(personal: list[PersonalRowIn], inner_w: float, st: dict[str, ParagraphStyle]) -> Table:
    """Two-up roster: [☐|Name|von–bis] × 2 — recorded people get a printed tick + clocks,
    the rest stays blank for the pen. Long rosters flow onto the next page."""
    half = -(-len(personal) // 2)
    check_w, time_w = 4 * mm, 30 * mm
    name_w = inner_w / 2 - check_w - time_w - 3 * mm

    def cells(p: PersonalRowIn | None) -> list:
        if p is None:
            return ["", "", ""]
        vonbis = f"{p.von or _TIME_STUB} – {p.bis or _TIME_STUB}"
        return [
            Paragraph("<b>X</b>" if p.erfasst else "", st["check"]),
            Paragraph(_esc(p.name) if p.name else _LINE_STUB, st["rcell"]),
            Paragraph(_esc(vonbis), st["rstub"] if not (p.von or p.bis) else st["rcell"]),
        ]

    rows = []
    style: list[tuple] = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 1.8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.8),
        ("LEFTPADDING", (0, 0), (-1, -1), 1),
        # breathing room between the checkbox square and the name (jsPDF gap ~1.6mm);
        # the check cells lose ALL side padding so the X centers in its square
        ("LEFTPADDING", (1, 0), (1, -1), 5),
        ("LEFTPADDING", (5, 0), (5, -1), 5),
        ("LEFTPADDING", (0, 0), (0, -1), 0),
        ("RIGHTPADDING", (0, 0), (0, -1), 0),
        ("LEFTPADDING", (4, 0), (4, -1), 0),
        ("RIGHTPADDING", (4, 0), (4, -1), 0),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
    ]
    for r in range(half):
        left = personal[r]
        right = personal[half + r] if half + r < len(personal) else None
        rows.append([*cells(left), "", *cells(right)])
        for base in (0, 4):
            p = left if base == 0 else right
            if p is None:
                continue
            style.append(("BOX", (base, r), (base, r), 0.5, _WRITE))  # the checkbox square
            if not p.name:
                style.append(("LINEBELOW", (base + 1, r), (base + 1, r), 0.5, _WRITE, 1, (0.8, 0.8)))  # guest write-in
    return_t = Table(rows, colWidths=[check_w, name_w, time_w, 3 * mm, check_w, name_w, time_w])
    return_t.setStyle(TableStyle(style))
    return return_t


def _mittel_table(mittel: list[MittelFormRowIn], inner_w: float, st: dict[str, ParagraphStyle]) -> Table:
    """Two-up Material worksheet: label + «______ Stk» amount stub / bold recorded amount."""
    half = -(-len(mittel) // 2)
    amt_w = 26 * mm
    label_w = inner_w / 2 - amt_w - 3 * mm

    def cells(row: MittelFormRowIn | None) -> list:
        if row is None:
            return ["", ""]
        amt = f"<b>{_esc(row.menge)}</b> {_esc(row.unit)}" if row.menge else f"______ {_esc(row.unit)}"
        return [Paragraph(_esc(row.label), st["rcell"]),
                Paragraph(amt, st["rcell"] if row.menge else st["rstub"])]

    rows = []
    for r in range(half):
        right = mittel[half + r] if half + r < len(mittel) else None
        rows.append([*cells(mittel[r]), "", *cells(right)])
    t = Table(rows, colWidths=[label_w, amt_w, 3 * mm, label_w, amt_w])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 1.8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.8),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


def _check_grid(items: list[str], ticked: set[str], inner_w: float, st: dict[str, ParagraphStyle], cols: int = 3) -> Table:
    """Compact checkbox raster (Partner presets): fixed columns, tick-off only."""
    n_rows = -(-len(items) // cols)
    check_w = 4 * mm
    label_w = inner_w / cols - check_w
    rows: list[list] = []
    style: list[tuple] = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 1),
        # gap between checkbox square and label; check cells un-padded so the X centers
        *[("LEFTPADDING", (2 * c + 1, 0), (2 * c + 1, -1), 5) for c in range(cols)],
        *[("LEFTPADDING", (2 * c, 0), (2 * c, -1), 0) for c in range(cols)],
        *[("RIGHTPADDING", (2 * c, 0), (2 * c, -1), 0) for c in range(cols)],
    ]
    for r in range(n_rows):
        row: list = []
        for c in range(cols):
            i = r * cols + c
            if i < len(items):
                row.extend([Paragraph("<b>X</b>" if items[i] in ticked else "", st["check"]),
                            Paragraph(_esc(items[i]), st["cell"])])
                style.append(("BOX", (c * 2, r), (c * 2, r), 0.5, _WRITE))
            else:
                row.extend(["", ""])
        rows.append(row)
    t = Table(rows, colWidths=[check_w, label_w] * cols)
    t.setStyle(TableStyle(style))
    return t


def _table_style() -> TableStyle:
    return TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, _GRID),
        ("BACKGROUND", (0, 0), (-1, 0), _PANEL),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ])

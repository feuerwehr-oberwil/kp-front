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
import logging

from pydantic import BaseModel, field_validator
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
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

logger = logging.getLogger(__name__)

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
    # Alarmierungs-/Ausrückzeiten grid rows, pre-formatted [label, value] pairs — one row
    # per configured Gruppe/Fahrzeug, value empty where nothing was recorded (the composer
    # prints `__:__` there for the pen). See metaExtrasForPdf in src/lib/report.ts.
    zeiten: list[list[str]] = []
    erfasser: str | None = None  # who recorded via the capture view (comma-joined)


class IncidentFacts(BaseModel):
    title: str
    type: str | None = None  # the Einsatz KATEGORIE (wizard «Kategorie»); the Stichwort is `title`
    address: str | None = None
    id: str
    #: An Übung must be legible AS an Übung on the paper. It is excluded from the statistics, so
    #: a drill rapport that looks like a deployment puts paper and data in disagreement — and
    #: nothing else on the sheet distinguishes the two.
    isExercise: bool = False


class JournalRowIn(BaseModel):
    timeLabel: str
    area: str
    text: str
    transcript: str | None = None
    photoKey: str | None = None  # legacy: figure key of a client-uploaded photo
    photoUrl: str | None = None  # single photo — the shape rows written before 2026-08-06 carry
    #: several photos on one row (one damage is rarely one picture). Readers take both.
    photoUrls: list[str] = []


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
    color: str | None = None  # team dot colour / note ink
    # free-text note styling. noteW (SCREEN px, since map notes don't scale with zoom) is what
    # makes a note a wrapping text box; absent = the legacy one-line pill.
    noteW: float | None = None
    noteSize: str | None = None  # 's' | 'm' | 'l'
    notePlain: bool = False


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
    # the Atemschutz-Trupp working this Leitung, resolved + abbreviated by the client (the server
    # has no Trupp records to match against). Printed as the last part of the end tag.
    trupp: str | None = None


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
    # free-text note styling. wN (a fraction of the plan width, like sizeN) is what makes a note
    # a wrapping text box; absent = the legacy one-line pill.
    wN: float | None = None
    noteSize: str | None = None  # 's' | 'm' | 'l'
    notePlain: bool = False


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


#: A free remark rides inside a fixed-width table cell. ReportLab cannot split a cell across
#: pages, so a long enough one raises LayoutError and the WHOLE Rapport fails to compose —
#: a pasted paragraph made the report unprintable with an error naming no field. Printing must
#: never be blocked by what someone typed, so an over-long remark is TRUNCATED, not rejected:
#: rejecting would only move the failure to a 422, and the data is already in the workspace.
_NOTE_MAX = 400


def _clip_note(v: str | None) -> str | None:
    if v is None or len(v) <= _NOTE_MAX:
        return v
    return v[: _NOTE_MAX - 1].rstrip() + "…"


class PersonalRowIn(BaseModel):
    """One roster row on the Personal-/Soldblatt: printed tick when digitally recorded,
    blank checkbox + write-in stubs otherwise. Clocks are client-formatted HH:MM."""

    name: str
    erfasst: bool = False
    von: str | None = None
    bis: str | None = None
    #: this clock was DERIVED from the incident's bounds, not recorded by anybody — printed grey
    #: so a signed sheet says which times were measured and which the app worked out. A line that
    #: is grey on both ends is one nobody has to check.
    vonDerived: bool = False
    bisDerived: bool = False
    #: free remark on this person for this Einsatz («Fahrer TLF», «abgelöst 21:40») — printed
    #: small under the name, on the first row of a person who was present more than once
    note: str | None = None

    _clip = field_validator("note")(_clip_note)


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
    #: free remark on the line («an Werkhof übergeben») — printed under the label, because a
    #: quantity on its own has never explained what happened to the material. The client JOINS
    #: every source line's remark into this one string, so the cap matters more here than on a
    #: single field (see _clip_note).
    note: str | None = None

    _clip = field_validator("note")(_clip_note)


class ReportOptionsIn(BaseModel):
    kroki: bool = True
    #: Kroki page orientation. A tall Lage (a Hochhaus, a street running north) wasted half a
    #: landscape sheet and printed the map postage-stamp small; the operator picks the shape in
    #: the crop window and the page follows it. Default landscape = the historical behaviour.
    krokiLandscape: bool = True
    atemschutz: bool = True
    attendance: bool = True
    mittel: bool = True
    journal: bool = True


class PersonalSummaryIn(BaseModel):
    """Anwesende + Einsatzstunden, computed CLIENT-side where the ISO timestamps are.

    The rows print «19:12 – 21:40»; re-deriving minutes from that formatted clock text here
    would be a second answer that can disagree with the app's. ``hours`` is the raw sum — what
    actually happened — and ``hoursRounded`` the Sold figure (each person rounded up to the next
    ``stepMin`` block once ``graceMin`` past the previous one, then summed). The rule travels
    WITH the numbers so the paper can name it instead of leaving a reader to reverse-engineer it.
    """

    present: int = 0
    hours: str = ""
    hoursRounded: str = ""
    stepMin: int = 30
    graceMin: int = 5


class AttachmentIn(BaseModel):
    """One Beilage: a photo that belongs to the REPORT — an ID document, a damage close-up.

    Printed one per row at the end, as large as the page allows, because the reason to
    photograph a document is to be able to READ it afterwards. That is the whole difference to a
    journal photo, which rides small beside its text as an illustration of a timed entry.
    """

    url: str  # server-relative /api/media/<id> — resolved server-side, same as a journal photo
    caption: str | None = None


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
    personalSummary: PersonalSummaryIn | None = None
    journal: list[JournalRowIn] = []
    attachments: list[AttachmentIn] = []


# ----------------------------------------------------------------------------- German labels

L = {
    "eyebrow": "Einsatzrapport",
    "keyword": "Stichwort",
    "category": "Kategorie",
    "exercise": "ÜBUNG — kein Ereignis",
    "address": "Adresse / Objekt",
    "einsatzleiter": "Einsatzleiter",
    "kontaktperson": "Kontaktperson",
    "alarmierung": "Alarmierung",
    "ausgerueckt": "Ausgerückt",
    "incidentEnd": "Einsatzende",
    "incidentId": "Einsatz-ID",
    "alarmMessage": "Alarmmeldung",
    "attachments": "Beilagen",
    "attachmentNoCaption": "ohne Bildlegende",
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
    # {n} Anwesende · {h} raw · {r} rounded · the rule that produced {r}
    "personalTotals": "<b>{n} Anwesende</b> · Einsatzstunden <b>{h}</b> "
    "(gerundet <b>{r}</b> – pro Person auf {step} Min. aufgerundet, ab {grace} Min. über dem Block)",
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
    "mittel": "Material",
    "gerettete": "Gerettete",
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
    ReportLab has no forward page count in a single pass. The Einsatz is named bottom-left:
    a rapport is 2 pages or 25, it gets stapled, unstapled and passed around, and a sheet that
    does not say which Einsatz it belongs to cannot be put back."""

    footer_label = ""

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
            if self.footer_label:
                self.drawString(14 * mm, 8 * mm, _fit_text(self, self.footer_label, w - 40 * mm, size=8))
            _canvas.Canvas.showPage(self)
        _canvas.Canvas.save(self)


def _collapse_breaks(story: list) -> list:
    """Drop the empty pages that fall out of composing the Anhang section by section.

    ⚠️ Every Anhang section both OPENS with «switch template, break» and CLOSES by switching
    back — so two adjacent sections put two page breaks in a row and eject a sheet carrying
    nothing but the footer (observed between the Kroki and the Beilagen), and a rapport whose
    last section is the Kroki, the plans or the Beilagen ends on one. Sections stay independent —
    each may legitimately be absent — so the fix belongs here: keep at most ONE break per run,
    with the last template switch that preceded it, and drop the run at the end entirely.
    """
    out: list = []
    i, n = 0, len(story)
    while i < n:
        if not isinstance(story[i], (PageBreak, NextPageTemplate, Spacer)):
            out.append(story[i])
            i += 1
            continue
        j, tmpl, brk = i, None, False
        while j < n and isinstance(story[j], (PageBreak, NextPageTemplate, Spacer)):
            if isinstance(story[j], NextPageTemplate):
                tmpl = story[j]
            elif isinstance(story[j], PageBreak):
                brk = True
            j += 1
        if j < n:  # a run in the MIDDLE: one template switch, one break
            if tmpl is not None:
                out.append(tmpl)
            if brk:
                out.append(PageBreak())
            else:
                out.extend(f for f in story[i:j] if isinstance(f, Spacer))
        i = j
    return out


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    ink = colors.HexColor("#1b2330")
    dim = colors.HexColor("#5b6573")
    return {
        # the built-in Title style is CENTERED; force left so titles/headings sit at the margin
        # (the real alignment fix is zeroing the Frame side padding below).
        "title": ParagraphStyle(
            "rp_title",
            parent=base["Title"],
            fontSize=20,
            leading=24,
            textColor=ink,
            spaceAfter=2,
            alignment=TA_LEFT,
            leftIndent=0,
        ),
        "eyebrow": ParagraphStyle(
            "rp_eyebrow",
            parent=base["Normal"],
            fontSize=10,
            leading=12,
            textColor=dim,
            spaceAfter=1,
            fontName="Helvetica-Bold",
            alignment=TA_LEFT,
            leftIndent=0,
        ),
        # section heading matching the Erfassungsblatt: 11.5pt bold with a solid dark rule
        # right underneath (the rule is a separate HRFlowable, see head() in the composer)
        "h2": ParagraphStyle(
            "rp_h2",
            parent=base["Heading2"],
            fontSize=12.5,
            leading=14,
            textColor=ink,
            spaceBefore=16,
            spaceAfter=2,
            alignment=TA_LEFT,
            leftIndent=0,
        ),
        "h3": ParagraphStyle(
            "rp_h3",
            parent=base["Heading3"],
            fontSize=10.5,
            leading=13,
            textColor=ink,
            spaceBefore=6,
            spaceAfter=3,
            alignment=TA_LEFT,
            leftIndent=0,
        ),
        "body": ParagraphStyle(
            "rp_body", parent=base["Normal"], fontSize=10, leading=13.5, textColor=ink, alignment=TA_LEFT
        ),
        "label": ParagraphStyle(
            "rp_label",
            parent=base["Normal"],
            fontSize=8.5,
            leading=11,
            textColor=dim,
            fontName="Helvetica-Bold",
            spaceAfter=0,
        ),
        "cell": ParagraphStyle("rp_cell", parent=base["Normal"], fontSize=9, leading=12, textColor=ink),
        "exercise": ParagraphStyle(
            "rp_exercise",
            parent=base["Normal"],
            fontSize=11,
            leading=13,
            textColor=colors.HexColor("#b4690a"),
            fontName="Helvetica-Bold",
            spaceAfter=3,
        ),
        "cellhead": ParagraphStyle(
            "rp_cellhead", parent=base["Normal"], fontSize=8, leading=10, textColor=dim, fontName="Helvetica-Bold"
        ),
        "muted": ParagraphStyle("rp_muted", parent=base["Normal"], fontSize=9, leading=12, textColor=dim),
        "mono": ParagraphStyle(
            "rp_mono", parent=base["Normal"], fontSize=8.5, leading=11, textColor=ink, fontName="Courier"
        ),
        "stub": ParagraphStyle(
            "rp_stub", parent=base["Normal"], fontSize=9, leading=12, textColor=colors.HexColor("#969696")
        ),
        # the tick inside a checkbox square — centered in its narrow cell
        "check": ParagraphStyle(
            "rp_check", parent=base["Normal"], fontSize=8.5, leading=10, textColor=ink, alignment=TA_CENTER
        ),
        # compact worksheet rows (roster / Material) — tight leading so a 66er roster
        # plus Material plus signatures still lands on two sheets
        "rcell": ParagraphStyle("rp_rcell", parent=base["Normal"], fontSize=8.5, leading=10, textColor=ink),
        "rstub": ParagraphStyle(
            "rp_rstub", parent=base["Normal"], fontSize=8.5, leading=10, textColor=colors.HexColor("#969696")
        ),
        # right-hanging variants for the Material amount column — a quantity is read down the
        # column, so it has to end on the same edge whatever the label beside it does
        "ramt": ParagraphStyle(
            "rp_ramt", parent=base["Normal"], fontSize=8.5, leading=10, textColor=ink, alignment=TA_RIGHT
        ),
        "rstubr": ParagraphStyle(
            "rp_rstubr",
            parent=base["Normal"],
            fontSize=8.5,
            leading=10,
            textColor=colors.HexColor("#969696"),
            alignment=TA_RIGHT,
        ),
    }


_GRID = colors.HexColor("#d7dde5")
_PANEL = colors.HexColor("#eef2f7")
_WRITE = colors.HexColor("#969696")  # write-in dotted leaders/stubs (jsPDF gray 150)
#: a clock the app derived rather than one somebody recorded — same grey as a write-in stub,
#: because both mean «this is not a measured value»
_DERIVED = "#969696"
_INK = colors.HexColor("#141414")  # form ink (jsPDF gray 20)
_LABEL = colors.HexColor("#3c3c3c")  # field labels (jsPDF gray 60)


def _esc(s: str | None) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _str_w(text: str, font: str, size: float) -> float:
    """Text width without a canvas — for sizing a column before there is anything to draw on."""
    return pdfmetrics.stringWidth(text, font, size)


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

    def _tab_stops(self, c, inner: float) -> dict[float, float]:
        """One value column per label column: the widest label at a given x sets where every
        value at that x starts. Measuring each label on its own put «Stichwort: Brand» and
        «Adresse / Objekt: Schlossgasse 9» at different indents in the same box, so nothing in
        it lined up vertically. Keyed by the field's own x offset, so a full-width row and the
        left half of a split row share a stop and the right half gets its own."""
        stops: dict[float, float] = {}
        for row in self.rows:
            x = 0.0
            for f in row:
                key = round(x, 3)
                w = c.stringWidth(f"{f['label']}:", "Helvetica", 9.5)
                stops[key] = max(stops.get(key, 0.0), w)
                x += inner * f["w"]
        return stops

    def draw(self):
        c = self.canv
        if self.boxed:
            c.setStrokeColor(colors.HexColor("#282828"))
            c.setLineWidth(1.1)
            c.rect(0, 0, self.width, self.height)
        inner = self.width - 2 * self.pad
        stops = self._tab_stops(c, inner)
        for i, row in enumerate(self.rows):
            y = self.height - self.pad - (i + 1) * self.pitch + 2.4 * mm  # text baseline
            x = self.pad
            offset = 0.0
            for f in row:
                w = inner * f["w"]
                label = f"{f['label']}:"
                c.setFont("Helvetica", 9.5)
                c.setFillColor(_LABEL)
                c.drawString(x, y, label)
                lx = x + stops[round(offset, 3)] + 2 * mm
                value = f.get("value") or ""
                if f.get("time"):
                    c.setFont("Helvetica", 9.5)
                    c.setFillColor(_INK if value else _WRITE)
                    c.drawString(lx, y, value or _TIME_STUB)
                else:
                    # A leader is an invitation to write. It is drawn where there is nothing to
                    # read — an empty Kontaktperson still gets its line — and omitted under a
                    # value that is already printed, unless the field is one that gets signed
                    # ON the line even when the name above it is known (`line=True`).
                    if not value or f.get("line"):
                        c.saveState()
                        c.setStrokeColor(_WRITE)
                        c.setLineWidth(0.5)
                        c.setDash(0.8, 0.8)
                        c.line(lx, y - 0.6 * mm, x + w - 2 * mm, y - 0.6 * mm)
                        c.restoreState()
                    if value:
                        c.setFont("Helvetica", 9)
                        c.setFillColor(_INK)
                        c.drawString(
                            lx + (1 * mm if f.get("line") else 0), y, _fit_text(c, value, w - (lx - x) - 4 * mm)
                        )
                x += w
                offset += w


#: Letterhead size for the station logo — tall enough to be recognised, short enough that the
#: incident title stays the first thing read on the page.
_LOGO_H = 13 * mm
_LOGO_MAX_W = 55 * mm


def _logo_flowable(data: bytes | None) -> Image | None:
    """The station logo as a left-hung letterhead, or None when there is nothing printable.

    SVG is the default brandmark and ReportLab cannot read it, so it is rasterised through the
    same renderer the Kroki symbols use. Anything that fails to decode is skipped silently.
    """
    if not data:
        return None
    if data[:5] in (b"<?xml", b"<svg ") or b"<svg" in data[:512]:
        try:
            from . import kroki as kk

            img = kk.raster_svg(data.decode("utf-8", "replace"), 512)
            b = io.BytesIO()
            img.save(b, "PNG")
            data = b.getvalue()
        except Exception:  # noqa: BLE001 — a logo never fails a rapport
            logger.warning("Logo konnte nicht gerendert werden — Rapport wird ohne Logo gedruckt.", exc_info=True)
            return None
    out = _fit_image(data, _LOGO_MAX_W, _LOGO_H)
    if out is not None:
        out.hAlign = "LEFT"
    return out


def _fit_image(data: bytes | None, max_w: float, max_h: float) -> Image | None:
    if not data:
        return None
    try:
        iw, ih = ImageReader(io.BytesIO(data)).getSize()
    except Exception:  # noqa: BLE001 — unreadable image → no image, never a failed rapport
        return None
    if iw <= 0 or ih <= 0:
        return None
    scale = min(max_w / iw, max_h / ih)
    return Image(io.BytesIO(data), width=iw * scale, height=ih * scale)


# ----------------------------------------------------------------------------- composition

# Print Kroki canvas size — the composer and the tile prewarm share it so both derive the
# same View and hit identical tile-cache keys.
_KROKI_PX = (1600, 940)
#: the same crop turned upright — a portrait Kroki page gets a portrait render, so the picture
#: fills the sheet instead of being letterboxed into a landscape frame
_KROKI_PX_PORTRAIT = (1000, 1400)


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
    scene = kk.KrokiScene(
        entities=[e.model_dump() for e in pk.entities], drawings=[d.model_dump() for d in pk.drawings]
    )
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

        view = _kroki_view(payload.kroki, *(_KROKI_PX if opt.krokiLandscape else _KROKI_PX_PORTRAIT))
        kk.render_base(view, payload.kroki.tiles, cache=kk.get_tile_cache(), max_tile_z=payload.kroki.maxTileZoom or 19)
    except Exception:  # noqa: BLE001 — a cold cache must not fail the rapport
        # Was a silent `pass`. A failed prewarm is recoverable (the real render refetches),
        # but silence here is how a permanently unreachable tile source stays invisible.
        logger.warning("Rapport tile prewarm failed; the render will refetch", exc_info=True)


def compose_report_pdf(
    payload: ReportPayload, figures: dict[str, bytes], plan_pdfs: dict[str, bytes] | None = None
) -> bytes:
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
        buf,
        pagesize=A4,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=margin,
        bottomMargin=margin,
        title=f"Einsatzrapport — {payload.incident.title}",
        author="KP Front",
    )
    # leftPadding/rightPadding=0: ReportLab Frames default to 6pt side padding, which paragraphs
    # honour but the full-width tables render flush to the frame edge — so headings/paragraphs sat
    # ~6pt right of the tables. Zero it so every flowable is flush at the doc margin.
    portrait_frame = Frame(margin, margin, pw - 2 * margin, ph - 2 * margin, id="p", leftPadding=0, rightPadding=0)
    land_frame = Frame(margin, margin, lw - 2 * margin, lh - 2 * margin, id="l", leftPadding=0, rightPadding=0)
    doc.addPageTemplates(
        [
            PageTemplate(id="portrait", frames=[portrait_frame], pagesize=A4),
            PageTemplate(id="landscape", frames=[land_frame], pagesize=landscape(A4)),
        ]
    )
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
            *([CondPageBreak(26 * mm)] if cond else []),
            Paragraph(_esc(text), st["h2"]),
            HRFlowable(
                width="100%",
                thickness=1.1,
                color=colors.HexColor("#282828"),
                spaceBefore=0,
                spaceAfter=6,
                lineCap="butt",
            ),
        ]

    def write_lines(n: int, row_h: float = 8 * mm) -> Table:
        """N dotted write-in lines (the Erfassungsblatt's Notizen look)."""
        t = Table([[Paragraph(_LINE_STUB, st["body"])] for _ in range(n)], colWidths=[inner_w], rowHeights=[row_h] * n)
        t.setStyle(
            TableStyle(
                [
                    ("LINEBELOW", (0, 0), (-1, -1), 0.5, _WRITE, 1, (0.8, 0.8)),
                    ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ]
            )
        )
        return t

    # --- page 1: Haupt-Rapport ------------------------------------------------------------
    # The station's own mark above the title — the rapport leaves the building (Gemeinde,
    # Versicherung, GVB) and should say whose it is before it says what happened. Modest by
    # design: a letterhead, not a banner. Missing, unreadable or SVG-without-a-renderer simply
    # prints nothing — a logo is never worth failing a rapport over.
    logo = _logo_flowable(figures.get("logo"))
    if logo is not None:
        story.append(logo)
        story.append(Spacer(1, 6))
    # An Übung says so ABOVE the title, before anything else is read. It is the one fact that
    # changes what the whole document is, and it is excluded from the statistics — a drill
    # rapport that reads like a deployment is a record that contradicts the numbers.
    if payload.incident.isExercise:
        story.append(Paragraph(_esc(L["exercise"]), st["exercise"]))
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
    story.append(
        _FormRows(
            inner_w,
            [
                [
                    {"label": L["category"], "w": half, "value": payload.incident.type},
                    {"label": L["alarmierung"], "w": half, "value": m.alarmiertAt},
                ],
                [{"label": L["address"], "w": 1.0, "value": payload.incident.address}],
                [
                    {"label": L["ausgerueckt"], "w": half, "value": m.ausgeruecktAt},
                    {"label": L["incidentEnd"], "w": half, "value": m.endedAt},
                ],
                [
                    {"label": L["einsatzleiter"], "w": half, "value": m.einsatzleiter},
                    {"label": L["gerettete"], "w": half, "value": m.gerettete},
                ],
                [{"label": L["kontaktperson"], "w": 1.0, "value": m.kontaktperson}],
                [{"label": L["rueckmeldungElz"], "w": 1.0, "value": m.rueckmeldungElz}],
            ],
            boxed=True,
        )
    )
    story.append(Spacer(1, 2))

    # Kurzbericht — the form's central human field: printed text or dotted write lines
    story.extend(head(L["summary"]))
    if m.summary:
        story.append(Paragraph(_esc(m.summary), st["body"]))
    else:
        story.append(write_lines(4))

    # Alarmierungs-/Ausrückzeiten: always printed when the deployment configures groups or
    # vehicles — recorded times as times, the rest as `__:__` for the pen. Empty only when
    # the config declares neither.
    if m.zeiten:
        story.extend(head(L["zeiten"]))
        zrows = [
            [Paragraph(_esc(val or _TIME_STUB), st["stub" if not val else "cell"]), Paragraph(_esc(lab), st["cell"])]
            for lab, val in m.zeiten
        ]
        # 3-up columns to keep the grid compact
        cols = 3
        n_rows = -(-len(zrows) // cols)
        grid: list[list] = []
        for ri in range(n_rows):
            row: list = []
            for c in range(cols):
                i = c * n_rows + ri
                row.extend(zrows[i] if i < len(zrows) else ["", ""])
            grid.append(row)
        cw = inner_w / cols
        zt = Table(grid, colWidths=[cw * 0.32, cw * 0.68] * cols)
        zt.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ]
            )
        )
        story.append(zt)

    # Bemerkungen only when digitally filled (2026-07-18): the Kurzbericht is the
    # hand-writing field — an extra empty ruled block just cost paper
    if m.remarks:
        story.extend(head(L["remarks"]))
        story.append(Paragraph(_esc(m.remarks), st["body"]))
    if m.lehren:
        story.extend(head(L["lehren"]))
        story.append(Paragraph(_esc(m.lehren), st["body"]))

    # --- Anwesenheit · Material · Partnerorganisationen, in THAT order -------------------
    # The same order the Rapport dialog asks for them on screen, so filling in and checking the
    # paper follow one sequence: our own people, our own material, then everyone else. No forced
    # page break — each table splits at a row boundary, so a small Einsatz stays on one sheet.
    if opt.attendance and payload.personal:
        story.extend(head(L["personal"]))
        # The two numbers a Fourier is asked for, on the sheet that gets signed. RAW first —
        # what actually happened — and the Sold figure behind it, with the rule that produced it
        # spelled out, because a rounded number nobody can reproduce is a number nobody trusts.
        ps = payload.personalSummary
        if ps and ps.present:
            story.append(
                Paragraph(
                    L["personalTotals"].format(
                        n=ps.present,
                        h=_esc(ps.hours),
                        r=_esc(ps.hoursRounded),
                        step=ps.stepMin,
                        grace=ps.graceMin,
                    ),
                    st["cell"],
                )
            )
        story.append(Paragraph(_esc(L["personalHint"]), st["muted"]))
        story.append(Spacer(1, 4))
        story.append(_personal_table(payload.personal, inner_w, st))

    # --- Material worksheet: the full catalogue with amount stubs --------------------------
    if opt.mittel and payload.mittelForm:
        story.extend(head(L["mittel"]))
        story.append(_mittel_table(payload.mittelForm, inner_w, st))

    # EVERY organisation the station works with is listed — ticked where it was involved, blank
    # where it was not — the way the Personalblatt lists the whole Mannschaft. A list of only the
    # ticked ones cannot say «die Polizei war NICHT da», and on paper that difference is the whole
    # point of the block. Anything recorded beyond the station's own list (a neighbouring Wehr, a
    # Werkhof) is appended, and a blank row closes it off for the one nobody thought of — exactly
    # the write-in rows the roster ends with. Printed unconditionally: the rapport is a FORM, and
    # a station with no configured list still has a Polizei to tick.
    story.extend(head(L["partnerOrgs"]))
    by_org = {(c.org or "").strip().lower(): c for c in m.partnerContacts}
    listed = [(org, by_org.pop(org.strip().lower(), None)) for org in payload.partnerPresets]
    listed += [(c.org or "", c) for c in by_org.values()]
    listed += [("", None)]
    story.append(_partner_table(listed, inner_w, st))

    # Unterschriften close the SIGNED part (Haupt-Rapport + Personal + Material — one
    # unit, kantonale Vorlage 11-01-003): Einsatzleitung AND Kommandant, each with an own
    # Ort/Datum leader — same Visum look as the Erfassungsblatt. The signed paper is the
    # record — no digital proof section replaces it (field-classification decision E).
    # «Einsatzleiter: Céline Widmer ______», not «Einsatzleiter · Céline Widmer: ______». The
    # name belongs to the ROLE that is signing, so it reads as a value of that label; glued into
    # the label it made the colon land after the name and the signature line start past it.
    # `line` keeps the rule under a filled field here — unlike the Details box, this one is
    # signed on the line whether or not the name above it is already known.
    sig = _FormRows(
        inner_w,
        [
            [
                {"label": L["sigOrtDatum"], "w": 0.4, "line": True},
                {"label": L["einsatzleiter"], "w": 0.6, "value": m.einsatzleiter, "line": True},
            ],
            [
                {"label": L["sigOrtDatum"], "w": 0.4, "line": True},
                {"label": L["sigKommandant"], "w": 0.6, "value": m.kommandant, "line": True},
            ],
        ],
        pitch=9.5 * mm,
    )
    story.append(KeepTogether([*head(L["signoff"], cond=False), sig]))

    # --- Einsatzjournal (Beilage) — only when there are entries; an empty journal table
    # would just cost paper on the blank form -----------------------------------------------
    if opt.journal and payload.journal:
        # The Journal is a BEILAGE, like the Kroki and the plans — an addition to the rapport,
        # not a part of it. It started wherever the signed part happened to end, which put the
        # first entries in the white space under the Unterschriften and made the two read as one
        # document. Its own sheet says what it is. (_collapse_breaks drops the double if a
        # section boundary already broke here.)
        story.append(PageBreak())
        story.extend(head(L["journal"], cond=False))
        thead = [Paragraph(_esc(L[c]), st["cellhead"]) for c in ("colTime", "colArea", "colEntry")]
        body: list[list] = []
        for r in payload.journal:
            entry_cells: list = [Paragraph(_esc(r.text), st["cell"])]
            if r.transcript:
                entry_cells.append(Paragraph(f"<b>{_esc(L['transcript'])}:</b> {_esc(r.transcript)}", st["muted"]))
            urls = r.photoUrls or ([r.photoUrl] if r.photoUrl else [])
            shots = [figures.get(r.photoKey)] if r.photoKey else []
            shots += [figures.get(f"photo:{u}") for u in urls]
            for data in shots:
                # each picture on its own line under the text, at the same width — a row with
                # three photos prints three, which is why they were attached
                photo = _fit_image(data, inner_w * 0.45, 45 * mm)
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
            kw, kh = _KROKI_PX if opt.krokiLandscape else _KROKI_PX_PORTRAIT
            scene = kk.KrokiScene(
                entities=[e.model_dump() for e in payload.kroki.entities],
                drawings=[d.model_dump() for d in payload.kroki.drawings],
            )
            view = _kroki_view(payload.kroki, kw, kh)
            symbol_zoom = view.overlay_z if view.overlay_z is not None else view.z
            img_out = kk.render_kroki(
                scene,
                pack,
                payload.kroki.tiles,
                width=kw,
                height=kh,
                view=view,
                cache=kk.get_tile_cache(),
                sym_mul=kk.kroki_symbol_mul(symbol_zoom),
                max_tile_z=payload.kroki.maxTileZoom or 19,
                attribution=payload.kroki.attribution,
            )
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
        except Exception:  # noqa: BLE001 — a broken plan PDF must not sink the whole rapport
            logger.warning("Plan page %r could not be rendered; skipped", pp.label, exc_info=True)
            continue
        b = io.BytesIO()
        rendered.save(b, "PNG")
        plan_imgs.append((pp.label, b.getvalue(), rendered.width >= rendered.height))
    for p in payload.plans:
        data = figures.get(p.key)
        if data:
            plan_imgs.append((p.label, data, p.landscape))

    if kroki_png:
        k_land = opt.krokiLandscape
        story.append(NextPageTemplate("landscape" if k_land else "portrait"))
        story.append(PageBreak())
        story.extend(head(L["kroki"]))
        if payload.krokiCaption:
            story.append(Paragraph(_esc(payload.krokiCaption), st["muted"]))
        k_w = land_inner_w if k_land else inner_w
        k_h = (land_inner_h if k_land else (ph - 2 * margin)) - 22 * mm
        img = _fit_image(kroki_png, k_w, k_h)
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

    # Beilagen — laid out for the number of them there actually are (see _attachment_block).
    # A Beilage whose bytes are gone drops its plate, not the rapport.
    att_data = [(a, figures.get(f"photo:{a.url}")) for a in payload.attachments]
    att_shown: list[tuple[AttachmentIn, bytes]] = [(a, d) for a, d in att_data if d]
    if att_shown:
        story.append(NextPageTemplate("portrait"))
        story.append(PageBreak())
        story.extend(head(f"{L['attachments']} ({len(att_shown)})"))
        story.append(_attachment_block(att_shown, inner_w, st, L))

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
            # A TABLE, not one Paragraph per line: as free lines each value started right after
            # its own label, so «Mitglieder:», «Auftrag / Ziel:» and «Eintritt:» put their values
            # at three different indents and nothing under the Trupp name lined up. One label
            # column, sized to the widest label, gives every value the same tab stop.
            if meta_bits:
                label_w = max(_str_w(f"{k}:", "Helvetica-Bold", 9) for k, _ in meta_bits) + 3 * mm
                meta_tbl = Table(
                    [
                        [Paragraph(f"<b>{_esc(k)}:</b>", st["cell"]), Paragraph(_esc(v), st["cell"])]
                        for k, v in meta_bits
                    ],
                    colWidths=[label_w, inner_w - label_w],
                )
                meta_tbl.setStyle(
                    TableStyle(
                        [
                            ("VALIGN", (0, 0), (-1, -1), "TOP"),
                            ("TOPPADDING", (0, 0), (-1, -1), 0.5),
                            ("BOTTOMPADDING", (0, 0), (-1, -1), 0.5),
                            ("LEFTPADDING", (0, 0), (-1, -1), 0),
                            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                        ]
                    )
                )
                story.append(meta_tbl)
            thead = [Paragraph(_esc(L[c]), st["cellhead"]) for c in ("colTime", "colKind", "colPressure")]
            body = [
                [
                    Paragraph(_esc(r.t), st["cell"]),
                    Paragraph(_esc(r.kindLabel), st["cell"]),
                    Paragraph(_esc(r.bar), st["cell"]),
                ]
                for r in tr.readings
            ]
            if not body:
                body = [[Paragraph(_esc(L["noPressureLog"]), st["muted"]), "", ""]]
            tbl = Table([thead, *body], colWidths=[inner_w * x for x in (0.45, 0.35, 0.2)], repeatRows=1)
            tbl.setStyle(_table_style())
            story.append(Spacer(1, 3))
            story.append(tbl)
            story.append(Spacer(1, 6))

    story = _collapse_breaks(story)
    label = " · ".join(x for x in (payload.incident.title, payload.generatedAt) if x)

    class _Stamped(_NumberedCanvas):
        footer_label = label

    doc.build(story, canvasmaker=_Stamped)
    return buf.getvalue()


# Every two-up section (Personal · Material · Partner) hangs its two halves side by side with a
# 3 mm gutter. Top-aligned and un-padded, so each column starts at the section's top edge and the
# gutter is the only thing between them.
_SPLIT_OUTER = [
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("TOPPADDING", (0, 0), (-1, -1), 0),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
]
# Below the usable frame height, with room for the section heading above the table.
_SPLIT_BUDGET = 660


def _two_up(items: list, make_column, col_w: float) -> Table:
    """Lay `items` out in two independent columns that can still break across pages.

    Each half gets its OWN sub-table, so a four-line remark on one side never sets the row
    height on the other — the drift that made the printed sheet look broken. But a sub-table is
    one indivisible flowable: put both halves in a single outer row and a roster longer than a
    page raises a LayoutError and takes the whole rapport down with it (observed at 120 people).

    So the outer table gets one row per PAGE-SIZED CHUNK. ReportLab splits between those rows,
    each chunk is measured against the real frame rather than guessed at, and the usual case —
    everything fits on one page — is a single row, i.e. exactly two independent columns.
    """
    half = -(-len(items) // 2)
    left, right = items[:half], items[half:]
    rows: list[list] = []
    i = 0
    while i < half:
        # grow the chunk while BOTH halves still fit; always take at least one item so a single
        # oversized row (a pasted essay in a remark) cannot spin here forever
        k = 1
        while i + k <= half:
            lt, rt = make_column(left[i : i + k]), make_column(right[i : i + k])
            tallest = max(lt.wrap(col_w, _SPLIT_BUDGET * 4)[1], rt.wrap(col_w, _SPLIT_BUDGET * 4)[1])
            if tallest > _SPLIT_BUDGET and k > 1:
                k -= 1
                break
            if tallest > _SPLIT_BUDGET:
                break
            k += 1
        rows.append([make_column(left[i : i + k]), "", make_column(right[i : i + k])])
        i += k
    outer = Table(rows or [["", "", ""]], colWidths=[col_w, 3 * mm, col_w])
    outer.setStyle(TableStyle(_SPLIT_OUTER))
    return outer


def _personal_table(personal: list[PersonalRowIn], inner_w: float, st: dict[str, ParagraphStyle]) -> Table:
    """Two-up roster: [☐|Name|von–bis] × 2 — recorded people get a printed tick + clocks,
    the rest stays blank for the pen. Long rosters flow onto the next page."""
    check_w = 4 * mm
    # The clock column is sized to what it actually has to hold. A fixed 30 mm was enough for
    # «14:41 – 11:00» and not for «02.08. 14:41 – 04.06. 11:00», so an Einsatz over midnight
    # wrapped every row onto two lines — the remark under the name then had a stack of dates
    # beside it. Capped, so a stray long value cannot eat the name column instead.
    widest = max(
        (_str_w(f"{p.von or _TIME_STUB} – {p.bis or _TIME_STUB}", "Helvetica", 8.5) for p in personal),
        default=0.0,
    )
    time_w = max(30 * mm, min(widest + 3 * mm, 46 * mm))
    name_w = inner_w / 2 - check_w - time_w - 3 * mm

    def cells(p: PersonalRowIn | None) -> list:
        if p is None:
            return ["", "", ""]

        # each end is coloured on its own: a recorded arrival next to a derived departure has
        # to read as exactly that, so the two are not one string in one colour any more
        def stamp(v: str | None, derived: bool) -> str:
            if not v:
                return f'<font color="{_DERIVED}">{_TIME_STUB}</font>'
            return f'<font color="{_DERIVED}">{_esc(v)}</font>' if derived else _esc(v)

        # a non-breaking space around the dash: the column is sized for one line, and a break
        # inside «02.08. 14:41 – 04.06. 11:00» would put it back onto two
        vonbis = (
            f'{stamp(p.von, p.vonDerived)}&nbsp;<font color="{_DERIVED}">–</font>&nbsp;{stamp(p.bis, p.bisDerived)}'
        )
        name = _esc(p.name) if p.name else _LINE_STUB
        if p.note:
            name += f'<br/><font size="6.5" color="#5b6472">{_esc(p.note)}</font>'
        return [
            Paragraph("<b>X</b>" if p.erfasst else "", st["check"]),
            Paragraph(name, st["rcell"]),
            Paragraph(vonbis, st["rcell"]),
        ]

    def column(people: list[PersonalRowIn]) -> Table:
        style: list[tuple] = [
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 1.8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1.8),
            ("LEFTPADDING", (0, 0), (-1, -1), 1),
            # breathing room between the checkbox square and the name (jsPDF gap ~1.6mm);
            # the check cells lose ALL side padding so the X centers in its square
            ("LEFTPADDING", (1, 0), (1, -1), 5),
            ("LEFTPADDING", (0, 0), (0, -1), 0),
            ("RIGHTPADDING", (0, 0), (0, -1), 0),
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ]
        for r, p in enumerate(people):
            style.append(("BOX", (0, r), (0, r), 0.5, _WRITE))  # the checkbox square
            if not p.name:
                style.append(("LINEBELOW", (1, r), (1, r), 0.5, _WRITE, 1, (0.8, 0.8)))  # guest write-in
        t = Table([cells(p) for p in people] or [["", "", ""]], colWidths=[check_w, name_w, time_w])
        t.setStyle(TableStyle(style))
        return t

    # a shared row meant one person's remark set the height for whoever happened to sit opposite
    # them, and from there down the two halves no longer shared a baseline
    return _two_up(personal, column, check_w + name_w + time_w)


# Up to this many Beilagen print as full plates; beyond it they become a contact sheet. The
# number is the point where nobody reads plate 30 anyway — 50 large plates are ~20 sheets
# appended to a 2-page rapport, and the signed part disappears behind a photo stack.
_ATT_PLATE_MAX = 8


def _attachment_block(
    att: list[tuple[AttachmentIn, bytes]],
    inner_w: float,
    st: dict[str, ParagraphStyle],
    labels: dict[str, str],
) -> Table:
    """Beilagen, laid out for the number of them there actually are.

    A handful print LARGE — the reason to photograph a driving licence is to read it off the
    paper afterwards. Many print as a numbered contact sheet: at 50 photos nobody reads plate 30,
    and what the paper is for becomes «which pictures exist», which a thumbnail answers.

    Either way each carries its number «B7», so the Verlauf, a phone call and the paper can all
    name the same picture.
    """
    grid = len(att) > _ATT_PLATE_MAX
    cols, cell_h = (3, 62 * mm) if grid else (1, 92 * mm)
    gutter = 4 * mm
    cell_w = (inner_w - gutter * (cols - 1)) / cols
    img_w = cell_w if grid else inner_w * 0.62

    def cell(i: int, a: AttachmentIn, data: bytes):
        caption = Paragraph(f"<b>B{i}</b> · {_esc(a.caption or labels['attachmentNoCaption'])}", st["muted"])
        img = _fit_image(data, img_w, cell_h)
        if img is None:
            return [caption]
        img.hAlign = "LEFT"  # share a left edge with the caption underneath
        if not grid:
            return [img, Spacer(1, 3), caption]
        # ⚠️ On a contact sheet the pictures are NOT the same height — a portrait Ausweis next to
        # a landscape damage shot — so a plain stack put every caption at its own height and the
        # row read as scattered. A fixed picture box bottom-aligns them onto one shelf and puts
        # every caption in the row on the same line.
        box = Table([[img], [caption]], colWidths=[cell_w], rowHeights=[cell_h, None])
        box.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (0, 0), "BOTTOM"),
                    ("VALIGN", (0, 1), (0, 1), "TOP"),
                    ("TOPPADDING", (0, 0), (-1, -1), 0),
                    ("BOTTOMPADDING", (0, 0), (0, 0), 3),
                    ("BOTTOMPADDING", (0, 1), (0, 1), 0),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ]
            )
        )
        return [box]

    cells: list = [cell(i, a, d) for i, (a, d) in enumerate(att, start=1)]
    rows = [cells[r : r + cols] for r in range(0, len(cells), cols)]
    rows[-1] = rows[-1] + [""] * (cols - len(rows[-1]))  # pad the tail row out to `cols`
    t = Table(rows, colWidths=[cell_w] * cols)
    t.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                # the gutter rides on the right of every cell but the last in its row
                *[("RIGHTPADDING", (c, 0), (c, -1), gutter if c < cols - 1 else 0) for c in range(cols)],
            ]
        )
    )
    return t


def _partner_table(
    listed: list[tuple[str, PartnerContact | None]], inner_w: float, st: dict[str, ParagraphStyle]
) -> Table:
    """Two-up Partnerliste: [☐|Organisation|Bemerkung] × 2, the same shape as the roster.

    Box · Organisation · one free line — the same three things the app asks for. The old
    Name/Telefon columns were almost always empty and pushed the remark to the far edge, where it
    read as belonging to nothing; whatever is worth noting («Wm. Keller, Verkehr ab Kreisel») goes
    in the one line and sits right next to its organisation.
    """
    check_w = 4 * mm
    col_w = inner_w / 2 - 1.5 * mm
    org_w = (col_w - check_w) * 0.42

    def column(part: list[tuple[str, PartnerContact | None]]) -> Table:
        rows = [
            [
                Paragraph(("<b>X</b>" if c else ""), st["check"]),
                Paragraph(_esc(org), st["rcell"] if c else st["muted"]),
                Paragraph(_esc(" · ".join(x for x in (c.name, c.phone, c.note) if x)) if c else "", st["rcell"]),
            ]
            for org, c in part
        ]
        style: list[tuple] = [
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 2.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
            ("LEFTPADDING", (0, 0), (-1, -1), 1),
            ("LEFTPADDING", (1, 0), (1, -1), 5),
            ("LEFTPADDING", (0, 0), (0, -1), 0),
            ("RIGHTPADDING", (0, 0), (0, -1), 0),
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
            # An EMPTY SQUARE on every row, not just a printed X on the ticked ones: the rapport
            # gets corrected on paper as often as on screen, and an organisation that turns out
            # to have been there needs somewhere to put the tick.
            *[("BOX", (0, r), (0, r), 0.5, _WRITE) for r in range(len(rows))],
            *[("LINEBELOW", (0, r), (-1, r), 0.4, _GRID) for r in range(len(rows))],
        ]
        t = Table(rows or [["", "", ""]], colWidths=[check_w, org_w, col_w - check_w - org_w])
        t.setStyle(TableStyle(style))
        return t

    return _two_up(listed, column, col_w)


def _mittel_table(mittel: list[MittelFormRowIn], inner_w: float, st: dict[str, ParagraphStyle]) -> Table:
    """Two-up Material worksheet: label + «______ Stk» amount stub / bold recorded amount."""
    amt_w = 26 * mm
    label_w = inner_w / 2 - amt_w - 3 * mm

    def cells(row: MittelFormRowIn | None) -> list:
        if row is None:
            return ["", ""]
        amt = f"{_esc(row.menge)} {_esc(row.unit)}" if row.menge else f"______ {_esc(row.unit)}"
        # the remark rides UNDER the label, small: «3 Sack» says how much, «an Werkhof
        # übergeben» says what happened to it, and only the second one is worth reading twice
        label = _esc(row.label)
        if row.note:
            label += f'<br/><font size="6.5" color="#5b6472">{_esc(row.note)}</font>'
        return [Paragraph(label, st["rcell"]), Paragraph(amt, st["ramt"] if row.menge else st["rstubr"])]

    def column(rows_in: list[MittelFormRowIn]) -> Table:
        t = Table([cells(r) for r in rows_in] or [["", ""]], colWidths=[label_w, amt_w])
        t.setStyle(
            TableStyle(
                [
                    # amounts hang on the RIGHT edge: «1 Stk» and «______ Stk» are read as a
                    # column of quantities, and a recorded amount that started where its label
                    # happened to end sat at a different x on every row. TOP, not MIDDLE — a
                    # three-line remark under the label must not drag the amount down with it.
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("TOPPADDING", (0, 0), (-1, -1), 1.8),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 1.8),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ]
            )
        )
        return t

    # ⚠️ Each half is its OWN table inside one outer row. Sharing rows across the fold meant a
    # material with a four-line remark stretched the row on the FAR side too, and from there
    # down the two columns no longer sat on the same baselines — the sheet looked broken even
    # though every value was right. Independent columns simply flow past each other.
    return _two_up(mittel, column, label_w + amt_w)


def _check_grid(
    items: list[str], ticked: set[str], inner_w: float, st: dict[str, ParagraphStyle], cols: int = 3
) -> Table:
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
                row.extend(
                    [
                        Paragraph("<b>X</b>" if items[i] in ticked else "", st["check"]),
                        Paragraph(_esc(items[i]), st["cell"]),
                    ]
                )
                style.append(("BOX", (c * 2, r), (c * 2, r), 0.5, _WRITE))
            else:
                row.extend(["", ""])
        rows.append(row)
    t = Table(rows, colWidths=[check_w, label_w] * cols)
    t.setStyle(TableStyle(style))
    return t


def _table_style() -> TableStyle:
    return TableStyle(
        [
            ("GRID", (0, 0), (-1, -1), 0.4, _GRID),
            ("BACKGROUND", (0, 0), (-1, 0), _PANEL),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ]
    )

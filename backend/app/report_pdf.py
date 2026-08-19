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
import re

from pydantic import BaseModel, field_validator, model_validator
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


#: Helvetica has no glyph for a pictograph, so ReportLab draws a black box — and only on the
#: PAPER, which is where nobody sees it until it is in their hand. The app blocks these where
#: text is typed (`src/lib/format.ts` · stripUnprintable), but that reach stops at text WE own:
#: the Stichwort, the Kategorie and the address arrive from the alerting system exactly as the
#: ELZ wrote them, and nobody at this station can edit them in a field the guard covers. Those
#: are stripped here instead. Everything a human typed keeps the input-side guard — a rapport
#: must print what was written, not a version of it this file decided on.
_PICTOGRAPHS = re.compile(
    "[\U0001f000-\U0001faff\u2190-\u21ff\u2300-\u27bf\u2b00-\u2bff\ue000-\uf8ff\ufe00-\ufe0f\u200d\u20e3]"
)


def _strip_pictographs(v: str | None) -> str | None:
    """Drop emoji/dingbats and the joiners that glue them together, then close the gap.

    A value that is NOTHING BUT pictographs is left alone: a sheet whose Stichwort prints as a
    box is bad, a sheet whose Stichwort is blank is worse — the box at least says something was
    sent. Emptying a field is never the better answer on a form that gets signed.
    """
    if not v:
        return v
    return re.sub(" {2,}", " ", _PICTOGRAPHS.sub("", v)).strip() or v.strip()


class PartnerContact(BaseModel):
    org: str | None = None
    name: str | None = None
    phone: str | None = None
    note: str | None = None


class ReportMetaIn(BaseModel):
    #: dispatch text, not ours to edit — see _strip_pictographs
    _no_emoji = field_validator("alarmText")(_strip_pictographs)

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
    #: ⚠️ Stichwort, Kategorie and Adresse come from the ELZ verbatim — see _strip_pictographs.
    #: The title is set 20pt at the top of the sheet, so a box there is the loudest one there is.
    _no_emoji = field_validator("title", "type", "address")(_strip_pictographs)

    title: str
    type: str | None = None  # the Einsatz KATEGORIE (wizard «Kategorie»); the Stichwort is `title`
    address: str | None = None
    id: str
    #: An Übung must be legible AS an Übung on the paper. It is excluded from the statistics, so
    #: a drill rapport that looks like a deployment puts paper and data in disagreement — and
    #: nothing else on the sheet distinguishes the two.
    isExercise: bool = False
    #: The number WinFAP and the cantonal statistics are joined on — the alerting system's own
    #: reference for the alarm («fwo-sms-761610d931ac»), whose short form is its FIRST four hex.
    #: Filled server-side in ``api.report.compose_report_from_payload``, never by the client:
    #: the pool row that carries it is the authority, and a number typed into WinFAP from this
    #: sheet has to be the one the exporter sends.
    alarmRef: str | None = None


class JournalRowIn(BaseModel):
    timeLabel: str
    area: str
    text: str
    #: The entry with its linked terms wrapped in ``<b>`` — people, Mittel, Partnerorganisationen,
    #: Fahrzeuge, Alarmgruppen (see src/lib/journalLinks). Absent when nothing was linked, and
    #: then ``text`` prints verbatim as it always did.
    #:
    #: ⚠️ Already escaped by the client, because only the client can tell its own markup from an
    #: «&» somebody typed. It is therefore NOT run through ``_esc`` again here.
    markup: str | None = None
    transcript: str | None = None
    #: a memo transcribed in SECTIONS — one pre-formatted line per section, offset-prefixed
    #: («0:05  Rückzug eingeleitet»). Preferred over ``transcript`` when present; that field
    #: still carries the joined words so an older server prints something.
    transcriptLines: list[str] = []
    #: A corrected line prints as latest wording + a muted «korrigiert HH:MM · ursprünglich: …»
    #: sub-line — the record's first wording; intermediate revisions stay unprinted (the journal
    #: store keeps them all, the paper shows where it started and where it ended, 19.08.).
    correctedAt: str | None = None  # client-formatted HH:MM of the LAST correction
    textOriginal: str | None = None
    photoKey: str | None = None  # legacy: figure key of a client-uploaded photo
    photoUrl: str | None = None  # single photo — the shape rows written before 2026-08-06 carry
    #: several photos on one row (one damage is rarely one picture). Readers take both.
    photoUrls: list[str] = []


class PendenzNoteIn(BaseModel):
    """One Meldung on an open item — an indented sub-line under its «Was»."""

    timeLabel: str
    text: str


class PendenzRowIn(BaseModel):
    """One Auftrag / Pendenz, derived by the client from the append-only journal.

    The columns are the BGV form's (KKO BS / KFS BL 2022-09 «AUFTRÄGE / PENDENZEN»): Was · Wer ·
    Erteilt · Erledigt. Two of them fall out of the record for free — ``erteilt`` is the entry's
    own timestamp, ``erledigt`` the timestamp of the row that closed it — which is why this prints
    without anybody filling a form in.

    ⚠️ No Prio COLUMN. Priority is two-state, so a column for it would be blank on almost every
    row while taking the width «Was» needs; ``urgent`` prints as a short marker before the text
    instead, where the reading actually happens.
    """

    text: str
    #: «Wer» — the first vocabulary name in the sentence, not a field anybody filled in
    assignee: str | None = None
    urgent: bool = False
    erteilt: str  # client-formatted HH:MM (or the full stamp when the Einsatz spans days)
    #: absent ⇒ still open at the Einsatzende, and the cell prints «offen». That is the whole
    #: point of the section: what somebody still has to take away from the incident.
    erledigt: str | None = None
    #: HH:MM of the Erinnerung, when the item carried one — the latest Wiedervorlage, the same
    #: value the pinned block runs on. Prints as a sub-line under «Was»; a column would be blank
    #: on every untimed row (same reasoning as Prio above).
    faellig: str | None = None
    notes: list[PendenzNoteIn] = []


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
    #: Sent by the client, deliberately NOT printed: a rapport is written after the fact, and
    #: «Im Einsatz» on a finished Einsatz asserts something that stopped being true before the
    #: sheet came out of the printer. Optional so a client may stop sending it.
    statusLabel: str = ""
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


#: What a remark may occupy ON PAPER, which is a different question from what will crash the
#: composer. `_NOTE_MAX` is the crash guard; at 400 characters a remark still wraps to four lines
#: of 6.5pt in a ~62mm label column, and one such row measured 45pt tall against 13.6pt
#: neighbours — it stretched its own column's rhythm so far that the two halves of the Material
#: block visibly stopped sharing baselines. Two lines is what the row can carry.
_NOTE_PRINT_MAX = 110


def _clip_print(v: str) -> str:
    """Clamp a remark to what fits two printed lines. Never rejects — printing must not depend
    on what somebody typed (form model 2026-07-17); the full text lives in the workspace."""
    return v if len(v) <= _NOTE_PRINT_MAX else v[: _NOTE_PRINT_MAX - 1].rstrip() + "…"


def _alarm_ref_text(ref: str | None) -> str:
    """«7616 · fwo-sms-761610d931ac» — the short form first, because that is the one that
    gets typed into WinFAP's Schadenfall-Nr, then the full reference so the printed slip and
    this sheet can be checked against each other. The short form is the FIRST four hex of
    the suffix, which is what fwo-divera prints on the slip."""
    if not ref:
        return ""
    suffix = ref.rsplit("-", 1)[-1]
    short = suffix[:4] if len(suffix) >= 4 else ""
    return f"{short} · {ref}" if short else ref


#: Cell padding for the pen-writable tick-off/worksheet tables (Personal, Partner, Material).
#: They carried 2.8 / 2.5 / 1.8 — three paddings for one row type, so two visually identical
#: tick-off blocks on the same sheet came out at a 15.0 and a 15.6pt pitch.
_PAD_ROW = 2.8


class PersonalTimeIn(BaseModel):
    """One stretch a person was on scene. Clocks are client-formatted HH:MM (or «02.08. 14:41»
    once the Einsatz runs past midnight)."""

    von: str | None = None
    bis: str | None = None
    #: this clock was DERIVED from the incident's bounds, not recorded by anybody — printed grey
    #: so a signed sheet says which times were measured and which the app worked out. A line that
    #: is grey on both ends is one nobody has to check.
    vonDerived: bool = False
    bisDerived: bool = False


class PersonalRowIn(BaseModel):
    """ONE row per person on the Personal-/Soldblatt, however many times they came and went:
    printed tick when digitally recorded, blank checkbox + write-in stubs otherwise."""

    name: str
    erfasst: bool = False
    #: every stretch, stacked in the time column. It used to be one ROW per stretch, so somebody
    #: who left and came back printed their name twice and was counted twice by anyone reading
    #: down the roster — the sheet answers «who was here», and a name is a person, not a shift.
    times: list[PersonalTimeIn] = []
    #: legacy single-stretch fields, kept so a payload queued by an older client (a print job
    #: waiting in the relay across a deploy) still composes. Folded into `times` on validation.
    von: str | None = None
    bis: str | None = None
    vonDerived: bool = False
    bisDerived: bool = False
    #: free remark on this person for this Einsatz («Fahrer TLF», «abgelöst 21:40») — printed
    #: small under the name, once, because it belongs to the person and not to a stretch
    note: str | None = None
    #: not on the Mannschaftsliste — a Gast, a Nachbarwehr, somebody not yet synced. Printed as a
    #: «Gast» mark behind the name, because the sheet is read weeks later by somebody who cannot
    #: ask: an unmarked guest sitting among our own roster reads as one of ours.
    guest: bool = False

    _clip = field_validator("note")(_clip_note)

    @model_validator(mode="after")
    def _fold_legacy(self) -> PersonalRowIn:
        if not self.times and (self.von or self.bis):
            self.times = [
                PersonalTimeIn(von=self.von, bis=self.bis, vonDerived=self.vonDerived, bisDerived=self.bisDerived)
            ]
        return self


class PlanRef(BaseModel):
    key: str  # figure key
    label: str
    landscape: bool = False


class MittelFormRowIn(BaseModel):
    """One Material worksheet row: the full catalogue prints with amount stubs, recorded
    amounts print bold (client merges catalogue + recorded lines)."""

    label: str
    menge: str | None = None  # client-formatted "3" — None prints the write-in stub
    unit: str = "Stk."
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
    #: «Aufträge / Pendenzen». ⚠️ Its OWN switch, not part of `journal`: suppressing the long
    #: Einsatzjournal is a normal choice, and the outstanding items are the last thing that should
    #: disappear with it. Defaults True so an older client that sends no option still prints them.
    pendenzen: bool = True


class PersonalSummaryIn(BaseModel):
    """Anwesende + Einsatzstunden, computed CLIENT-side where the ISO timestamps are.

    The rows print «19:12 – 21:40»; re-deriving minutes from that formatted clock text here
    would be a second answer that can disagree with the app's. ``hours`` is the raw sum — what
    actually happened — and ``hoursRounded`` the Sold figure (each person rounded up to the next
    ``stepMin`` block once ``graceMin`` past the previous one, then summed).

    The rule itself is deliberately NOT printed (see the ``personalTotals`` label below and
    ``docs/CONFIGURATION.md`` §1b) — it is identical on every rapport a station produces. It used
    to travel here as ``stepMin``/``graceMin`` for a line that was never written; the fields are
    gone rather than left as two numbers nothing reads.
    """

    present: int = 0
    hours: str = ""
    hoursRounded: str = ""
    #: people whose blocks could not be totalled (an end before its start — most often an open
    #: block borrowing an implausible Einsatzende). They are in NEITHER sum, so the sheet has to
    #: say so: a total that quietly leaves people out is worse than one that admits it.
    unresolved: int = 0


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
    # What «überfällig» MEANT on this Einsatz. The Atemschutz protocol is read to judge the
    # contact log — was a gap acceptable, when did the board go red — and that judgement is
    # against an interval the paper never named. It is a per-incident setting on top of a
    # per-station one, so it cannot be looked up afterwards: it travels with the document.
    atemschutzIntervalMin: int | None = None
    atemschutzGraceSec: int | None = None
    # Personal-/Soldblatt: the FULL roster (recorded people ticked), guests appended
    personal: list[PersonalRowIn] = []
    # Material worksheet: full catalogue with stubs, recorded amounts filled
    mittelForm: list[MittelFormRowIn] = []
    # Partnerorganisationen presets — tick-off row when none were recorded digitally
    partnerPresets: list[str] = []
    personalSummary: PersonalSummaryIn | None = None
    journal: list[JournalRowIn] = []
    #: Aufträge / Pendenzen — printed right after the Verlauf they are derived from, so a reader
    #: checking one line only turns back a page.
    pendenzen: list[PendenzRowIn] = []
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
    # «Fotos», not «Beilagen»: the upload takes `image/*` and nothing else, and the app says
    # Foto at every other step («Foto hinzufügen», «Bildlegende»). A heading that promises a
    # Beilage the surface cannot accept is a heading that has to be explained.
    "attachments": "Fotos",
    "summary": "Kurzbericht / durchgeführte Arbeiten",
    "lehren": "Lehren / Sicherheit",
    "remarks": "Bemerkungen",
    "partnerOrgs": "Partnerorganisationen",
    "partnerOther": "Weitere",
    "kroki": "Kroki",
    "atemschutz": "Atemschutzüberwachung",
    # printed under the heading, so the contact log can be judged against the rule it ran on
    "azInterval": "Funkkontakt-Intervall: {n} min · überfällig ab +{g} min",
    "azIntervalNoGrace": "Funkkontakt-Intervall: {n} min",
    # the house term (copy · atemschutz.memberLabel); «Mitglieder» reads like a club. Numbered
    # per row so the sheet names the Trupp exactly the way the form that filled it does.
    "memberN": "AdF {n}",
    "auftrag": "Auftrag / Ziel",
    "line": "Leitung",
    "entry": "Eintritt",
    "exit": "Austritt",
    # A Sicherungstrupp that stood ready and was stood down never entered anything, so it has no
    # «Eintritt» and its stamp is not an «Austritt». Printed as its own row — the sheet is the
    # legal account, and a crew that was under PA and one that was not are different facts.
    "notDeployed": "Nicht eingesetzt",
    "colTime": "Zeit",
    "colKind": "Art",
    "colPressure": "Druck bar",
    "noPressureLog": "Kein Druckverlauf erfasst.",
    "personal": "Personal / Anwesenheit",
    # the app's own word for it (copy · anwesenheit.guestBadge) — one thing, one name for it,
    # on the screen and on the paper
    "guest": "Gast",
    # On a RUNNING Einsatz there is no Einsatzende, so no block can be totalled — the sheet then
    # says the one thing it knows (how many were there) instead of «0:00 · gerundet 0:00» plus a
    # paragraph explaining why both are nothing. The rounding rule is not printed at all: it is
    # the same rule on every rapport a station prints, and it belongs in the Weisung, not on
    # every sheet next to the two numbers anybody actually transfers.
    "personalCount": "<b>{n} Anwesende</b>",
    "personalTotals": "<b>{n} Anwesende</b> · Einsatzstunden <b>{h}</b> · gerundet <b>{r}</b>",
    "journal": "Einsatzjournal",
    # Aufträge / Pendenzen — the column headings are word-for-word the BGV form's, so whoever
    # knows the paper finds their way on the print without being told it is the same thing.
    "pendenzen": "Aufträge / Pendenzen",
    "colWas": "Was",
    "colWer": "Wer",
    "colErteilt": "Erteilt",
    "colErledigt": "Erledigt",
    "pendenzOpen": "offen",
    "pendenzUrgent": "dringend",
    "colArea": "Bereich",
    "colEntry": "Eintrag",
    "transcript": "Transkript",
    # a corrected row: latest wording above, this line says when and what it started as —
    # the printed counterpart of the app's «korrigiert HH:MM»-chip + «Der ursprüngliche
    # Wortlaut bleibt im Protokoll»
    "correctedLine": "korrigiert {t} · ursprünglich: «{text}»",
    # sub-line under «Was» when an Auftrag / eine Pendenz carried a timed Erinnerung
    "pendenzDue": "fällig {t}",
    "noEntries": "Keine Einträge.",
    "signoff": "Unterschriften",
    "sigOrtDatum": "Ort, Datum",
    "sigKommandant": "Kommandant",
    "generatedAt": "Erstellt",
    "mittel": "Material",
    # «Gerettet», not «Gerettete»: the box is a form label followed by what was rescued
    # («Gerettet: 2 Personen»), not a noun standing on its own.
    "gerettete": "Gerettet",
    "alarmRef": "Einsatz-Nr",
    "rueckmeldungElz": "Rückmeldung ELZ",
    "zeiten": "Alarmierungs- / Ausrückzeiten",
    "erfasser": "Erfasst durch",
}

# two underscores per side: Helvetica digits and «_» share the same 556/1000 advance,
# so a blank stub lines up column-exact with a machine-filled HH:MM next to it
_TIME_STUB = "__:__"
_LINE_STUB = " "  # write-in rows: empty cell, the ruled underline is the affordance
#: THE write-in texture for the whole sheet: a fine dotted leader. It already carried the
#: details box, Kontaktperson, Rückmeldung ELZ, Gerettet and the Kurzbericht lines; the roster
#: clocks and the Material amounts join it, so «hier schreiben» looks the same everywhere
#: instead of being underscores in one block and dashes in the next.
_WRITE_DASH = (1, (0.8, 0.8))


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
            # the rule under it carries the same flag — see head()
            keepWithNext=1,
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
        # a Meldung under its Pendenz: indented and quieter, so the item's own «Was» still reads
        # as the line and the updates read as what came back on it
        "subline": ParagraphStyle(
            "rp_subline", parent=base["Normal"], fontSize=8, leading=10.5, textColor=dim, leftIndent=8
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
        # The unit sits in its own column beside the amount, so «Stk» / «Sack» / «l» form one
        # column and the write-in rule beside them is one width — see _mittel_table.
        "runit": ParagraphStyle("rp_runit", parent=base["Normal"], fontSize=8.5, leading=10, textColor=dim),
        # the dash between «von» and «bis», centred in its own narrow column so it lands on
        # one x down the whole roster — see _personal_table
        "rdash": ParagraphStyle(
            "rp_rdash", parent=base["Normal"], fontSize=8.5, leading=10, textColor=dim, alignment=TA_CENTER
        ),
        # A remark is its OWN paragraph, not an inline <font size="6.5"> inside the label. Inline,
        # it inherited the label's 10pt leading — 3.5pt of lead on a 6.5pt face against 1.5pt on
        # the 8.5pt name above it — so a remark hung away from the line it belongs to and the
        # amount beside it aligned with neither. Its own style also gets it its own colour, which
        # was hardcoded twice as #5b6472 against the #5b6573 every other dim thing uses.
        "rnote": ParagraphStyle(
            "rp_rnote", parent=base["Normal"], fontSize=6.5, leading=8, spaceBefore=1, textColor=dim
        ),
    }


_GRID = colors.HexColor("#d7dde5")
_PANEL = colors.HexColor("#eef2f7")
#: the «!» that marks a dringende Pendenz. Dark enough to survive a monochrome
#: printer as a solid mark rather than a grey smudge — most station printers are one.
_URGENT = "#b21f14"
_WRITE = colors.HexColor("#969696")  # write-in dotted leaders/stubs (jsPDF gray 150)
#: a clock the app derived rather than one somebody recorded — same grey as a write-in stub,
#: because both mean «this is not a measured value»
_DERIVED = "#969696"
_INK = colors.HexColor("#141414")  # form ink (jsPDF gray 20)
#: the dim ink every secondary line uses (styles · dim), as a string for inline <font> markup
_DIM_INK = "#5b6573"
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

    def __init__(self, width: float, rows: list[list[dict]], boxed: bool = False, pitch: float = 8.5 * mm):
        super().__init__()
        self.width = width
        self.rows = rows
        self.boxed = boxed
        self.pitch = pitch
        self.pad = 3 * mm if boxed else 0
        # ⚠️ The TOP pad is smaller than the bottom one, and that is what makes them look equal.
        # Each row's text hangs at the BOTTOM of its own pitch slot, so the first row already
        # carries most of a slot of empty air above it: measured, the gap under the box's top rule
        # was 19pt against 13.4pt over the bottom one and 15.2pt between rows — the box read as
        # top-heavy, with «Kategorie» pushed away from the edge it belongs to.
        self.pad_top = max(0.0, self.pad - 5) if boxed else 0
        self.height = len(rows) * self.pitch + self.pad + self.pad_top - (2.5 * mm if not boxed else 0)

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
            y = self.height - self.pad_top - (i + 1) * self.pitch + 2.4 * mm  # text baseline
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
                    # value that is already printed.
                    #
                    # A SIGNATURE field always gets its rule, printed value or not — that is the
                    # only way it differs. It is drawn ON THE ROW'S OWN LINE and STARTS WHERE THE
                    # VALUE ENDS, so the whole thing reads as one line: «Einsatzleiter: Anna Meier
                    # ________». It used to hang a full writing height below the row, which put
                    # two rules at two heights in every Visum row and left the lower one nearer
                    # the NEXT row's «Ort, Datum» label than the name it belonged to. Signing
                    # happens on the rule, next to the name, exactly as «Ort, Datum: ____» works
                    # two centimetres to its left.
                    sig = bool(f.get("sign"))
                    rule_y = y - 0.6 * mm
                    shown = ""
                    if value:
                        c.setFont("Helvetica", 9)
                        shown = _fit_text(c, value, w - (lx - x) - 4 * mm)
                    if not value or sig or f.get("line"):
                        # start clear of whatever is already printed, so the rule is somewhere to
                        # write rather than an underline through the name
                        start = lx + (_str_w(shown, "Helvetica", 9) + 2 * mm if shown else 0)
                        c.saveState()
                        c.setStrokeColor(_WRITE)
                        c.setLineWidth(0.5)
                        c.setDash(0.8, 0.8)
                        c.line(start, rule_y, x + w - 2 * mm, rule_y)
                        c.restoreState()
                    if shown:
                        c.setFont("Helvetica", 9)
                        c.setFillColor(_INK)
                        c.drawString(lx, y, shown)
                x += w
                offset += w


#: Letterhead size for the station logo — tall enough to be recognised, short enough that the
#: incident title stays the first thing read on the page.
#:
#: Raised from 13mm on 09.08.: the mark sat against a title AND a subtitle line hung under it at
#: the page margin, so it read as the smallest thing in its own letterhead. With the subtitle
#: moved into the title cell the head is one two-line block ≈17mm tall, and the mark matches it.
_LOGO_H = 17 * mm
_LOGO_MAX_W = 60 * mm


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
#: ⚠️ Raised 30 % on 18.08. The picture is placed ~180 mm wide, so 1000 px was 141 dpi — every
#: glyph edge and every number on the Kroki was softer on paper than the same picture on screen,
#: which is most of what «das PDF sieht schlechter aus» actually was. 1300 px ≈ 183 dpi, still
#: within what the compositor can hold (it draws at `supersample` × these numbers).
#: ⚠️ This does NOT make symbols bigger relative to the frame — `ref_width` scales the drawing
#: rules with the render, on purpose, so the proportions stay the app's. The size lever is
#: `kroki_symbol_mul`.
_KROKI_PX = (2080, 1222)
#: the same crop turned upright — a portrait Kroki page gets a portrait render, so the picture
#: fills the sheet instead of being letterboxed into a landscape frame
_KROKI_PX_PORTRAIT = (1300, 1820)


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

    def head(text: str) -> list:
        """Section heading matching the Erfassungsblatt: bold line + solid dark rule.

        ⚠️ It used to reserve 26mm with a CondPageBreak, which cannot be right: the reserve is
        measured BEFORE the heading is laid out, the heading block itself eats 38pt of it, and the
        first content of Personal/Material/Partner is a two-up outer row — one indivisible
        flowable whose height depends on the roster. «Partnerorganisationen» duly printed as the
        last thing on page 1 with every one of its rows on page 2.
        keepWithNext on the heading AND its rule makes ReportLab bundle heading + rule + the next
        flowable into a KeepTogether, so a heading can never be the last thing on a page whatever
        follows it. A block taller than a full frame still splits normally — KeepTogether.split()
        hands the content back unchanged when it does not fit anywhere.
        """
        hr = HRFlowable(
            width="100%",
            thickness=1.1,
            color=colors.HexColor("#282828"),
            spaceBefore=0,
            # 7, not 10: the rule needs a little air under it for the hand that writes against
            # it, but a form that floats reads as unfinished and costs a page.
            spaceAfter=7,
            lineCap="butt",
        )
        hr.keepWithNext = 1
        return [Paragraph(_esc(text), st["h2"]), hr]

    def write_lines(n: int, row_h: float = 8 * mm) -> Table:
        """N dotted write-in lines (the Erfassungsblatt's Notizen look).

        The FIRST row is short by the heading's own `spaceAfter`, so the first rule sits the same
        distance under the heading as the following rules sit under each other. At a full row it
        carried the heading gap AND a whole writing height, which made the block start with a
        visibly wider band than it ever repeats — the section looked like it began with a blank.
        """
        heights = [row_h - 7, *[row_h] * (n - 1)] if n else []
        t = Table([[Paragraph(_LINE_STUB, st["body"])] for _ in range(n)], colWidths=[inner_w], rowHeights=heights)
        t.setStyle(
            TableStyle(
                [
                    ("LINEBELOW", (0, 0), (-1, -1), 0.5, _WRITE, *_WRITE_DASH),
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
    # An Übung says so ABOVE the title, before anything else is read. It is the one fact that
    # changes what the whole document is, and it is excluded from the statistics — a drill
    # rapport that reads like a deployment is a record that contradicts the numbers.
    if payload.incident.isExercise:
        story.append(Paragraph(_esc(L["exercise"]), st["exercise"]))
    title = Paragraph(_esc(payload.incident.title), st["title"])
    # ⚠️ NO Einsatz-ID here. It was this app's own incident UUID, shortened for display — it joins
    # nothing in WinFAP, and printing a number-looking thing beside the one that DOES join is how
    # the wrong one gets typed into the case-number field. The Einsatz-Nr is in the details box
    # below, where somebody filling in a form reads.
    footer_bits = [f"{L['generatedAt']}: {payload.generatedAt}"]
    # The join number rides HERE, on the line under the title, rather than in the details box: it
    # is not a fact about the Einsatz the way an address or an Einsatzleiter is — it is the
    # handle this sheet is filed under, which is what the rest of this line already carries.
    if payload.incident.alarmRef:
        footer_bits.append(f"{L['alarmRef']}: {_alarm_ref_text(payload.incident.alarmRef)}")
    if m.erfasser:
        footer_bits.append(f"{L['erfasser']}: {m.erfasser}")
    subtitle = Paragraph(_esc(" · ".join(footer_bits)), st["muted"])

    logo = _logo_flowable(figures.get("logo"))
    if logo is None:
        story.append(title)
        story.append(subtitle)
    else:
        # Mark and title on ONE line, the way a letterhead reads. Stacked, the logo pushed the
        # Einsatz — the thing the sheet is about — a third of the way down the page, and the two
        # read as separate blocks rather than as one heading.
        #
        # The «Erstellt: …» line goes INSIDE the title cell rather than full-width underneath it
        # (09.08.): hung at the page margin it started under the LOGO, so the mark had a caption
        # it does not have and the two blocks stopped lining up. Stacked with the title it is
        # what it is — a subtitle — and the letterhead becomes one block of two lines, which is
        # also what let the mark grow (see _LOGO_H).
        lw = logo.drawWidth + 5 * mm
        head_tbl = Table([[logo, [title, subtitle]]], colWidths=[lw, inner_w - lw])
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
        story.append(head_tbl)
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
        # ⚠️ An unrecorded time is a dotted RULE, like every other write-in field on the sheet.
        # It was «__:__» — the sheet's second «write here» texture, and the two sat a few
        # centimetres apart: the Zeiten grid in underscores, the roster clocks right below it in
        # dotted leaders. Underscores also never line up with the digits of a filled row, since
        # Helvetica's «_» is narrower than its figures, so a column of half-filled times came out
        # ragged. One texture; see the roster and the Material amounts.
        # ⚠️ VALUE first, then its label. The grid is 3-up, so with the label first each rule
        # ended up sitting BETWEEN its own label and the next column's — «Gr. 1 (Rot) ____
        # Tagespikett» reads as if the line belonged to Tagespikett. Value-first puts every rule
        # immediately in front of the thing it is the time for, which is the one arrangement
        # that cannot be misread (09.08., after trying it the other way round).
        zrows = [
            [Paragraph(_esc(val), st["cell"]) if val else None, Paragraph(_esc(lab), st["cell"])]
            for lab, val in m.zeiten
        ]
        # 3-up columns to keep the grid compact
        cols = 3
        n_rows = -(-len(zrows) // cols)
        cw = inner_w / cols
        # ⚠️ The value column is sized to what it HAS TO HOLD, not to a fixed third of the cell.
        # A bare «22:47» fits 0.32 of a 3-up column; «08.08. 22:47» — which is what every clock
        # on the sheet reads once the Einsatz runs past midnight (lib/report · spanAwareClock) —
        # does not, so every row broke onto two lines with the date orphaned above the time, and
        # the empty ones showed a write-in rule the width of a dash (08.08. Einsatz). Measured,
        # then clamped: a stray long value must not eat the label beside it either.
        widest_val = max((_str_w(val, "Helvetica", 9) for _, val in m.zeiten if val), default=0.0)
        val_pad = 6  # the RIGHTPADDING below, which the text cannot use
        # the floor keeps the write-in rule a field somebody can write a date into, on a sheet
        # where nothing has been recorded at all and there is no value to measure
        val_w = min(max(widest_val + val_pad + 2, cw * 0.34), cw * 0.58)
        # an unrecorded time is a rule ON the row's own line — see _write_rule for why this is
        # not a LINEBELOW any more
        for i, (_lab, val) in enumerate(m.zeiten):
            if not val:
                zrows[i][0] = _write_rule(val_w - val_pad)
        grid: list[list] = []
        for ri in range(n_rows):
            row: list = []
            for c in range(cols):
                i = c * n_rows + ri
                row.extend(zrows[i] if i < len(zrows) else ["", ""])
            grid.append(row)
        zt = Table(grid, colWidths=[val_w, cw - val_w] * cols)
        zt.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    # the rule is inset from the next column so it reads as a field rather than
                    # as a bar running across the whole grid
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
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
            # `hours` empty = nothing to total (a running Einsatz has no Einsatzende, so every
            # open block is unresolvable). Printing «0:00» there states a measurement.
            if ps.hours:
                story.append(
                    Paragraph(
                        L["personalTotals"].format(n=ps.present, h=_esc(ps.hours), r=_esc(ps.hoursRounded)),
                        st["cell"],
                    )
                )
                # only worth saying when there IS a total for them to be missing from
                # ⚠️ «N Person(en) ohne verwertbare Zeiten» is NOT printed. On paper it was a count
                # of an abstraction that nobody could act on — the affected person is already in
                # the roster above with their times, and the sentence named neither them nor the
                # reason. It belongs where it can be fixed: the Rapport surface raises it as a
                # Hinweis beside the button that makes the paper (ReportPreflight · Kontrolle).
            else:
                story.append(Paragraph(L["personalCount"].format(n=ps.present), st["cell"]))
        # No «Abhaken, ggf. von–bis ergänzen» above the table. The tick boxes and the empty
        # von–bis cells say that themselves, on a sheet whose readers fill one in every week —
        # and the line sat exactly where the pen needs room.
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
    # TWO blank write-in rows, like the Personalblatt — this is where «die zwei leeren» belong.
    # They were briefly put in the Rapport SURFACE instead, where two empty Organisation/Bemerkung
    # pairs plus their bins just stacked up under a list that already offers «+ Weitere». On paper
    # there is no «+», so a partner nobody configured can only be written where there is a rule.
    listed += [("", None), ("", None)]
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
            # «Ort, Datum: ______» is written ON its line like every other field on the sheet —
            # it is a value somebody fills in, not a signature. Only the NAME field signs
            # underneath, because that is the one that needs empty paper beneath it.
            [
                {"label": L["sigOrtDatum"], "w": 0.4},
                {"label": L["einsatzleiter"], "w": 0.6, "value": m.einsatzleiter, "sign": True},
            ],
            [
                {"label": L["sigOrtDatum"], "w": 0.4},
                {"label": L["sigKommandant"], "w": 0.6, "value": m.kommandant, "sign": True},
            ],
        ],
        # Room to sign BESIDE the name, not under it — the rule is on the row's own line now,
        # so the pitch only has to keep the two Visum rows from crowding each other.
        pitch=11.5 * mm,
    )
    story.append(KeepTogether([*head(L["signoff"]), sig]))

    # --- Einsatzjournal (Beilage) — only when there are entries; an empty journal table
    # would just cost paper on the blank form -----------------------------------------------
    if opt.journal and payload.journal:
        # The Journal is a BEILAGE, like the Kroki and the plans — an addition to the rapport,
        # not a part of it. It started wherever the signed part happened to end, which put the
        # first entries in the white space under the Unterschriften and made the two read as one
        # document. Its own sheet says what it is. (_collapse_breaks drops the double if a
        # section boundary already broke here.)
        story.append(PageBreak())
        story.extend(head(L["journal"]))
        # the Eintrag column's content width — mirrors the colWidths below, minus the two
        # 5pt side paddings _table_style() puts inside every cell
        entry_w = inner_w - 53 * mm - 10
        thead = [Paragraph(_esc(L[c]), st["cellhead"]) for c in ("colTime", "colArea", "colEntry")]
        body: list[list] = []
        for r in payload.journal:
            entry_cells: list = [Paragraph(r.markup or _esc(r.text), st["cell"])]
            if r.correctedAt and r.textOriginal:
                corrected = L["correctedLine"].format(t=_esc(r.correctedAt), text=_esc(r.textOriginal))
                entry_cells.append(Paragraph(corrected, st["muted"]))
            if r.transcriptLines:
                for i, line in enumerate(r.transcriptLines):
                    lead = f"<b>{_esc(L['transcript'])}:</b> " if i == 0 else ""
                    entry_cells.append(Paragraph(f"{lead}{_esc(line)}", st["muted"]))
            elif r.transcript:
                entry_cells.append(Paragraph(f"<b>{_esc(L['transcript'])}:</b> {_esc(r.transcript)}", st["muted"]))
            urls = r.photoUrls or ([r.photoUrl] if r.photoUrl else [])
            shots = [figures.get(r.photoKey)] if r.photoKey else []
            shots += [figures.get(f"photo:{u}") for u in urls]
            # ⚠️ SIDE BY SIDE from the second picture on. One photo is an illustration and gets the
            # column's full width; four stacked at that width push the next entry a page and a half
            # down, and «one damage is rarely one picture» is exactly the case the multi-photo entry
            # was built for. The width is the Eintrag column's own content width, never a fraction
            # of the page: at `inner_w * 0.45` a landscape shot used 69 % of its column and a
            # portrait one was height-capped to 2.1 cm across — unreadable on paper.
            data_shots = [d for d in shots if d]
            if len(data_shots) == 1:
                photo = _fit_image(data_shots[0], entry_w, 55 * mm)
                if photo:
                    entry_cells.append(Spacer(1, 2))
                    entry_cells.append(photo)
            elif data_shots:
                per_row = 2 if len(data_shots) <= 4 else 3
                gap = 2 * mm
                cell_w = (entry_w - gap * (per_row - 1)) / per_row
                # …and a height cap that scales with the cell, so a portrait shot in a narrow cell
                # is not blown up past what its neighbours occupy
                cell_h = 45 * mm if per_row == 2 else 32 * mm
                shot_grid: list[list] = []
                for i in range(0, len(data_shots), per_row):
                    shot_row = [_fit_image(d, cell_w, cell_h) or "" for d in data_shots[i : i + per_row]]
                    shot_row += [""] * (per_row - len(shot_row))  # keep the last row's columns aligned
                    shot_grid.append(shot_row)
                shot_tbl = Table(shot_grid, colWidths=[cell_w] * per_row, hAlign="LEFT")
                shot_tbl.setStyle(
                    TableStyle(
                        [
                            ("VALIGN", (0, 0), (-1, -1), "TOP"),
                            ("LEFTPADDING", (0, 0), (-1, -1), 0),
                            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                            ("TOPPADDING", (0, 0), (-1, -1), 1),
                            ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
                        ]
                    )
                )
                entry_cells.append(Spacer(1, 2))
                entry_cells.append(shot_tbl)
            body.append([Paragraph(_esc(r.timeLabel), st["cell"]), Paragraph(_esc(r.area), st["cell"]), entry_cells])
        # ⚠️ 29mm: the longest label «16.08.2026 15:35» measures 24.7mm at 9pt Helvetica, plus the
        # 3.5mm of cell padding — so it never wraps onto a second line, which would inflate EVERY
        # journal row. It was 36mm, sized for a label that still carried a comma between the date
        # and the time (see lib/report · formatDateTime); a date does not get longer, so the extra
        # 7mm was permanent white space taken from the one column that holds the entries.
        tbl = Table([thead, *body], colWidths=[29 * mm, 24 * mm, inner_w - 53 * mm], repeatRows=1)
        tbl.setStyle(_table_style())
        story.append(tbl)

    # --- Aufträge / Pendenzen — a SECTION on the Verlauf's sheet, not a page of its own ------
    # It is derived from the rows just above it, so it belongs with them: checking a line means
    # turning back one page, not hunting the document. And it stays out of the main part on
    # purpose — that part mirrors the WinFAP-Vorlage field for field, and a section inserted
    # there breaks the correspondence the whole sheet is built on.
    if opt.pendenzen and payload.pendenzen:
        story.append(Spacer(1, 7 * mm))
        story.extend(head(L["pendenzen"]))
        p_head = [Paragraph(_esc(L[c]), st["cellhead"]) for c in ("colWas", "colWer", "colErteilt", "colErledigt")]
        p_body: list[list] = []
        for pdz in payload.pendenzen:
            # «dringend» as a marker before the text, not as a column: with two priority levels a
            # column is blank on nearly every row and costs the width «Was» needs.
            # ⚠️ A single red «!», not the word «dringend ·». The word plus a middot in front of
            # the text read as a broken sentence — two punctuation marks and a label competing
            # with the Auftrag itself, on the column that carries the most prose on the page.
            # One glyph marks the row without being read as part of it; the footer says what it
            # means, once, instead of every row saying it.
            lead = f'<font color="{_URGENT}"><b>!</b></font>  ' if pdz.urgent else ""
            cells: list = [Paragraph(f"{lead}{_esc(pdz.text)}", st["cell"])]
            # the Erinnerung, when the item carried one — a fact about the Auftrag, so it sits
            # under «Was» with the Meldungen rather than claiming a column of its own
            if pdz.faellig:
                cells.append(Paragraph(L["pendenzDue"].format(t=_esc(pdz.faellig)), st["subline"]))
            for n in pdz.notes:
                cells.append(Paragraph(f"{_esc(n.timeLabel)}  {_esc(n.text)}", st["subline"]))
            p_body.append(
                [
                    cells,
                    Paragraph(_esc(pdz.assignee or ""), st["cell"]),
                    Paragraph(_esc(pdz.erteilt), st["cell"]),
                    Paragraph(_esc(pdz.erledigt) if pdz.erledigt else f"<b>{_esc(L['pendenzOpen'])}</b>", st["cell"]),
                ]
            )
        p_tbl = Table(
            [p_head, *p_body],
            colWidths=[inner_w - 74 * mm, 34 * mm, 20 * mm, 20 * mm],
            repeatRows=1,
        )
        # ⚠️ `flush_left=False` — the first column keeps its 5pt like every other. The default
        # drops it to zero so a grid table lines up with the section rule above it, which is right
        # where that column holds a short label; here it holds the Auftrag in full AND its
        # Meldungen as indented sub-lines, and with no padding the text sat on the grid line while
        # each sub-line's own indent was measured from the border rather than from the text. Five
        # points of daylight against five points of heading alignment is not a close call here.
        p_tbl.setStyle(_table_style())
        story.append(p_tbl)
        # ⚠️ No legend line under this table (18.08.). It explained four things the table already
        # says out loud — «!» sits next to the word «dringend», an indented line under an Auftrag
        # reads as belonging to it, «offen» is the word in the column — and a caption that repeats
        # its own table teaches the reader to skip captions.

    # --- Anhang: Kroki + annotated plans ALWAYS at the end (decided 2026-07-14) — the data
    # sections above are the identical main section; visual material is appended, never
    # interleaved. The Kroki is rendered HERE, server-side (app/kroki.py); the figure-based
    # branches remain as the one-release compat window for old clients.
    kroki_png: bytes | None = None
    #: filled by the renderer when the labels could not all fit as words and the picture
    #: fell back to numbers — «1 · 2 · 3» then print as a legend under the Kroki
    kroki_legend: list[str] = []
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
                legend_out=kroki_legend,
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
        # the legend claims its own room when there is one, so the picture is never squeezed
        # under a block that then overflows onto a second sheet
        # …and the room it claims halves with it: two columns are half the rows
        legend_h = (5 * mm + ((len(kroki_legend) + 1) // 2) * 4.6 * mm) if kroki_legend else 0
        img = _fit_image(kroki_png, k_w, k_h - legend_h)
        if img:
            story.append(Spacer(1, 4))
            story.append(img)
        # ⚠️ Numbers on the picture are useless without this. The renderer only falls back to
        # them when the words could not all be printed where they belong (kroki · the collision
        # pass), and the legend is where they go — with room for the FULL text, which is the
        # other reason it is the better fallback than a shortened chip.
        if kroki_legend:
            story.append(Spacer(1, 4))
            # ⚠️ TWO COLUMNS, directly under the picture (18.08.). One column of «1 …» ran the
            # legend down half the page for a Lage with eight labelled things, which pushed the
            # picture itself smaller (the block claims its room below) and put number 8 a hand's
            # width away from the disc it belongs to. Reading «wo ist die 4» is a scan between two
            # places; the shorter that distance, the less the numbering costs.
            half = (len(kroki_legend) + 1) // 2
            left, right = kroki_legend[:half], kroki_legend[half:]
            num_w, col_gap = 7 * mm, 6 * mm
            text_w = (k_w - col_gap) / 2 - num_w
            rows = [
                [
                    Paragraph(f"<b>{i + 1}</b>", st["cell"]),
                    Paragraph(_esc(left[i]), st["cell"]),
                    Paragraph(f"<b>{half + i + 1}</b>", st["cell"]) if i < len(right) else "",
                    Paragraph(_esc(right[i]), st["cell"]) if i < len(right) else "",
                ]
                for i in range(len(left))
            ]
            lt = Table(rows, colWidths=[num_w, text_w, num_w, text_w])
            lt.setStyle(
                TableStyle(
                    [
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 0),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                        ("TOPPADDING", (0, 0), (-1, -1), 1),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
                    ]
                )
            )
            lt.hAlign = "LEFT"
            story.append(lt)
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
        story.append(_attachment_block(att_shown, inner_w, st))

    # Atemschutzüberwachung closes the Anhang: protocol for reconstruction, not primary
    if opt.atemschutz and payload.trupps:
        story.extend(head(L["atemschutz"]))
        # The rule this Einsatz ran on, once, under the heading — every «überfällig» below
        # is measured against it, and a reader six months later has nowhere else to find it.
        if payload.atemschutzIntervalMin:
            grace_min = round((payload.atemschutzGraceSec or 0) / 60)
            story.append(
                Paragraph(
                    _esc(
                        L["azInterval"].format(n=payload.atemschutzIntervalMin, g=grace_min)
                        if grace_min
                        else L["azIntervalNoGrace"].format(n=payload.atemschutzIntervalMin)
                    ),
                    st["muted"],
                )
            )

        def _meta_bits(tr):
            bits = []
            # One row per AdF, numbered the way the Trupp form numbers them — «AdF 1», «AdF 2».
            # A single «AdF: Laura Keller, Nina Frei» line made the sheet name the crew
            # differently from the screen the operator filled in, and a comma list gives no
            # position to point at when somebody asks who the second man was. The Gruppenführer
            # gets no row of his own: the heading above IS his name.
            for i, member in enumerate(tr.members, start=1):
                if member.strip():
                    bits.append((L["memberN"].format(n=i), member))
            if tr.auftrag or tr.ziel:
                bits.append((L["auftrag"], " · ".join([x for x in (tr.auftrag, tr.ziel) if x])))
            if tr.lineNumber:
                bits.append((L["line"], str(tr.lineNumber)))
            if tr.entryTime:
                bits.append((L["entry"], tr.entryTime))
                if tr.exitTime:
                    bits.append((L["exit"], tr.exitTime))
            elif tr.exitTime:
                # closed without ever going under PA (atemschutz · truppNeverDeployed). Printing
                # it as «Austritt» claimed the Trupp came out of something it never went into —
                # on a Sicherungstrupp that is the difference between a crew that was exposed
                # and one that was not, which is exactly what this sheet is read for.
                bits.append((L["notDeployed"], tr.exitTime))
            return bits

        # ⚠️ ONE tab stop for the whole section, not one per Trupp. Sized per block, a Trupp with
        # an «Auftrag / Ziel» put its values ~14mm in and the next Trupp — three «AdF n» rows and
        # nothing else — put them ~8mm in, so every block on the page started at a different x
        # and the pressure logs stepped in and out with them. Widest label anywhere wins.
        _all_bits = [_meta_bits(tr) for tr in payload.trupps]
        label_w = 0.0
        _labels = [k for bits in _all_bits for k, _ in bits]
        if _labels:
            label_w = max(_str_w(f"{k}:", "Helvetica-Bold", 9) for k in _labels) + 3 * mm

        for tr, meta_bits in zip(payload.trupps, _all_bits, strict=True):
            # No status word. A rapport is written after the fact, and «Im Einsatz» on a
            # finished Einsatz states something that stopped being true before the sheet was
            # printed. The ONE state that outlives the Einsatz — a Trupp that never went under
            # PA — is carried by its own «Nicht eingesetzt» row above (see _meta_bits).
            story.append(Paragraph(_esc(tr.name), st["h3"]))
            # A TABLE, not one Paragraph per line: as free lines each value started right after
            # its own label, so «AdF 1», «Auftrag / Ziel» and «Eintritt» put their values at three
            # different indents and nothing under the Trupp name lined up. One label column,
            # sized above to the widest label on the PAGE, gives every value the same tab stop.
            if meta_bits:
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
            # A pressure log is three short values — a clock, one word and a number. At 45/35/20
            # of the full width it read as a table of mostly empty space.
            tbl = Table([thead, *body], colWidths=[inner_w * x for x in (0.26, 0.16, 0.12)], repeatRows=1)
            tbl.setStyle(_table_style())
            # ⚠️ Indented to the Trupp's VALUE column, not to the frame edge. The log belongs to
            # the Trupp above it the same way «Eintritt: 20:29» does, and starting it at the page
            # margin made it read as a new full-width section that happened to follow. Its own
            # 5pt cell padding is subtracted, so the «Zeit» heading lands exactly on the tab stop
            # that «Anna Meier» and «Retten · 2. OG» sit on.
            indent = max(0.0, label_w - 5)
            wrapped = Table([["", tbl]], colWidths=[indent, inner_w - indent])
            wrapped.setStyle(TableStyle(_SPLIT_OUTER))
            # Narrower than the frame, so ReportLab's default CENTER floated it into the middle of
            # the page — the pressure log sat off to the side of the Trupp name and «Auftrag / Ziel»
            # lines it belongs under.
            wrapped.hAlign = "LEFT"
            story.append(Spacer(1, 3))
            story.append(wrapped)
            story.append(Spacer(1, 6))

    story = _collapse_breaks(story)
    # ⚠️ The page footer carries the ALARM time, not the moment the file was made. Every page
    # said «Erstellt: …» twice — once under the title, once at the foot of every sheet — and the
    # print time is the least useful stamp on a document that gets reprinted after a correction:
    # two printings of the same Einsatz footed differently and read as two Einsätze. The
    # Alarmierung is what a stack of rapports is sorted and found by. Falls back to the print
    # time only when nothing recorded the alarm, so the foot is never blank.
    stamp = m.alarmiertAt or payload.generatedAt
    label = " · ".join(x for x in (payload.incident.title, stamp) if x)

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


def _write_rule(width: float, fs: float = 8.5) -> Table:
    """A dotted write-in rule that sits ON the text line, not at the bottom of the row.

    ⚠️ ``LINEBELOW`` draws at the bottom of the CELL, and a table row is as tall as its tallest
    cell — which in every tick-off block on this sheet is the checkbox. So an empty row's rule
    dropped a line below the box beside it and read as a second, lower row: box on one line,
    the thing to write on the next (08.08. sheet, three blocks at once). Reported 09.08. as
    «the empty lines where things aren't all on one line».

    This is a one-cell table of exactly one text line's height, so the rule lands where the
    words would have been no matter what else shares the row. Left-aligned and given an
    explicit width, so every rule in a column starts and ends at the same x.
    """
    t = Table([[""]], colWidths=[width], rowHeights=[fs * 1.2])
    t.setStyle(TableStyle([*_SPLIT_OUTER, ("LINEBELOW", (0, 0), (0, 0), 0.5, _WRITE, *_WRITE_DASH)]))
    t.hAlign = "LEFT"
    return t


#: How TALL one indivisible chunk of a two-up block may get — i.e. how coarsely the block is
#: allowed to break across a page boundary.
#:
#: ⚠️ NOT a page. It was 660pt — nearly the whole frame — which made the 66-name roster ONE
#: indivisible row: with the header, the Kurzbericht and its own heading already on page 1
#: there was never 660pt left for it, so ReportLab moved the entire roster to page 2 and the
#: rapport's first page ended two thirds empty under a heading with nothing beneath it.
#: At five rows the block simply continues where the page ran out, and the most that can be
#: pushed down is those five rows. Reading order is untouched: the left/right split is made
#: ONCE over the whole list and every chunk slices both halves in parallel, so the left column
#: still reads 1…33 straight down and across the break.
_SPLIT_BUDGET = 72
# ⚠️ The gutter between the two halves of EVERY two-up block, stated once. It was a literal in
# four places and the callers disagreed with it: Personal and Material each subtracted the whole
# 3mm from their half instead of half of it, so both blocks came out 8.5pt narrower than the
# frame and ReportLab centre-floated them — the roster's checkboxes sat at x=46.8 and Material's
# labels at 43.9 while the section rule above them started at 39.7 and the Partner tick-offs at
# 42.5. Nothing in the two biggest blocks lined up with anything. Derive both halves from here
# and a caller can no longer disagree with the table it is filling.
_SPLIT_GUTTER = 3 * mm
#: The tick-off square, drawn at a FIXED size so every checkbox in a column matches whatever
#: the row around it does — see _personal_table.
_CHECK_W = 4 * mm


def _check_box(ticked: bool) -> Table:
    """ONE tick-off square for the whole sheet: 4mm, square, whatever the row does.

    ⚠️ Not a BOX on the table cell. As a cell border it takes the ROW's height — so a person
    with a remark, or a Partner row whose Bemerkung wrapped, got a checkbox twice as tall as its
    neighbour's, and a tick-off column whose boxes are different sizes reads as a form somebody
    drew by hand. The roster had worked this out locally; the Partner block still carried the
    cell-border version, at a third size again.
    """
    st = _styles()
    box = Table([[Paragraph("<b>X</b>" if ticked else "", st["check"])]], colWidths=[_CHECK_W], rowHeights=[_CHECK_W])
    box.setStyle(
        TableStyle([*_SPLIT_OUTER, ("BOX", (0, 0), (-1, -1), 0.5, _WRITE), ("VALIGN", (0, 0), (-1, -1), "MIDDLE")])
    )
    return box


def _split_col_w(inner_w: float) -> float:
    """Width of ONE half of a two-up block — the gutter is shared, so each side gives up half."""
    return inner_w / 2 - _SPLIT_GUTTER / 2


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
    outer = Table(rows or [["", "", ""]], colWidths=[col_w, _SPLIT_GUTTER, col_w])
    outer.setStyle(TableStyle(_SPLIT_OUTER))
    return outer


def _personal_table(personal: list[PersonalRowIn], inner_w: float, st: dict[str, ParagraphStyle]) -> Table:
    """Two-up roster: [☐|Name|von–bis] × 2 — recorded people get a printed tick + clocks,
    the rest stays blank for the pen. Long rosters flow onto the next page."""
    check_w = _CHECK_W
    # ⚠️ ONE stub shape per sheet. The stub was always «__:__» while a recorded value on an
    # Einsatz over midnight reads «02.08. 14:41» — so a column of blanks was visibly a different
    # length from the rows above it, and what somebody has to write in did not match what the
    # row beside it shows. When ANY row on the sheet carries a date, every stub carries the
    # space for one.
    ends = [v for p in personal for t in p.times for v in (t.von, t.bis)]
    dated = any("." in (v or "") for v in ends)
    # the two clock cells are EMPTY and carry a dotted rule instead of an underscore stub —
    # one texture means «hier schreiben» across the whole sheet (see _WRITE_DASH)
    stub = ""
    _ = dated  # the shape no longer changes with it; the column width still does
    # The clock column is sized to what it actually has to hold. A fixed 30 mm was enough for
    # «14:41 – 11:00» and not for «02.08. 14:41 – 04.06. 11:00», so an Einsatz over midnight
    # wrapped every row onto two lines — the remark under the name then had a stack of dates
    # beside it. Capped, so a stray long value cannot eat the name column instead.
    widest_end = max((_str_w(v or stub, "Helvetica", 8.5) for v in ends or [None]), default=0.0)
    dash_w = 4 * mm
    end_w = min(widest_end + 1.5 * mm, 21 * mm)
    time_w = max(32 * mm, min(2 * end_w + dash_w, 46 * mm))
    end_w = (time_w - dash_w) / 2
    name_w = _split_col_w(inner_w) - check_w - time_w

    def cells(p: PersonalRowIn | None) -> list:
        if p is None:
            return ["", "", ""]

        # each end is coloured on its own: a recorded arrival next to a derived departure has
        # to read as exactly that, so the two are not one string in one colour any more
        def stamp(v: str | None, derived: bool) -> str:
            if not v:
                return f'<font color="{_DERIVED}">{stub}</font>'
            return f'<font color="{_DERIVED}">{_esc(v)}</font>' if derived else _esc(v)

        # ⚠️ THREE columns, so the dash is at one x down the whole sheet. As one string the two
        # ends were set proportionally — «__:__» and «02.08. 14:41» are not the same width, and
        # Helvetica's underscore is narrower than its digits, so even two stubs of equal shape
        # drifted — and every row put its dash somewhere else. «von» hangs right against the
        # dash, «bis» starts left of it, which is also how the two are read: inwards, from the
        # dash. Fixed widths mean no wrap either, so the old &nbsp; guard is unnecessary.
        # ONE line per stretch, stacked — a person who left and came back has two, under the one
        # printing of their name.
        spans = p.times or [PersonalTimeIn()]
        vonbis = Table(
            [
                [
                    Paragraph(stamp(t.von, t.vonDerived), st["ramt"]),
                    Paragraph(f'<font color="{_DERIVED}">–</font>', st["rdash"]),
                    Paragraph(stamp(t.bis, t.bisDerived), st["rcell"]),
                ]
                for t in spans
            ],
            colWidths=[end_w, dash_w, end_w],
        )
        # an EMPTY clock cell gets the sheet's write-in rule under it. The stub used to be
        # «__.__. __:__», which is a third texture on a sheet that already has a dotted
        # leader — and its underscores never lined up with the digits of a filled row,
        # because Helvetica's underscore is narrower than its figures.
        vonbis.setStyle(
            TableStyle(
                [
                    *_SPLIT_OUTER,
                    ("TOPPADDING", (0, 1), (-1, -1), 2),
                    *[
                        ("LINEBELOW", (col, r), (col, r), 0.5, _WRITE, *_WRITE_DASH)
                        for r, t in enumerate(spans)
                        for col, v in ((0, t.von), (2, t.bis))
                        if not v
                    ],
                ]
            )
        )
        # The remark rides INLINE behind the name — «Meier Anna · Einsatzleiter» — whenever it
        # fits the column. As its own line under the name it made that row two lines tall, and
        # since the two halves of the sheet are independent tables (see _two_up), every remark
        # opened a one-row gap in the column OPPOSITE it: a hole that reads as a missing person
        # on a roster whose whole job is «who was here». A role is short, which is the case this
        # is for; anything too long to fit still gets its own line and its own two-line room.
        # «Gast» leads the remark — it says what KIND of entry this row is, which is read before
        # what the person did on it. One suffix, so a guest with a job prints «Gast · Fahrer TLF»
        # rather than two competing marks.
        note = _clip_print(p.note) if p.note else ""
        if p.guest:
            note = f"{L['guest']} · {note}" if note else L["guest"]
        inline = bool(note) and (
            _str_w(p.name, "Helvetica", 8.5) + _str_w(f" · {note}", "Helvetica", 6.5) <= name_w - 11
        )
        # ⚠️ A write-in row's rule is part of the CELL, not a LINEBELOW on the row: the row is as
        # tall as the checkbox beside it, so the rule dropped onto the next line and the sheet
        # read as a box on one line and a blank on the one under it (see _write_rule).
        if not p.name:
            return [_check_box(False), _write_rule(name_w - 5), ""]
        label = _esc(p.name)
        if inline:
            label += f'<font size="6.5" color="{_DIM_INK}"> · {_esc(note)}</font>'
        name: list = [Paragraph(label, st["rcell"])]
        if note and not inline:
            name.append(Paragraph(_esc(note), st["rnote"]))
        box = _check_box(p.erfasst)
        return [
            box,
            name,
            # ⚠️ A WRITE-IN row prints no clocks. The roster deliberately carries two blank rows
            # at the end for somebody who turned up and is not on the Mannschaftsliste (see
            # lib/report.ts) — and they printed the full «__:__ – __:__» stub beside an empty
            # tick box, so the sheet ended in two people nobody had got round to naming. The
            # ruled underline is the affordance for a blank row; the stub is for a NAMED person
            # whose times are still to be filled in.
            vonbis if p.name else "",
        ]

    def column(people: list[PersonalRowIn]) -> Table:
        style: list[tuple] = [
            # TOP, not MIDDLE. A person with a remark has a two-line name cell, and a
            # middle-aligned row floated their clocks between the two lines — aligned with
            # neither the name above nor the remark below. The Material worksheet beside it
            # already uses TOP for exactly this reason.
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            # A roster row is filled in with a PEN — the tick, and usually the two clocks — so it
            # cannot go back to the 1.8 pt it had. 2.8 is the compromise: writable, and still
            # dense enough that a village Wehr's roster does not sprawl.
            ("TOPPADDING", (0, 0), (-1, -1), _PAD_ROW),
            ("BOTTOMPADDING", (0, 0), (-1, -1), _PAD_ROW),
            ("LEFTPADDING", (0, 0), (-1, -1), 1),
            # breathing room between the checkbox square and the name (jsPDF gap ~1.6mm);
            # the check cells lose ALL side padding so the X centers in its square
            ("LEFTPADDING", (1, 0), (1, -1), 5),
            ("LEFTPADDING", (0, 0), (0, -1), 0),
            ("RIGHTPADDING", (0, 0), (0, -1), 0),
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ]
        t = Table([cells(p) for p in people] or [["", "", ""]], colWidths=[check_w, name_w, time_w])
        t.setStyle(TableStyle(style))
        return t

    # a shared row meant one person's remark set the height for whoever happened to sit opposite
    # them, and from there down the two halves no longer shared a baseline
    return _two_up(personal, column, check_w + name_w + time_w)


# Beilagen come in three sizes, because «how many are there» changes what the pages are FOR.
#
#   ≤2   full plates — a driving licence is photographed to be read off the paper afterwards
#   ≤8   two-up — still readable, and half the sheets. Four plates down a single column left
#        the right half of every page empty for no gain: at 62 % width a plate is not using
#        the page it costs.
#   >8   a numbered contact sheet, three across. Nobody reads plate 30, and what the paper is
#        for becomes «which pictures exist», which a thumbnail answers. 50 large plates are
#        ~20 sheets appended to a 2-page rapport, and the signed part disappears behind them.
_ATT_PLATE_MAX = 2
_ATT_GRID_MAX = 8


def _attachment_block(
    att: list[tuple[AttachmentIn, bytes]],
    inner_w: float,
    st: dict[str, ParagraphStyle],
) -> Table:
    """Beilagen, laid out for the number of them there actually are.

    One or two print LARGE — the reason to photograph a driving licence is to read it off the
    paper afterwards. A handful go two-up, which is still readable and halves the sheets. Many
    print as a numbered contact sheet: at 50 photos nobody reads plate 30, and what the paper is
    for becomes «which pictures exist», which a thumbnail answers.

    Either way each carries its number «B7», so the Verlauf, a phone call and the paper can all
    name the same picture.
    """
    n = len(att)
    grid = n > _ATT_PLATE_MAX
    if n <= _ATT_PLATE_MAX:
        cols, cell_h = 1, 92 * mm
    elif n <= _ATT_GRID_MAX:
        # 74, not 84: at 84 the row pitch was 260pt against ~735pt of usable page, so only TWO
        # rows fitted and every sheet ended with ~79mm of nothing. 74 brings the row to 232pt —
        # three rows to a page, the same plates on half the paper.
        cols, cell_h = 2, 74 * mm
    else:
        cols, cell_h = 3, 62 * mm
    # 6, not 4: two photographs butted almost together read as one wide picture, and a contact
    # sheet needs the eye to find the boundaries without looking for them.
    gutter = 6 * mm
    cell_w = (inner_w - gutter * (cols - 1)) / cols
    img_w = cell_w if grid else inner_w * 0.62

    def cell(i: int, a: AttachmentIn, data: bytes):
        # The NUMBER is the contract — it is what lets the Verlauf, a phone call and the paper
        # name the same picture. A caption is extra. «ohne Bildlegende» printed under all seven
        # plates of an ordinary rapport, which is a placeholder repeated until it is noise.
        cap = _esc((a.caption or "").strip())
        caption = Paragraph(f"<b>B{i}</b>" + (f" · {cap}" if cap else ""), st["muted"])
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
                    # MIDDLE, not BOTTOM. The box is a fixed height and the plates are not, so
                    # bottom-aligning left a short one hanging under a void — measured at 63mm
                    # of white above a 58pt plate beside one that filled its box. The captions
                    # still share a shelf either way: the picture row height is fixed.
                    ("VALIGN", (0, 0), (0, 0), "MIDDLE"),
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
    # ⚠️ The gutter is drawn as RIGHTPADDING INSIDE each cell, so it has to be part of that
    # cell's width. As `[cell_w] * cols` the table came out `gutter * (cols-1)` narrower than
    # the frame — ReportLab then centre-floated the whole block (left edge 48.2 against a
    # section rule at 39.7) AND the images, sized at cell_w, overflowed their own padding: two
    # photographs measured as touching, B1 ending at 297.64 and B2 starting at 297.64.
    t = Table(rows, colWidths=[cell_w + (gutter if c < cols - 1 else 0) for c in range(cols)])
    t.hAlign = "LEFT"
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
    check_w = _CHECK_W
    col_w = _split_col_w(inner_w)
    org_w = (col_w - check_w) * 0.42

    def column(part: list[tuple[str, PartnerContact | None]]) -> Table:
        # ⚠️ ONE look for every row. Ticked organisations were ink, unticked ones muted grey and
        # the write-in row empty — three type treatments and three row heights in a block whose
        # whole point is that the entries are comparable. A tick says «this one was there»; the
        # typography must not say it a second time, more quietly.
        # ⚠️ CLAMPED, like every other remark on this sheet. A partner's name and remark are free
        # text with no length rule behind them, and a long one wrapped to four or five lines —
        # which on a two-up block means the row opposite it opens a hole that size (see
        # `_personal_table`), and the two halves stop sharing baselines from there down.
        notes = [_esc(_clip_print(" · ".join(x for x in (c.name, c.phone, c.note) if x))) if c else "" for _, c in part]
        note_w = col_w - check_w - org_w
        # each write-in cell carries its OWN rule, on its own text line — a LINEBELOW would sit
        # at the bottom of a row whose height comes from the checkbox (see _write_rule)
        rows = [
            [
                _check_box(bool(c)),
                Paragraph(_esc(_clip_print(org)), st["rcell"]) if org else _write_rule(org_w - 5),
                Paragraph(note, st["rcell"]) if note else _write_rule(note_w - 5),
            ]
            for (org, c), note in zip(part, notes, strict=True)
        ]
        style: list[tuple] = [
            # ⚠️ TOP, not MIDDLE — the same rule the roster beside it follows. An organisation or
            # a remark that wraps makes the row three lines tall, and a middle-aligned tick then
            # floated down beside the SECOND line: on a sheet somebody reads down the boxes of,
            # the box no longer sat next to the name it belongs to.
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), _PAD_ROW),
            ("BOTTOMPADDING", (0, 0), (-1, -1), _PAD_ROW),
            ("LEFTPADDING", (0, 0), (-1, -1), 1),
            ("LEFTPADDING", (1, 0), (1, -1), 5),
            ("LEFTPADDING", (0, 0), (0, -1), 0),
            ("RIGHTPADDING", (0, 0), (0, -1), 0),
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ]
        t = Table(rows or [["", "", ""]], colWidths=[check_w, org_w, note_w])
        t.setStyle(TableStyle(style))
        return t

    return _two_up(listed, column, col_w)


def _mittel_table(mittel: list[MittelFormRowIn], inner_w: float, st: dict[str, ParagraphStyle]) -> Table:
    """Two-up Material worksheet: label + «______ Stk» amount stub / bold recorded amount."""
    # ⚠️ THREE columns, because the write-in rule has to be a RULE and not six underscores in a
    # string. As `f"______ {unit}"` right-aligned, it was the UNIT that landed on the shared edge
    # and the rule started wherever the unit happened to begin — measured on one sheet, «Stk»
    # rules began at x=250.3, «Sack» at 243.7 and «l» at 260.7, and the «l» of Liter read as a
    # stray glyph hanging off the end of a rule. A recorded «1 Stk» sat on a fourth edge again.
    # Amount and unit get their own columns and the stub is drawn with LINEBELOW, so every rule
    # on the sheet starts and ends at the same x and every unit sits in one column.
    unit_w = 12 * mm
    amt_w = 14 * mm
    label_w = _split_col_w(inner_w) - amt_w - unit_w

    def cells(row: MittelFormRowIn | None) -> list:
        if row is None:
            return ["", "", ""]
        # the remark rides UNDER the label, small: «3 Sack» says how much, «an Werkhof
        # übergeben» says what happened to it, and only the second one is worth reading twice
        label: list = [Paragraph(_esc(row.label), st["rcell"])]
        if row.note:
            label.append(Paragraph(_esc(_clip_print(row.note)), st["rnote"]))
        return [
            label,
            Paragraph(_esc(row.menge) if row.menge else "", st["ramt"]),
            Paragraph(_esc(row.unit), st["runit"]),
        ]

    def column(rows_in: list[MittelFormRowIn]) -> Table:
        t = Table([cells(r) for r in rows_in] or [["", "", ""]], colWidths=[label_w, amt_w, unit_w])
        t.setStyle(
            TableStyle(
                [
                    # amounts hang on the RIGHT edge: «1 Stk» and «______ Stk» are read as a
                    # column of quantities, and a recorded amount that started where its label
                    # happened to end sat at a different x on every row. TOP, not MIDDLE — a
                    # three-line remark under the label must not drag the amount down with it.
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("TOPPADDING", (0, 0), (-1, -1), _PAD_ROW),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), _PAD_ROW),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                    # air between the number and its unit, so «1» and «Stk» do not touch
                    ("RIGHTPADDING", (1, 0), (1, -1), 4),
                    # the write-in rule, under the amount cell only — one x, one width, and only
                    # on the rows that are actually still to be filled in
                    *[
                        ("LINEBELOW", (1, r), (1, r), 0.5, _WRITE, *_WRITE_DASH)
                        for r, rr in enumerate(rows_in)
                        if rr is not None and not rr.menge
                    ],
                ]
            )
        )
        return t

    # ⚠️ Each half is its OWN table inside one outer row. Sharing rows across the fold meant a
    # material with a four-line remark stretched the row on the FAR side too, and from there
    # down the two columns no longer sat on the same baselines — the sheet looked broken even
    # though every value was right. Independent columns simply flow past each other.
    return _two_up(mittel, column, label_w + amt_w + unit_w)


def _table_style() -> TableStyle:
    """The one grid-table look on the sheet: hairline grid, panel header row, 5pt inside cells.

    ⚠️ The first column once had its LEFTPADDING dropped to zero, so a table would line up with
    the section rule above it. Every one of these tables draws a GRID, so what that actually did
    was print the text ON the line — and in a column carrying prose with indented sub-lines
    («Aufträge / Pendenzen»), each sub-line's indent then measured from the border rather than
    from the text above it. Five points of daylight beats five points of heading alignment, and
    with the last caller gone the flag itself is no longer worth its explanation.
    """
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

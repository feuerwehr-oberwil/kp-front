import type { AttendanceState, BoardDoc, Drawing, Entity, LngLat, MittelEntry, PlanDocument, TimelineEvent, Trupp, TruppReading } from '../types'
import type { FahrzeugZeit, GruppeZeit, PartnerContact, ReportMeta } from './workspace'
import { appConfig } from '../config/appConfig'
import { fmtDistance } from './geo'
import { fillTemplate, hhmm, restoreUmlauts } from './format'
import { fahrzeugRows, gruppenRows } from './alarmzeiten'
import { intervalsOf, mergeCloseBlocks } from './attendanceIntervals'
import { truppNeverDeployed } from './atemschutz'
import { attendanceMergeGapMin, getDeploymentConfig } from './deploymentConfig'
import { mittelReportRows } from './mittel'
import { rowPhotos } from './verlauf'
import { linkMarkup, type JournalLink } from './journalLinks'

export interface KrokiView {
  center: LngLat
  zoom: number
  /** Exact north-up MapLibre viewport: [west, south, east, north]. The server uses this
   *  instead of translating camera zoom conventions, so the selected crop is literal. */
  bounds?: [number, number, number, number]
}

export interface ReportOptions {
  kroki: boolean
  /** the framing chosen in the Kroki modal (WYSIWYG crop) — null until picked;
   *  the server auto-fits the annotations only as headless fallback */
  krokiView: KrokiView | null
  /** WHEN the printed Kroki shows. Null = the live picture. An ISO instant reconstructs the
   *  Lage as it stood then (lib/replay · stateAt), which is how a rapport can still show the
   *  Rettung that has long since left — and the caption then names that moment, so the sheet
   *  never claims to be «Stand jetzt» while showing something else. */
  krokiAt: string | null
  /** Kroki page shape. A tall Lage in a landscape frame prints postage-stamp small with white
   *  down both sides; seeded from the crop's own aspect and overridable in the framing modal. */
  krokiLandscape: boolean
  annotatedPlans: boolean
  allPlans: boolean
  atemschutz: boolean
  attendance: boolean
  mittel: boolean
  journal: boolean
  /** print the Rapport-Beilagen (document/damage photos) as full-width plates at the end */
  attachments: boolean
  detailedAudit: boolean
}

export const defaultReportOptions: ReportOptions = {
  kroki: true,
  krokiView: null,
  krokiAt: null,
  krokiLandscape: true,
  annotatedPlans: true,
  allPlans: false,
  atemschutz: true,
  attendance: true,
  mittel: true,
  journal: true,
  attachments: true,
  detailedAudit: false,
}

export interface AuditProof {
  intact: boolean | null
  brokenAtSeq?: number | null
  count?: number
  head?: string
  checkedAt: string
  offline?: boolean
}

export interface ReportDraft {
  meta: ReportMeta
  generatedAt: string
  proof: AuditProof
  options: ReportOptions
}

export function hasVisiblePlanAnnotation(board: BoardDoc, planId: string): boolean {
  return (board[planId] ?? []).some((a) => {
    if (a.kind === 'text') return !!(a.text ?? '').trim()
    if (a.kind === 'draw' || a.kind === 'area') return Array.isArray(a.pts) && a.pts.length > 0
    if (a.kind === 'symbol' || a.kind === 'shape' || a.kind === 'resource') return true
    return false
  })
}

export function annotatedPlans(plans: PlanDocument[], board: BoardDoc, includeAll: boolean): PlanDocument[] {
  return includeAll ? plans : plans.filter((p) => hasVisiblePlanAnnotation(board, p.id))
}

export function planLabel(plan: PlanDocument | undefined, floor?: number): string {
  const fallback = appConfig.copy.report.planFallback
  if (!plan) return fallback
  if (plan.floorStack && floor != null) {
    const c = appConfig.copy.floor
    const label = floor === 0 ? c.eg : floor > 0 ? fillTemplate(c.og, { n: floor }) : fillTemplate(c.ug, { n: Math.abs(floor) })
    return `${plan.code} ${label}`
  }
  return plan.code || plan.title || fallback
}

export function eventIso(e: TimelineEvent, fallbackDate?: string): string | null {
  if (e.at) return e.at
  if (!fallbackDate || !/^\d{2}:\d{2}$/.test(e.t)) return null
  const d = new Date(fallbackDate)
  if (Number.isNaN(d.getTime())) return null
  const [hh, mm] = e.t.split(':').map(Number)
  d.setHours(hh, mm, 0, 0)
  return d.toISOString()
}

const OMIT_TEXT = [
  appConfig.copy.log.objectMoved.replace('{name}', ''),
  appConfig.copy.log.undo,
  appConfig.copy.log.redo,
]

function printableTacticalText(e: TimelineEvent): boolean {
  const text = e.text.trim()
  if (!text) return false
  if (OMIT_TEXT.some((p) => p && text.includes(p))) return false
  if (/verschoben$/i.test(text)) return false
  return true
}

export interface JournalPrintRow {
  id: string
  iso: string | null
  timeLabel: string
  area: string
  text: string
  kind?: TimelineEvent['kind']
  photoUrls?: string[]
  audioUrl?: string
  transcript?: string
  /** the entry with its linked terms in <b>…</b>, for the PDF. Absent when nothing is linked —
   *  the composer then prints `text` verbatim, as it always did. */
  markup?: string
  /** row was appended AFTER the Einsatzende (closed_at) — printed under «Nachträge» */
  nachtrag?: boolean
}

/** ReportLab's Paragraph takes a tiny HTML subset, so anything that is not our own markup has
 *  to be escaped before it goes in — an «&» or a «<» in a note would otherwise break the row. */
const escapeXml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The «Bereich» column: WHERE in the app this entry came from.
 *
 * ⚠️ `kind` alone cannot answer this and never could. `'team'` is written by the Atemschutz
 * board, by Anwesenheit, by Mittel, by a role note and by the live-position sharing switch — so
 * every one of them printed as «Atemschutz» — and everything with no kind at all fell through to
 * the map, which is how a change to the Rapportangaben came out under «Kroki» with the entry
 * «Rapportangaben: Einsatzleiter Meier Anna» (08.08. Einsatz). The `icon` is what actually
 * separates those writers, so the two are read together.
 *
 * The names are the app's own surface names (copy.modes), so a reader looking for the row can go
 * to the surface it names. Nothing here is stored — an old record classifies the same way a new
 * one does, because the rule reads only fields both have.
 */
export function journalArea(e: TimelineEvent, plans: PlanDocument[]): string {
  const r = appConfig.copy.report
  // ── hand-written first, whatever surface it was written on ──
  // a Checklisten-Haken is a documented decision, not a free note — and it is the only other
  // thing `journal` is written for besides the composer
  if (e.kind === 'journal' && e.icon === 'check') return r.areaChecklist
  if (e.kind === 'reminder') return r.areaManual
  // ⚠️ A row that WAS given a type says so in this column. «Manuell» answers «wo kam das her»,
  // which is the least interesting thing about an Auftrag or a Sofortmassnahme — and the type
  // was already in the text as a «Auftrag · » prefix, so the printed row carried the word twice
  // and the column carried nothing. Now the column IS the type and `withoutAreaPrefix` drops
  // the duplicate from the text. `info` keeps «Manuell»: it is the ordinary case and prints no
  // tag anywhere else either.
  if (e.entryType && e.entryType !== 'info') {
    return appConfig.copy.journal.entryTypes[e.entryType] ?? r.areaManual
  }
  if (e.kind === 'audio' || e.kind === 'photo' || e.kind === 'journal' || e.pinned) return r.areaManual
  // ── then by ICON, which is what actually separates the writers ──
  // ⚠️ Every row the QR poster writes has NO kind at all (lib/captureClient · row), so a rule
  // that went by kind classified all of them as map-tactical. The icon is the only thing the
  // tablet's rows and the poster's rows have in common.
  if (e.icon === 'clipboard') return r.areaRapport
  if (e.icon === 'photo') return r.areaRapport // Beilage added/removed at the poster
  if (e.icon === 'people' || e.icon === 'user' || e.icon === 'clock') return r.areaAnwesenheit
  if (e.icon === 'box') return r.areaMittel
  // everything else the Atemschutz board writes: Kontakt, Druck, Leitung, Alarm, Sicherheitswerte
  if (e.kind === 'team') return r.areaAtemschutz
  if (e.surface === 'plan') return planLabel(plans.find((p) => p.id === e.planId), e.floor)
  return r.areaLage
}

/** Prefixes a printed entry no longer needs, because the Bereich beside it now says the same
 *  thing. The RECORD keeps its wording — it is append-only, and the live Verlauf has no column
 *  to lean on, so «Rapportangaben: …» is exactly right there. Only the printed row drops it. */
function withoutAreaPrefix(text: string): string {
  const prefixes = [
    appConfig.copy.preflight.logMetaChanged,
    appConfig.copy.capture.logMeta,
  ].map((tpl) => tpl.replace('{fields}', '').trimEnd()).filter(Boolean)
  for (const p of prefixes) {
    if (text.startsWith(p)) return text.slice(p.length).trimStart() || text
  }
  // …and the entry-type tag the composer writes into the text («Auftrag · Trupp 2 sichert»),
  // now that the Bereich column carries the same word. Only the printed row drops it — the
  // record keeps its wording, and the live Verlauf has no column to lean on.
  for (const [key, label] of Object.entries(appConfig.copy.journal.entryTypes)) {
    if (key === 'info') continue
    const tag = `${label} · `
    if (text.startsWith(tag)) return text.slice(tag.length).trimStart() || text
  }
  return text
}

export function journalRows(
  events: TimelineEvent[], plans: PlanDocument[], fallbackDate?: string, closedAt?: string | null,
  opts?: { includeBookkeeping?: boolean; vocab?: JournalLink[] },
): JournalPrintRow[] {
  const closedMs = closedAt ? Date.parse(closedAt) : NaN
  return events
    .filter((e) => {
      // attendance/material bookkeeping rows («X anwesend», «Ölbinder: 3 Sack») duplicate
      // the Anwesenheit/Mittel sections — hidden from the default print, shown only with
      // the detailed audit option (then EVERY action counts). Decided 2026-07-14.
      if (!opts?.includeBookkeeping && e.kind === 'team' && (e.icon === 'people' || e.icon === 'box')) return false
      if (e.kind === 'audio' || e.kind === 'photo' || e.kind === 'journal' || e.kind === 'team') return true
      if (e.kind === 'layer' || e.kind === 'history') return false
      return printableTacticalText(e)
    })
    .map((e) => {
      const iso = eventIso(e, fallbackDate)
      return {
        id: e.id,
        iso,
        timeLabel: iso ? formatDateTime(iso) : e.t,
        area: journalArea(e, plans),
        text: withoutAreaPrefix(e.text),
        // the same links the app marks, as bold on paper — the Rapport has no colour to spend,
        // and bold is what a reader already reads as «this is a name» (lib/journalLinks)
        markup: opts?.vocab?.length
          ? linkMarkup(withoutAreaPrefix(e.text), opts.vocab, escapeXml)
          : undefined,
        kind: e.kind,
        photoUrls: rowPhotos(e),
        audioUrl: e.audioUrl,
        transcript: e.transcript,
        nachtrag: Number.isFinite(closedMs) && iso != null && Date.parse(iso) > closedMs,
      }
    })
    .sort((a, b) => {
      if (a.iso && b.iso) return new Date(a.iso).getTime() - new Date(b.iso).getTime()
      if (a.iso) return -1
      if (b.iso) return 1
      return a.timeLabel.localeCompare(b.timeLabel)
    })
}

export function missingTranscriptCount(events: TimelineEvent[]): number {
  return events.filter((e) => e.kind === 'audio' && e.audioUrl && !(e.transcript ?? '').trim()).length
}

/** «Stand» of the printed Kroki — the instant the picture shows, as the framing panel's slider
 *  and the collapsed fold above it both say it.
 *
 *  Date AND time: on a long Einsatz «21:14» alone does not say which day, and the printed caption
 *  carries the full stamp — the control must not say less than the paper. No year, unlike
 *  formatDateTime: this is read against a slider that spans one Einsatz. */
export function krokiStandLabel(ms: number | null): string {
  return ms == null ? appConfig.copy.preflight.krokiAtNow
    : new Date(ms).toLocaleString(appConfig.locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(appConfig.locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function proofLabel(proof: AuditProof): string {
  const r = appConfig.copy.report
  if (proof.offline || proof.intact == null) return r.proofOffline
  if (proof.intact) return r.proofIntact
  return proof.brokenAtSeq ? fillTemplate(r.proofBrokenAt, { seq: proof.brokenAtSeq }) : r.proofBroken
}

/** The Trupp's state as a word. Takes the whole Trupp, not just `status`: a Sicherungstrupp that
 *  was closed without ever going under PA shares the `raus` state but must not be printed as
 *  «draussen» — see lib/atemschutz · truppNeverDeployed. A bare status is still accepted for the
 *  callers that only have one. */
export function truppStatusLabel(t: Trupp | Trupp['status']): string {
  const az = appConfig.copy.atemschutz
  if (typeof t !== 'string' && truppNeverDeployed(t)) return az.statusNotDeployed
  const status = typeof t === 'string' ? t : t.status
  return az.status[status] ?? status
}

/** The Auftrag TYPE as it reads, not as it is stored. The stored value is the config id
 *  (`loeschen`, `retten`), and the print sent it straight through — so the Atemschutz sheet
 *  said «loeschen», umlaut and capital and all. Same resolution the Atemschutz view uses. */
export function truppAuftragLabel(auftrag?: string): string | undefined {
  if (!auftrag) return undefined
  const known = appConfig.copy.atemschutz.auftragLabels[auftrag]
    ?? appConfig.atemschutz.auftrag.find((a) => a.id === auftrag)?.label
  if (known) return known
  // An id neither list knows — a Trupp from an older workspace, or a station that renamed its
  // Auftrag types. Print it the way an id READS rather than the way it is stored: the ids are
  // ASCII-transliterated like the symbol keys, so «loeschen» became «loeschen» on paper instead
  // of «Löschen». Last resort, not the normal path.
  const spelled = restoreUmlauts(auftrag)
  return spelled.charAt(0).toUpperCase() + spelled.slice(1)
}

export function readingKindLabel(kind: TruppReading['kind']): string {
  const r = appConfig.copy.report
  const az = appConfig.copy.atemschutz
  if (kind === 'registered') return az.readingKind.registered
  if (kind === 'entry') return r.truppEntry
  if (kind === 'contact') return az.readingKind.contact
  return az.readingKind.pressure
}

export function operationalExtentPoints(
  incidentCenter: LngLat,
  entities: Entity[],
  drawings: Drawing[],
  includeLiveVehicles: boolean,
): LngLat[] {
  const pts: LngLat[] = []
  for (const e of entities) {
    if (!Array.isArray(e.coord)) continue
    const liveVehicle = !!e.live || e.layer === appConfig.gps.layerId
    if (liveVehicle && !includeLiveVehicles) continue
    pts.push(e.coord)
  }
  for (const d of drawings) {
    if (!Array.isArray(d.coords)) continue
    pts.push(...d.coords)
    if (d.kind === 'circle' && d.coords[0] && d.radiusM) {
      const [lng, lat] = d.coords[0]
      const dLat = d.radiusM / 111_320
      const dLng = d.radiusM / (111_320 * Math.cos((lat * Math.PI) / 180) || 1e-6)
      pts.push([lng - dLng, lat - dLat], [lng + dLng, lat + dLat])
    }
  }
  // the placed content DEFINES the frame; the incident address only anchors it when
  // nothing is placed — including it always dragged the fit to the far-away alarm pin
  // and pushed the action to the page edge (Kroki feedback 2026-07-18)
  return pts.length > 0 ? pts : [incidentCenter]
}

export function describeDrawing(d: Drawing): string {
  const r = appConfig.copy.report
  if (d.kind === 'circle') return `${r.drawCircle}${d.radiusM ? ` ${fmtDistance(d.radiusM)}` : ''}`
  if (d.kind === 'area') return d.label ? fillTemplate(r.drawAreaLabeled, { label: d.label }) : r.drawArea
  if (d.label) return d.label
  if (d.marker === 'R') return r.drawRescueAxis
  if (d.showDistance) return r.drawMeasureArrow
  return r.drawLine
}

/** The Einsatzleiter as drawn on the Lage, for pre-filling the Rapport field that would
 *  otherwise be typed a second time. Read in doctrine order:
 *    1. the Einsatzleiter glyph — its 'Name' (roster picker), else its own label,
 *    2. an Offizier whose Funktion says Einsatzleiter (a rank-led picture without the EL glyph),
 *    3. any symbol carrying a filled field literally named «Einsatzleiter» (KP Front, typically).
 *  Returns undefined when nothing names a person — the field then stays empty rather than
 *  guessing. Only a PRE-fill: whatever the operator types in the Rapport wins. */
export function einsatzleiterFromScene(entities: Entity[] = []): string | undefined {
  const syms = entities.filter((e) => e.kind === 'symbol')
  const val = (e: Entity, key: string) => e.fields?.[key]?.trim() || undefined
  const el = syms.find((e) => e.symbol === appConfig.symbols.einsatzleiterName && (val(e, 'Name') || e.label?.trim()))
  if (el) return val(el, 'Name') ?? el.label?.trim()
  const officer = syms.find((e) => /einsatzleit|^el$/i.test(e.fields?.Funktion?.trim() ?? '') && val(e, 'Name'))
  if (officer) return val(officer, 'Name')
  return syms.map((e) => val(e, 'Einsatzleiter')).find(Boolean)
}

/** Pre-formatted meta extras for the SERVER-rendered PDF (facts rows are placed, not
 *  computed, by the composer): Gerettete, Rückmeldung ELZ
 *  and the Alarmierungs-/Ausrückzeiten grid as [label, value] pairs. The grid ALWAYS
 *  prints (revised 2026-07-31, superseding Beschluss A of the field-classification):
 *  recorded times print as times, missing ones as `__:__` stubs for the pen. The old rule
 *  suppressed the whole section as soon as anything had been captured digitally, so a
 *  fully automatic alarm — the case the milestone integration exists for — produced a
 *  signed rapport with no Alarm- or Ausrückzeiten on it at all. Per-vehicle Vor-Ort- and
 *  Zurück-Zeiten stay digital-only; they are not fields on the paper form. */
export function metaExtrasForPdf(meta: ReportMeta, bounds?: IncidentBounds): {
  gerettete?: string
  rueckmeldungElz?: string
  zeiten: [string, string][]
  erfasser?: string
} {
  const R = appConfig.copy.report
  // Same midnight rule as the Personalblatt directly above this grid on the sheet — it dated its
  // clocks and this one did not, on the same page. «23:50 → 00:15» is 25 minutes or 23 hours
  // depending on a date that was nowhere on the paper.
  const fmt = spanAwareClock(bounds)
  const clock = (iso?: string) => fmt(iso) ?? ''
  const gerettete = meta.gerettete && (meta.gerettete.personen != null || meta.gerettete.tiere != null)
    ? [
        meta.gerettete.personen != null ? `${meta.gerettete.personen} ${R.gerettetePersonen}` : null,
        meta.gerettete.tiere != null ? `${meta.gerettete.tiere} ${R.geretteteTiere}` : null,
      ].filter(Boolean).join(' · ')
    : undefined
  const rk = meta.rueckmeldungElz
  const rueckmeldungElz = rk && (rk.name || rk.at)
    ? [rk.name, rk.at ? clock(rk.at) : null].filter(Boolean).join(' · ')
    : undefined
  const cfg = getDeploymentConfig()
  const gRows = gruppenRows(cfg.alarms?.groups ?? [], meta.gruppen)
  const vRows = fahrzeugRows(cfg.fleet?.vehicles ?? [], meta.fahrzeuge)
  const zeiten: [string, string][] = [
    ...gRows.map(({ config: c, value: v }): [string, string] => [
      c.color ? `${c.label} (${c.color})` : c.label, clock(v?.alarmedAt),
    ]),
    ...vRows.map(({ config: c, value: v }): [string, string] => [c.label, clock(v?.ausgerueckt)]),
  ]
  return {
    gerettete, rueckmeldungElz, zeiten,
    erfasser: meta.erfasser || undefined,
  }
}

/** The Personal-/Soldblatt rows for the SERVER-rendered PDF: the FULL roster as tick-off
 *  rows (recorded people get a printed tick + their recorded clocks, the rest stays blank
 *  for the pen — the printed rapport is a pre-filled Erfassungsblatt, decided 2026-07-17),
 *  then guests recorded outside the roster, then two blank write-in rows. Stunden are
 *  deliberately absent: WinFAP computes them from von–bis.
 *
 *  Someone who left and came back gets ONE ROW PER BLOCK (same name, own von–bis) rather than
 *  an outer span that would silently bill the hours they were away. */
/** One printed roster line. `vonDerived`/`bisDerived` mark a time the app worked out from the
 *  incident's own bounds rather than one somebody recorded — the sheet prints those grey. */
/** One stretch a person was on scene. A crew that came back after a break has several. */
export interface PersonalPdfTime {
  von?: string
  bis?: string
  /** this clock was DERIVED from the incident's bounds, not recorded — printed grey */
  vonDerived?: boolean
  bisDerived?: boolean
}

/** ONE row per person, however many times they came and went. It used to be one row per BLOCK,
 *  so somebody who left and came back printed their name twice on the roster and was counted
 *  twice by anyone reading down the column — the sheet has to say «who was here», and a name is
 *  a person, not a shift. The stretches stack in the time column instead. */
export interface PersonalPdfRow {
  name: string
  erfasst: boolean
  times?: PersonalPdfTime[]
  note?: string
}

/** «07.08.» — the day in front of a clock reading, for an Einsatz that runs past midnight. */
const dayShort = (d: Date) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`

/** The incident's own bounds — what decides whether a printed clock needs its date. */
export interface IncidentBounds { alarmedAt?: string | null; endedAt?: string | null }

/**
 * The one midnight rule for everything printed on the rapport: bare `08:23` on an ordinary
 * one-day sheet, `23.06. 08:23` once the Einsatz actually spans days.
 *
 * Bare HH:MM is a lie over midnight — «08:23 – 09:00» reads as 37 minutes when it was 25 hours.
 * The date rides along only when it has to, so the ordinary sheet stays as narrow as it was.
 * Shared rather than re-implemented: it lived inside personalForPdf, which is why the Zeiten
 * grid and the Rückmeldung ELZ on the SAME PAGE printed undated clocks.
 */
export function spanAwareClock(bounds?: IncidentBounds): (iso?: string | null) => string | undefined {
  const a = bounds?.alarmedAt ? new Date(bounds.alarmedAt) : null
  const e = bounds?.endedAt ? new Date(bounds.endedAt) : null
  const spansDays = !!a && !!e && Number.isFinite(a.getTime()) && Number.isFinite(e.getTime())
    && a.toDateString() !== e.toDateString()
  return (iso?: string | null) => {
    if (!iso) return undefined
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return undefined
    return spansDays ? `${dayShort(d)} ${hhmm(d)}` : hhmm(d)
  }
}

/** Human names for the Rapportangaben, for the Verlaufszeile that records a change to them. */
const META_FIELD_LABELS: Record<string, string> = {
  einsatzleiter: 'Einsatzleiter', kontaktperson: 'Kontaktperson', kommandant: 'Kommandant',
  summary: 'Kurzbericht', remarks: 'Bemerkungen', lehren: 'Lehren',
  endedAt: 'Einsatzende', ausgeruecktAt: 'Ausgerückt', alarmiertAt: 'Alarmierung',
  gerettete: 'Gerettete', rueckmeldungElz: 'Rückmeldung ELZ',
  partnerContacts: 'Partnerorganisationen', gruppen: 'Alarmzeiten', fahrzeuge: 'Fahrzeugzeiten',
  mittelConfirmedNone: 'Material «keine»', erfasser: 'Erfasser', krokiPrint: 'Kroki-Ausschnitt',
}

/** Fields whose change is bookkeeping ABOUT the rapport rather than a statement about the
 *  Einsatz — logging them would bury the ones that matter. */
const META_QUIET = new Set(['erfasser', 'krokiPrint'])

/** Fields short enough to print their new value in the Verlauf line. A Kurzbericht or a
 *  Bemerkung is a paragraph — quoting it would turn the log into a second copy of the rapport,
 *  so those report only THAT they were written (see `_prose`). */
const META_SHORT = new Set([
  'einsatzleiter', 'kontaktperson', 'kommandant', 'endedAt', 'ausgeruecktAt', 'alarmiertAt',
])

/** Free-text fields: say what happened to them, never what they now say. */
const META_PROSE = new Set(['summary', 'remarks', 'lehren'])

const _hasText = (v: unknown) => typeof v === 'string' && v.trim().length > 0

/**
 * Which Rapportangaben actually changed between two versions, AS THE VERLAUF PRINTS THEM — the
 * content of the printed rapport (Einsatzleiter, Endezeit, Gerettete, Partnerorganisationen …)
 * used to change with no journal row at all, and then with a row that named the field and
 * nothing else: «Rapportangaben geändert: Bemerkungen» tells a reader that something happened
 * to something, which is the least a log can say.
 *
 * A short field now carries its new value; a free-text one says whether it was written,
 * rewritten or cleared. Empty when nothing worth a line moved, so the caller stays silent.
 */
export function changedReportMetaFields(prev: ReportMeta, next: ReportMeta): string[] {
  const P = appConfig.copy.preflight
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
  const out: string[] = []
  // ⚠️ The header Ausrückzeit is DERIVED from the Fahrzeug grid (deriveAusgerueckt), and one tap
  // in that grid persists both. Logged separately they printed the same fact twice in one row —
  // «Ausgerückt «10.08.2026, 14:05», Fahrzeugzeiten» — so when the vehicles moved, the vehicles
  // are the statement and the derived header is not.
  const fahrzeugeMoved = JSON.stringify(prev.fahrzeuge ?? null) !== JSON.stringify(next.fahrzeuge ?? null)
  for (const k of keys) {
    if (META_QUIET.has(k)) continue
    if (k === 'ausgeruecktAt' && fahrzeugeMoved) continue
    const a = (prev as Record<string, unknown>)[k]
    const b = (next as Record<string, unknown>)[k]
    // structural compare: gruppen/fahrzeuge/partnerContacts are arrays of objects, and an
    // identity check would report a change on every re-render that rebuilt them
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue
    // the structured fields write their own sentences — see `_structuredMetaLines`
    const structured = _structuredMetaLines(k, a, b)
    if (structured) { out.push(...structured); continue }
    const label = META_FIELD_LABELS[k]
    // A key with no human name is an internal one (`startedAt`, `alarmText`) — printing the
    // identifier put «startedAt» on the signed rapport, which is worse than saying nothing.
    if (!label) continue
    if (META_PROSE.has(k)) {
      const verb = !_hasText(b) ? P.metaCleared : _hasText(a) ? P.metaRewritten : P.metaWritten
      out.push(`${label} ${verb}`)
    } else if (META_SHORT.has(k) && _hasText(b)) {
      const shown = k.endsWith('At') ? (formatDateTime(b as string) || String(b)) : String(b).trim()
      out.push(fillTemplate(P.metaValue, { label, value: shown }))
    } else if (META_SHORT.has(k)) {
      out.push(`${label} ${P.metaCleared}`)
    } else {
      out.push(label)
    }
  }
  return out.sort((x, y) => x.localeCompare(y, 'de'))
}

/** hh:mm for a Verlauf line about a Rapport time; the raw value if it will not parse. */
const _clock = (iso?: string) => (iso ? formatDateTime(iso) || iso : '')

/**
 * The Rapportangaben that are STRUCTURES rather than values — and therefore the ones that used
 * to log nothing but their own name. Returns one line per thing that actually moved, or
 * `undefined` for a key this does not handle (the caller falls back to the generic path).
 *
 * ⚠️ Each of these blocks is edited one row at a time — tick Polizei, tick Sanität, type a
 * remark — and every row starts its own debounce window. Naming the row is what makes three
 * consecutive entries three readable statements instead of three identical ones.
 */
function _structuredMetaLines(k: string, a: unknown, b: unknown): string[] | undefined {
  const P = appConfig.copy.preflight
  if (k === 'rueckmeldungElz') {
    const rk = (b ?? {}) as { name?: string; at?: string }
    const name = rk.name?.trim()
    const t = _clock(rk.at)
    if (name && t) return [fillTemplate(P.metaRueckmeldung, { name, t })]
    if (name) return [fillTemplate(P.metaRueckmeldungName, { name })]
    if (t) return [fillTemplate(P.metaRueckmeldungTime, { t })]
    return [`${META_FIELD_LABELS.rueckmeldungElz} ${P.metaCleared}`]
  }
  if (k === 'gerettete') {
    const value = _geretteteText(b as { personen?: number; tiere?: number } | undefined)
    return [value ? fillTemplate(P.metaGerettete, { value }) : `${META_FIELD_LABELS.gerettete} ${P.metaCleared}`]
  }
  if (k === 'mittelConfirmedNone') return [b ? P.metaMittelNoneOn : P.metaMittelNoneOff]
  if (k === 'partnerContacts') return _partnerLines((a ?? []) as PartnerContact[], (b ?? []) as PartnerContact[])
  if (k === 'gruppen') return _gruppenLines((a ?? []) as GruppeZeit[], (b ?? []) as GruppeZeit[])
  if (k === 'fahrzeuge') return _fahrzeugLines((a ?? []) as FahrzeugZeit[], (b ?? []) as FahrzeugZeit[])
  return undefined
}

/** «2 Personen · 1 Tier» — the same wording the printed rapport uses. */
function _geretteteText(g?: { personen?: number; tiere?: number }): string {
  const R = appConfig.copy.report
  if (!g || (g.personen == null && g.tiere == null)) return ''
  return [
    g.personen != null ? `${g.personen} ${R.gerettetePersonen}` : null,
    g.tiere != null ? `${g.tiere} ${R.geretteteTiere}` : null,
  ].filter(Boolean).join(' · ')
}

/** Partnerorganisationen, diffed BY ORGANISATION: who was added, who was removed, whose remark
 *  changed. Blank rows (the two the block always keeps ready) are not organisations and are
 *  skipped, or opening the sheet would log two arrivals nobody recorded. */
function _partnerLines(before: PartnerContact[], after: PartnerContact[]): string[] {
  const P = appConfig.copy.preflight
  const key = (p: PartnerContact) => (p.org ?? '').trim().toLowerCase()
  const named = (xs: PartnerContact[]) => xs.filter((p) => [p.org, p.name, p.phone, p.note].some((v) => v?.trim()))
  const A = new Map(named(before).map((p) => [key(p), p]))
  const B = new Map(named(after).map((p) => [key(p), p]))
  const out: string[] = []
  for (const [k, p] of B) {
    const org = (p.org ?? '').trim()
    if (!A.has(k)) { out.push(org ? fillTemplate(P.metaPartnerAdded, { org }) : P.metaPartnerUnnamed); continue }
    const note = (p.note ?? '').trim()
    if (note !== (A.get(k)?.note ?? '').trim() && note) out.push(fillTemplate(P.metaPartnerNote, { org, note }))
  }
  for (const [k, p] of A) {
    if (!B.has(k)) out.push(fillTemplate(P.metaPartnerRemoved, { org: (p.org ?? '').trim() }))
  }
  return out
}

/** Alarmzeit per Gruppe, named by its configured label — «g2» means nothing on paper. */
function _gruppenLines(before: GruppeZeit[], after: GruppeZeit[]): string[] {
  const P = appConfig.copy.preflight
  const labels = new Map((getDeploymentConfig().alarms?.groups ?? []).map((g) => [g.id, g.label || g.id]))
  const A = new Map(before.map((g) => [g.id, g]))
  const out: string[] = []
  for (const g of after) {
    if (A.get(g.id)?.alarmedAt === g.alarmedAt) continue
    const gruppe = labels.get(g.id) ?? g.id
    out.push(g.alarmedAt
      ? fillTemplate(P.metaGruppe, { gruppe, t: _clock(g.alarmedAt) })
      : fillTemplate(P.metaGruppeCleared, { gruppe }))
  }
  return out
}

/** The three Fahrzeug clocks, one line each — «Fahrzeugzeiten» named neither the vehicle nor
 *  which of its three times moved, on the grid where a whole Wehr's turnout is entered. */
function _fahrzeugLines(before: FahrzeugZeit[], after: FahrzeugZeit[]): string[] {
  const P = appConfig.copy.preflight
  const labels = new Map((getDeploymentConfig().fleet?.vehicles ?? []).map((v) => [v.id, v.label || v.id]))
  const A = new Map(before.map((v) => [v.id, v]))
  const out: string[] = []
  const slots: [keyof FahrzeugZeit, string][] = [
    ['ausgerueckt', P.metaFahrzeugAus], ['vorOrt', P.metaFahrzeugVorOrt], ['zurueck', P.metaFahrzeugZurueck],
  ]
  for (const v of after) {
    const fahrzeug = labels.get(v.id) ?? v.id
    const prev = A.get(v.id)
    for (const [slot, tpl] of slots) {
      const now = v[slot] as string | undefined
      if ((prev?.[slot] as string | undefined) === now) continue
      out.push(now ? fillTemplate(tpl, { fahrzeug, t: _clock(now) }) : fillTemplate(P.metaFahrzeugCleared, { fahrzeug }))
    }
  }
  return out
}

export function personalForPdf(
  roster: { id: string; name: string }[],
  attendance: AttendanceState,
  /** the incident's own bounds. They fill in what was never recorded: somebody ticked present
   *  with no check-in was there from the alarm, and somebody still present when the rapport is
   *  printed was there to the end. Both are DERIVED, and print grey so the paper says which
   *  times were measured and which the app worked out — a signed sheet must not blur the two. */
  bounds: { alarmedAt?: string | null; endedAt?: string | null } = {},
): { personal: PersonalPdfRow[] } {
  const clock = spanAwareClock(bounds)
  // Two ticks a minute apart are a correction, not a person who went home — see
  // attendanceIntervals · mergeCloseBlocks. The RECORD keeps both; the sheet prints one line.
  const gapMin = attendanceMergeGapMin()
  const rows = (name: string, a?: AttendanceState[string]): PersonalPdfRow[] => {
    const blocks = mergeCloseBlocks(intervalsOf(a), gapMin)
    if (!blocks.length) {
      const von = a ? clock(bounds.alarmedAt) : undefined
      const bis = a ? clock(bounds.endedAt) : undefined
      return [{ name, erfasst: !!a, times: [{ von, bis, vonDerived: !!von, bisDerived: !!bis }], note: a?.note }]
    }
    const alarmClock = clock(bounds.alarmedAt)
    const times = blocks.map((iv, i) => {
      const open = !iv.to
      const bis = open ? clock(bounds.endedAt) : clock(iv.to)
      const von = clock(iv.from)
      return {
        von, bis,
        // Somebody who was there from the alarm is the ordinary case, and their start is the
        // incident's own — nothing to check against. Only a check-in that DIFFERS from the
        // alarm says something the paper has to be read for. (First block only: a return
        // later in the Einsatz that happens to fall on the alarm minute is a real arrival.)
        vonDerived: i === 0 && !!von && von === alarmClock,
        // only the LAST open block inherits the incident's end — an earlier open block would
        // mean a missing check-out mid-incident, and filling that in would invent hours
        bisDerived: open && !!bis,
      }
    })
    // one row, every stretch — and the remark once, because it belongs to the person
    return [{ name, erfasst: true, times, note: a?.note }]
  }
  const rosterIds = new Set(roster.map((p) => p.id))
  const guests = Object.entries(attendance)
    .filter(([id]) => !rosterIds.has(id))
    .map(([, a]) => ({ name: a.displayNameSnapshot, a }))
    .sort((x, y) => x.name.localeCompare(y.name, 'de'))
    .flatMap(({ name, a }) => rows(name, a))
  return {
    personal: [
      ...roster.flatMap((p) => rows(p.name, attendance[p.id])),
      ...guests,
      { name: '', erfasst: false }, { name: '', erfasst: false },
    ],
  }
}

/** The Material worksheet rows for the SERVER-rendered PDF: the FULL catalogue,
 *  alphabetical (config load-out order reads as random on paper — 2026-07-18), with
 *  recorded totals filled in and amount stubs everywhere else — same shape as the blank
 *  Erfassungsblatt — plus recorded lines that aren't plain catalogue rows (custom
 *  labels / sourced positions) appended so nothing recorded is ever hidden. */
export function mittelFormForPdf(
  mittel: MittelEntry[],
  catalogue: { id: string; label: string; unit?: string }[],
): { mittelForm: { label: string; menge?: string; unit: string; note?: string }[] } {
  const noSource = appConfig.copy.mittel.noSource
  const recorded = mittelReportRows(mittel, noSource)
  const byKey = new Map(recorded.map((r) => [r.materialKey, r]))
  const rows: { label: string; menge?: string; unit: string; note?: string }[] = []
  // the remarks written on the line(s) behind this material — «an Werkhof übergeben», «defekt».
  // Joined because one material can be logged from two sources, each with its own note.
  const noteOf = (r: (typeof recorded)[number] | undefined) =>
    [...new Set((r?.items ?? []).map((i) => i.note?.trim()).filter(Boolean) as string[])].join(' · ') || undefined
  const sorted = [...catalogue].sort((a, b) => a.label.localeCompare(b.label, 'de-CH'))
  for (const c of sorted) {
    const unit = c.unit || appConfig.mittel.defaultUnit
    const hit = byKey.get(`${c.id}|${unit.trim().toLowerCase()}`)
    if (hit) byKey.delete(hit.materialKey)
    rows.push({ label: c.label, menge: hit && hit.total > 0 ? String(hit.total) : undefined, unit, note: noteOf(hit) })
  }
  for (const r of byKey.values()) {
    if (r.total <= 0) continue
    const sources = r.sources.filter((s) => s !== noSource)
    rows.push({ label: sources.length ? `${r.label} · ${sources.join(', ')}` : r.label, menge: String(r.total), unit: r.unit, note: noteOf(r) })
  }
  return { mittelForm: rows }
}

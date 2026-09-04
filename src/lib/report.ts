import type { AttendanceState, BoardAnno, BoardDoc, Drawing, Entity, LngLat, MittelEntry, PlanDocument, TimelineEvent, Trupp, TruppReading } from '../types'
import type { FahrzeugZeit, GruppeZeit, PartnerContact, ReportMeta } from './workspace'
import { allAuftragTypes, appConfig } from '../config/appConfig'
import { fmtDistance } from './geo'
import { fillTemplate, fmtDuration, hhmm, pad2, restoreUmlauts } from './format'
import { fahrzeugRows, gruppenRows } from './alarmzeiten'
import { intervalsOf, mergeCloseBlocks } from './attendanceIntervals'
import { truppNeverDeployed } from './atemschutz'
import { attendanceMergeGapMin, getDeploymentConfig } from './deploymentConfig'
import { mittelReportRows } from './mittel'
import { repeatRuns, rowPhotos, rowText } from './verlauf'
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
  /** «Aufträge / Pendenzen» — its OWN section, deliberately not folded into `journal`: dropping
   *  the long Einsatzjournal is a normal choice, and the outstanding items are the last thing
   *  that should go with it. */
  pendenzen: boolean
  /** print the Rapport-Beilagen (document/damage photos) as full-width plates at the end */
  attachments: boolean
  detailedAudit: boolean
}

export const defaultReportOptions: ReportOptions = {
  // ⚠️ The SHEET overrides this from the live scene (`kroki: mapContentCount > 0`) — a rapport
  // with nothing drawn prints no empty map. This stays true for the callers that have no scene
  // to judge by (the QR-Erfassung's own PDF), where the option is moot anyway.
  kroki: true,
  krokiView: null,
  krokiAt: null,
  // ⚠️ HOCH. The rapport is a portrait document; a landscape Kroki turns the one page people
  // actually look at sideways in the middle of the stack. See ReportPreflight for the same
  // default on the sheet itself.
  krokiLandscape: false,
  annotatedPlans: true,
  allPlans: false,
  atemschutz: true,
  attendance: true,
  mittel: true,
  journal: true,
  // ⚠️ ITS OWN section, not a part of the Verlauf. It was gated on `journal` at first, and that is
  // wrong twice over: suppressing the long Einsatzjournal is a common and reasonable choice, and
  // the one thing you would never want to drop with it is the list of what is still outstanding.
  pendenzen: true,
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
    if (a.kind === 'circle') return (a.radiusN ?? 0) > 0
    if (a.kind === 'symbol' || a.kind === 'shape' || a.kind === 'resource') return true
    return false
  })
}

/** `twinAnnos` (30.08.): mirrored Karte content projected onto a linked sheet counts as an
 *  annotation too — the field drew the whole Lage on the map, saw it standing on the Modul,
 *  and the printed Rapport attached nothing because the sheet itself carried no stroke. */
export function annotatedPlans(plans: PlanDocument[], board: BoardDoc, includeAll: boolean, twinAnnos?: Record<string, BoardAnno[]>): PlanDocument[] {
  return includeAll ? plans : plans.filter((p) => hasVisiblePlanAnnotation(board, p.id) || (twinAnnos?.[p.id]?.length ?? 0) > 0)
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
  /** a memo transcribed in sections: one line per section, offset-prefixed («0:05  Rückzug …»).
   *  `transcript` still carries the joined words so an older server prints something. */
  transcriptLines?: string[]
  /** the entry with its linked terms in <b>…</b>, for the PDF. Absent when nothing is linked —
   *  the composer then prints `text` verbatim, as it always did. */
  markup?: string
  /** row was appended AFTER the Einsatzende (closed_at) — printed under «Nachträge» */
  nachtrag?: boolean
  /** HH:MM of the LAST correction + the FIRST wording — the print shows both («korrigiert
   *  HH:MM · ursprünglich: …») and skips intermediate revisions. Absent on untouched rows. */
  correctedAt?: string
  textOriginal?: string
  /** how often this line repeated within the repeat window (lib/verlauf · repeatRuns). >1 prints
   *  as «6×» after the entry; the repeats themselves are in the record, not on the paper. */
  repeats?: number
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
  // ── the rows the SERVER wrote about the incident itself, before anything else ──
  // «Rapport abgeschlossen», «Einsatz abgeschlossen», «Einsatz wiedereröffnet» carry neither
  // `kind` nor `surface` (backend · journal.append_system_row), so until 04.09. every one of
  // them fell through the whole chain to `areaLage` and printed as «Kroki Rapport
  // abgeschlossen» — a Bereich that sends the reader to the map for an act performed in the
  // Rapport. The `sys` id prefix is the handle: the server mints it, no client id starts with
  // it (lib/ids · newId, IncidentWorkspace · pushEvent), and it is already on every such row
  // in every existing record — which an append-only journal needs, because these rows can
  // never be rewritten to carry a new field.
  if (e.id.startsWith('sys')) return r.areaSystem
  // ── hand-written first, whatever surface it was written on ──
  // a Checklisten-Haken is a documented decision, not a free note — and it is the only other
  // thing `journal` is written for besides the composer
  if (e.kind === 'journal' && e.icon === 'check') return r.areaChecklist
  // ⚠️ A row that WAS given a type says so in this column. «Manuell» answers «wo kam das her»,
  // which is the least interesting thing about an Auftrag or a Sofortmassnahme — and the type
  // was already in the text as a «Auftrag · » prefix, so the printed row carried the word twice
  // and the column carried nothing. Now the column IS the type and `withoutAreaPrefix` drops
  // the duplicate from the text. `info` keeps «Manuell»: it is the ordinary case and prints no
  // tag anywhere else either.
  if (e.entryType && e.entryType !== 'info') {
    return appConfig.copy.journal.entryTypes[e.entryType] ?? r.areaManual
  }
  // …and a row raised by the ring is a Pendenz even without a typed tag — on screen the row
  // carries the «Pendenz» chip, so the printed column says the same word. AFTER the entryType
  // branch: an «Auftrag» with an Erinnerung is still an Auftrag. Covers the whole lifecycle
  // (created, Meldung, erledigt) — every one of those rows is about the item.
  if (e.kind === 'reminder' || e.reminder) return appConfig.copy.journal.noteChip
  if (e.kind === 'audio' || e.kind === 'photo' || e.kind === 'journal' || e.pinned) return r.areaManual
  // ── then by ICON, which is what actually separates the writers ──
  // ⚠️ Every row the QR poster writes has NO kind at all (lib/captureClient · row), so a rule
  // that went by kind classified all of them as map-tactical. The icon is the only thing the
  // tablet's rows and the poster's rows have in common.
  // ⚠️ …and by TEXT where the icon is shared. The Anwesenheit's undo wrote icon 'undo', which is
  // also the Atemschutz-Rückzug's, so «Anwesenheit zurückgenommen: Studer Corinne» printed under
  // «Atemschutz». New rows carry 'people' (IncidentWorkspace · stepAttendance); this reads the
  // ones already in the record, off the same copy template that wrote them.
  if (startsWithTemplate(e.text, appConfig.copy.anwesenheit.undone)
    || startsWithTemplate(e.text, appConfig.copy.anwesenheit.redone)) return r.areaAnwesenheit
  if (e.icon === 'clipboard') return r.areaRapport
  // Beilage added/removed at the poster. TWO glyphs, one Bereich: 'attach' is what
  // `captureClient` writes since 23.08., 'photo' is what it wrote before — and the record is
  // append-only, so the old rows have to keep classifying as they always did. Same problem, and
  // the same answer, as `startsWithTemplate` below. The split exists for the SCREEN: the Verlauf
  // row's disc is now the whole classification (Journal · journalDisc), and #photo was also the
  // glyph of a composer photo entry, which is «Manuell» two branches further up.
  if (e.icon === 'attach' || e.icon === 'photo') return r.areaRapport
  // ⚠️ 'clock' means Anwesenheit here and nothing else: the poster's Zeiten rows carry it. Snooze
  // rows carried it too until 23.08., but every one of them has a `reminder` and is answered as
  // «Pendenz» above, so they never reach this line — new ones carry 'bell' (lib/useReminders).
  if (e.icon === 'people' || e.icon === 'user' || e.icon === 'clock') return r.areaAnwesenheit
  if (e.icon === 'box') return r.areaMittel
  // everything else the Atemschutz board writes: Kontakt, Druck, Leitung, Alarm, Sicherheitswerte
  if (e.kind === 'team') return r.areaAtemschutz
  if (e.surface === 'plan') return planLabel(plans.find((p) => p.id === e.planId), e.floor)
  return r.areaLage
}

/**
 * The Verlauf's icon disc, in words: the Bereich as the SCREEN names it, plus which of the two
 * drawing surfaces it is — the disc's tint — or null for everything that is neither.
 *
 * This is what the Bereich chip used to be. The chip printed the word on every row, beside a
 * sentence that already carried it («Auftrag · …») and beside a second chip saying «Pendenz»;
 * the disc says it once, in the one slot every row already has. The word survives here for the
 * disc's title and for the Verlauf's legend.
 *
 * ⚠️ The tint is derived from the RESOLVED Bereich, never from `e.surface`: the generic logger
 * stamps 'map' on everything, which is how a Lage-blue chip once sat under the word «Atemschutz».
 * ⚠️ One name differs between screen and paper on purpose — the print says «Kroki» (the word
 * people search the export for), the tab on screen is called «Lage». See copy · report.areaLage.
 */
export function journalDisc(e: TimelineEvent, plans: PlanDocument[]): { label: string; surface: 'map' | 'plan' | null } {
  const area = journalArea(e, plans)
  if (area === appConfig.copy.report.areaLage) return { label: appConfig.copy.journal.surfaceMap, surface: 'map' }
  const onPlan = e.surface === 'plan' && area === planLabel(plans.find((p) => p.id === e.planId), e.floor)
  return { label: area, surface: onPlan ? 'plan' : null }
}

/** Does this row's text begin with what a copy template writes before its first placeholder?
 *  The only handle on rows whose icon cannot say where they came from — read from the live copy,
 *  so it answers in whatever locale wrote them. */
function startsWithTemplate(text: string, template: string): boolean {
  const prefix = template.split('{')[0].trim()
  return prefix.length > 0 && text.startsWith(prefix)
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
    // ⚠️ The `|| text` fallback stays HERE on purpose. «Rapportangaben» is not the word the
    // column prints («Rapport»), so a row stripped to nothing would leave the line with no
    // content at all and nothing beside it saying what it was.
    if (text.startsWith(p)) return text.slice(p.length).trimStart() || text
  }
  // …and the entry-type tag the composer writes into the text («Auftrag · Trupp 2 sichert»),
  // now that the Bereich column carries the same word. Only the printed row drops it — the
  // record keeps its wording, and the live Verlauf has no column to lean on.
  for (const [key, label] of Object.entries(appConfig.copy.journal.entryTypes)) {
    if (key === 'info') continue
    // ⚠️ The BARE tag counts too. A photo-only entry has no body, so the composer returns the
    // tag alone (lib/journalEntry · composeJournalText) and the row's entire text is the word
    // «Sofortmassnahme» — which printed twice on one line, once here and once in the Bereich.
    // Empty is the right Eintrag: the column carries the word and the picture IS the content,
    // so unlike the meta prefixes above this deliberately does NOT fall back to the text.
    if (text.trim() === label) return ''
    const tag = `${label} · `
    if (text.startsWith(tag)) return text.slice(tag.length).trimStart() || text
  }
  return text
}

/**
 * Paper NAMES the Beilagen a row carries.
 *
 * ⚠️ A generic Beilage (PDF, Dokument) has no plate in the Rapport the way a photo does — the
 * file itself travels in the Beilagen-ZIP. Without this, a row whose only content IS a document
 * printed as an empty timestamped line, and the record lost the one thing it can still say:
 * which document belonged to that moment. Appended to the text, so it reaches the PDF through
 * `markup` (and its escaping) like every other word of the row.
 */
function withFileNames(text: string, files?: { name: string }[]): string {
  if (!files?.length) return text
  const C = appConfig.copy.journal
  const label = fillTemplate(files.length > 1 ? C.attachPrintMany : C.attachPrint, {
    names: files.map((f) => f.name).join(', '),
  })
  return text.trim() ? `${text} · ${label}` : label
}

export function journalRows(
  events: TimelineEvent[], plans: PlanDocument[], fallbackDate?: string, closedAt?: string | null,
  opts?: { includeBookkeeping?: boolean; vocab?: JournalLink[] },
): JournalPrintRow[] {
  const closedMs = closedAt ? Date.parse(closedAt) : NaN
  // …and a line the app repeated while nothing changed prints ONCE, with its count — the same
  // rule the Verlauf reads by, so paper and screen tell the same story (lib/verlauf).
  const repeats = repeatRuns(events)
  return events
    .filter((e) => {
      if (repeats.hidden.has(e.id)) return false
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
      // …and through `rowText` first, so a picture on paper carries no «Foto» caption either —
      // then the row's Beilagen by name, so a files-only line is not an empty line
      const text = withFileNames(withoutAreaPrefix(rowText(e)), e.files)
      return {
        id: e.id,
        iso,
        timeLabel: iso ? formatDateTime(iso) : e.t,
        area: journalArea(e, plans),
        text,
        // the same links the app marks, as bold on paper — the Rapport has no colour to spend,
        // and bold is what a reader already reads as «this is a name» (lib/journalLinks).
        // ⚠️ NOT gated on the vocabulary: an address is not vocabulary, so a row whose only mark
        // is a URL has to reach the PDF as markup too. `linkMarkup` returns undefined when the
        // row marked nothing, and that is the only case the backend escapes the text itself.
        markup: linkMarkup(text, opts?.vocab ?? [], escapeXml),
        kind: e.kind,
        photoUrls: rowPhotos(e),
        audioUrl: e.audioUrl,
        transcript: e.transcript ?? (e.transcriptSections?.length
          ? e.transcriptSections.map((s) => s.text).join(' · ')
          : undefined),
        transcriptLines: e.transcriptSections?.length
          ? [
              ...(e.transcript ? [e.transcript] : []),
              ...e.transcriptSections.map((s) => `${fmtDuration(s.at)}  ${s.text}`),
            ]
          : undefined,
        nachtrag: Number.isFinite(closedMs) && iso != null && Date.parse(iso) > closedMs,
        repeats: repeats.counts.get(e.id),
        correctedAt: e.correctedAt && e.textOriginal ? hhmm(new Date(e.correctedAt)) : undefined,
        // the original through the same prefix-strip as the latest text, or the two would
        // differ by the «Auftrag · » tag alone and read as a phantom correction
        textOriginal: e.correctedAt && e.textOriginal ? withoutAreaPrefix(e.textOriginal) : undefined,
      }
    })
    .sort((a, b) => {
      if (a.iso && b.iso) return new Date(a.iso).getTime() - new Date(b.iso).getTime()
      if (a.iso) return -1
      if (b.iso) return 1
      return a.timeLabel.localeCompare(b.timeLabel)
    })
}

/** One row of the Rapport's «Aufträge / Pendenzen» section — the BGV form's columns. */
export interface PendenzPrintRow {
  text: string
  assignee?: string
  urgent: boolean
  erteilt: string
  /** absent ⇒ still open when the Rapport was written; the cell prints «offen» */
  erledigt?: string
  /** HH:MM of the Erinnerung, when the item carried one — the LATEST Wiedervorlage (a Meldung
   *  can move it), the same rule the pinned block runs on (lib/reminders). */
  faellig?: string
  notes: { timeLabel: string; text: string }[]
}

/**
 * Every Auftrag / Pendenz the Einsatz raised — the OPEN ones and the closed ones alike.
 *
 * ⚠️ Not `deriveReminders`, which answers a different question: that one is «what is still open»,
 * for the block in the Verlauf. The paper is a record, so it prints the ones that were dealt with
 * too — a section that showed only the leftovers would say what went wrong and nothing about what
 * was ordered and done, which is most of an Einsatz.
 *
 * Both times come out of the record for free: `erteilt` is the entry's own timestamp, `erledigt`
 * the timestamp of the row that closed it. Nobody fills a form in for this.
 */
export function pendenzRows(events: TimelineEvent[], fallbackDate?: string): PendenzPrintRow[] {
  const clock = (e: TimelineEvent) => {
    const iso = eventIso(e, fallbackDate)
    return iso ? hhmm(new Date(iso)) : e.t
  }
  const created = new Map<string, TimelineEvent>()
  const doneAt = new Map<string, string>()
  const urgency = new Map<string, boolean>()
  const due = new Map<string, string>()
  const notes = new Map<string, { timeLabel: string; text: string }[]>()
  // oldest → newest, so «the latest wins» falls out of the iteration order
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    const r = e.reminder
    if (!r) continue
    if (r.urgent !== undefined) urgency.set(r.id, r.urgent)
    // any later row carrying a dueAt MOVES the Wiedervorlage (snooze, or a Meldung that
    // reschedules) — same rule as lib/reminders, so paper and pinned block agree
    if (r.dueAt) due.set(r.id, r.dueAt)
    if (r.op === 'created') created.set(r.id, e)
    else if (r.op === 'done') doneAt.set(r.id, clock(e))
    else if (r.op === 'note') notes.set(r.id, [...(notes.get(r.id) ?? []), { timeLabel: clock(e), text: e.text }])
  }
  return [...created.entries()]
    .map(([id, e]) => ({
      // the BARE text — the row's own text carries the «Auftrag · » tag or the «Erinnerung gesetzt
      // für …» lead-in, and the section's own heading already says what these are
      text: e.reminder?.text?.trim() || e.text,
      assignee: e.reminder?.assignee,
      urgent: !!urgency.get(id),
      erteilt: clock(e),
      erledigt: doneAt.get(id),
      faellig: due.has(id) ? hhmm(new Date(due.get(id)!)) : undefined,
      notes: notes.get(id) ?? [],
    }))
    // chronological by Erteilt, like the paper form it replaces — NOT the screen's
    // dringend-first order, which is a working order for a list you act on
    .sort((a, b) => a.erteilt.localeCompare(b.erteilt))
}

export function missingTranscriptCount(events: TimelineEvent[]): number {
  return events.filter((e) =>
    e.kind === 'audio' && e.audioUrl && !(e.transcript ?? '').trim() && !e.transcriptSections?.length).length
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

/**
 * «16.08.2026 15:35» — date and time, one space between them.
 *
 * ⚠️ Composed from the two parts rather than taken from `toLocaleString`, which puts a COMMA
 * between them. On the printed Verlauf that comma cost the Zeit column real width — the column has
 * to fit the longest label without wrapping, and it is the narrowest column on the page beside the
 * one carrying every entry's text. It also says nothing: a date followed by a time is not a list.
 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const date = d.toLocaleDateString(appConfig.locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
  const time = d.toLocaleTimeString(appConfig.locale, { hour: '2-digit', minute: '2-digit' })
  return `${date} ${time}`
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
  // ⚠️ Taken off the Tafel outranks the status it was left in: the Rapport prints it (types ·
  // Trupp.removedAt), and a deleted Trupp still listed as «aktiv» would read as a crew nobody
  // ever brought back out.
  if (typeof t !== 'string' && t.removedAt) return az.statusRemoved
  if (typeof t !== 'string' && truppNeverDeployed(t)) return az.statusNotDeployed
  const status = typeof t === 'string' ? t : t.status
  return az.status[status] ?? status
}

/** The Auftrag TYPE as it reads, not as it is stored. The stored value is the config id
 *  (`loeschen`, `retten`), and the print sent it straight through — so the Atemschutz sheet
 *  said «loeschen», umlaut and capital and all. THE resolver: the board, the card chip, the
 *  «Auftrag» sort and the Rapport all read a label through here.
 *  ⚠️ It searches BOTH Auftrag lists (`allAuftragTypes`), never just the one matching the
 *  Trupp's kind — a Trupp recorded before the split, or one whose kind was mis-picked, carries
 *  an id from the other list and must still render its word rather than a blank chip. */
export function truppAuftragLabel(auftrag?: string): string | undefined {
  if (!auftrag) return undefined
  const known = appConfig.copy.atemschutz.auftragLabels[auftrag]
    ?? allAuftragTypes.find((a) => a.id === auftrag)?.label
  if (known) return known
  // An id neither list knows — a Trupp from an older workspace, or a station that renamed its
  // Auftrag types. Print it the way an id READS rather than the way it is stored: the ids are
  // ASCII-transliterated like the symbol keys, so «loeschen» became «loeschen» on paper instead
  // of «Löschen». Last resort, not the normal path.
  const spelled = restoreUmlauts(auftrag)
  return spelled.charAt(0).toUpperCase() + spelled.slice(1)
}

/**
 * Was this row's pressure MEASURED, or carried over?
 *
 * ⚠️ `contact` and `rueckzug` rows store `lastPressureBar ?? entryPressureBar` — the last value
 * anybody reported, not a reading taken at that moment (useTruppActions · recordContact,
 * setTruppStatus). On the board that is harmless context; in the Rapport's pressure column it is a
 * number that looks measured and is not, on a signed document — «300 bar» beside a Kontakt twenty
 * minutes after the last real reading. The record keeps the value (it is what was known then); the
 * column stays empty for it.
 */
export function readingBarIsMeasured(kind: TruppReading['kind']): boolean {
  // …and neither is the Austritt or the Wiedereinstieg: both carry the last reported value
  // forward exactly like a Kontakt does (useTruppActions · setTruppStatus). `paOff` is the same
  // shape — the Überwachung ended, nobody read a gauge for it — while `paOn` carries the
  // Eingangsdruck of the cylinder that was just opened, which IS a reading.
  return kind !== 'contact' && kind !== 'rueckzug' && kind !== 'exit' && kind !== 'resume' && kind !== 'paOff'
}

/**
 * …and whether this row may PRINT its bar at all.
 *
 * ⚠️ Zero is not a pressure. A Trupp that was registered without Atemschutz carries a bar of 0 on
 * every row of its log — nobody was ever asked for an Eingangsdruck — and those rows survive the
 * Trupp being upgraded later (types · TruppReading `paOn`), which puts them on the Atemschutz page
 * of the Rapport. «Eingerückt 0 bar» reads as an empty cylinder, which is the one number on that
 * sheet nobody may misread. The row stays, the column is blank for it.
 */
export function readingBarShown(r: Pick<TruppReading, 'kind' | 'bar'>): boolean {
  return readingBarIsMeasured(r.kind) && r.bar > 0
}

/**
 * Every Eintritt and every Austritt this Trupp's LOG records — the header of its
 * Atemschutz-Detailprotokoll, read off the same rows the table below it prints.
 *
 * ⚠️ The log, not `entryTime`/`exitTime`. Those two are the LIVE card's state: a Trupp that goes
 * in, comes out, is re-registered and goes in again (useTruppActions · reactivateTrupp) overwrites
 * both, so the header printed the last cycle's Eintritt over the first cycle's rows and a reader
 * comparing the two saw the sheet contradict itself. They are also the fields the sync merge is
 * free to re-resolve from ONE side (mergeWorkspace · mergeTrupp), so two devices can leave the
 * scalar naming an instant the log never recorded — which is exactly what the 02.09. field report
 * saw: a header «Austritt 15:22» above a table whose Draussen row said 15:27. The appended rows
 * ARE the record: one source for both halves of the block, and every cycle survives.
 *
 * The scalars stay as the per-side FALLBACK, for a Trupp whose log predates the row that would
 * carry it: `exit` rows only exist since 19.08., and a Trupp registered before 09.08. may carry no
 * log at all.
 */
export function truppRunTimes(
  readings: readonly Pick<TruppReading, 't' | 'kind'>[] | undefined,
  fallback: { entryTime?: string; exitTime?: string },
): { entries: string[]; exits: string[] } {
  const of = (kind: TruppReading['kind']) =>
    (readings ?? []).filter((r) => r.kind === kind).map((r) => r.t).filter(Boolean)
  const entries = of('entry')
  const exits = of('exit')
  return {
    entries: entries.length ? entries : ([fallback.entryTime].filter(Boolean) as string[]),
    exits: exits.length ? exits : ([fallback.exitTime].filter(Boolean) as string[]),
  }
}

export function readingKindLabel(kind: TruppReading['kind']): string {
  const r = appConfig.copy.report
  const az = appConfig.copy.atemschutz
  if (kind === 'registered') return az.readingKind.registered
  if (kind === 'entry') return r.truppEntry
  if (kind === 'contact') return az.readingKind.contact
  // the two rows the sheet is read for — see types · TruppReading
  if (kind === 'alarm') return az.readingKind.alarm
  if (kind === 'rueckzug') return az.readingKind.rueckzug
  // the two that complete the chronology — the crew came out, or went back in
  if (kind === 'exit') return az.readingKind.exit
  if (kind === 'resume') return az.readingKind.resume
  // …and the two ends of the monitored stretch, where the Art was changed after the fact
  if (kind === 'paOn') return az.readingKind.paOn
  if (kind === 'paOff') return az.readingKind.paOff
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
    // ⚠️ A circle contributes only its CENTRE, never its radius. The Absperrkreis is the
    // biggest and least informative object on the picture, and letting its rim drive the fit
    // shrank every symbol, Trupp and Leitung to an unreadable fleck in the middle (19.08.
    // print). The ring may clip — its radius is in the legend («r = 100 m») either way.
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
  // Same midnight rule as the Personalblatt directly above this grid on the sheet — it dated its
  // clocks and this one did not, on the same page. «23:50 → 00:15» is 25 minutes or 23 hours
  // depending on a date that was nowhere on the paper.
  const fmt = spanAwareClock(bounds)
  const clock = (iso?: string) => fmt(iso) ?? ''
  // ⚠️ «keine» is a VALUE on the paper, not a blank (04.09.). An empty Gerettet-box meant four
  // things at once to whoever read the Rapport afterwards; once somebody has answered the
  // question, the answer prints — and a blank now means only «nicht erfasst».
  const gerettete = _geretteteText(meta.gerettete)
    || (meta.geretteteNone ? appConfig.copy.preflight.geretteteNonePrint : '')
    || undefined
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
  /** not on the Mannschaftsliste — a Gast, a Nachbarwehr, somebody not yet synced. The app has
   *  badged them on the Anwesenheit screen all along and the SHEET did not, so the one reader
   *  who cannot ask (a Gemeinde or a Versicherung reading a signed rapport weeks later) saw a
   *  name in the middle of our roster and had no way to know it was not one of ours. */
  guest?: boolean
}

/** «07.08.» — the day in front of a clock reading, for an Einsatz that runs past midnight. */
const dayShort = (d: Date) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.`

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
  kontaktpersonTelefon: 'Telefon Kontaktperson',
  summary: 'Kurzbericht', remarks: 'Bemerkungen', lehren: 'Lehren',
  endedAt: 'Einsatzende', ausgeruecktAt: 'Ausgerückt', alarmiertAt: 'Alarmierung',
  gerettete: 'Gerettete', rueckmeldungElz: 'Rückmeldung ELZ',
  partnerContacts: 'Partnerorganisationen', gruppen: 'Alarmzeiten', fahrzeuge: 'Fahrzeugzeiten',
  mittelConfirmedNone: 'Material «keine»', erfasser: 'Erfasser', krokiPrint: 'Kroki-Ausschnitt',
  // the two «Entfällt» answers write their own sentences (see _structuredMetaLines) — a label is
  // still needed, because that is what makes them a logged field rather than an internal key
  kontaktpersonNone: 'Kontaktperson', rueckmeldungNone: 'Rückmeldung ELZ',
}

/** Fields whose change is bookkeeping ABOUT the rapport rather than a statement about the
 *  Einsatz — logging them would bury the ones that matter.
 *
 *  `linksDone` is here DELIBERATELY, not by omission: ticking off the station's own paperwork
 *  (the Getränkeabrechnung, a Schadenmeldung — see lib/reportLinks) says nothing about what
 *  happened at the Einsatz, and the Verlauf is the record of the Einsatz. The tick itself is
 *  kept in the workspace blob with its timestamp, so it is neither invisible nor lost.
 *
 *  `printJob` is here for the same reason: which relay job a rapport is queued on is plumbing,
 *  not a statement about the Einsatz. The print itself is already recorded elsewhere. */
const META_QUIET = new Set(['erfasser', 'krokiPrint', 'linksDone', 'printJob'])

/** Fields short enough to print their new value in the Verlauf line. A Kurzbericht or a
 *  Bemerkung is a paragraph — quoting it would turn the log into a second copy of the rapport,
 *  so those report only THAT they were written (see `_prose`). */
const META_SHORT = new Set([
  'einsatzleiter', 'kontaktperson', 'kontaktpersonTelefon', 'kommandant', 'endedAt',
  'ausgeruecktAt', 'alarmiertAt',
])

/** Free-text fields: say what happened to them, never what they now say. */
const META_PROSE = new Set(['summary', 'remarks', 'lehren'])

const _hasText = (v: unknown) => typeof v === 'string' && v.trim().length > 0

/** What a Rapportangaben change produces, in the two shapes it comes in — see
 *  changedReportMetaLines. */
export interface ReportMetaLines {
  /** the scalar fields — label + quoted value / «geschrieben» verbs — alphabetical, like the
   *  one-row form always was */
  fields: string[]
  /** the structured blocks' complete standalone sentences («Partnerorganisation Sanität
   *  ergänzt …»), in DIFF order — adds before remark changes before removals — and NEVER
   *  re-sorted: each is its own statement, and alphabetising them scrambled the story
   *  («entfernt» before «ergänzt») when several landed in one row */
  statements: string[]
}

/**
 * Which Rapportangaben actually changed between two versions, AS THE VERLAUF PRINTS THEM — the
 * content of the printed rapport (Einsatzleiter, Endezeit, Gerettete, Partnerorganisationen …)
 * used to change with no journal row at all, and then with a row that named the field and
 * nothing else: «Rapportangaben geändert: Bemerkungen» tells a reader that something happened
 * to something, which is the least a log can say.
 *
 * A short field now carries its new value; a free-text one says whether it was written,
 * rewritten or cleared. Both lists empty when nothing worth a line moved, so the caller stays
 * silent. Fields and statements come back SEPARATELY so a caller can give each statement its
 * own Verlauf row instead of cramming three sentences into one.
 */
export function changedReportMetaLines(prev: ReportMeta, next: ReportMeta): ReportMetaLines {
  const P = appConfig.copy.preflight
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
  const fields: string[] = []
  const statements: string[] = []
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
    if (structured) { statements.push(...structured); continue }
    const label = META_FIELD_LABELS[k]
    // A key with no human name is an internal one (`startedAt`, `alarmText`) — printing the
    // identifier put «startedAt» on the signed rapport, which is worse than saying nothing.
    if (!label) continue
    if (META_PROSE.has(k)) {
      const verb = !_hasText(b) ? P.metaCleared : _hasText(a) ? P.metaRewritten : P.metaWritten
      fields.push(`${label} ${verb}`)
    } else if (META_SHORT.has(k) && _hasText(b)) {
      const shown = k.endsWith('At') ? (formatDateTime(b as string) || String(b)) : String(b).trim()
      fields.push(fillTemplate(P.metaValue, { label, value: shown }))
    } else if (META_SHORT.has(k)) {
      fields.push(`${label} ${P.metaCleared}`)
    } else {
      fields.push(label)
    }
  }
  return { fields: fields.sort((x, y) => x.localeCompare(y, 'de')), statements }
}

/** The one-array view of changedReportMetaLines, for the callers that join everything into a
 *  single «Rapportangaben: …» row — everything sorted together, exactly as before the split. */
export function changedReportMetaFields(prev: ReportMeta, next: ReportMeta): string[] {
  const { fields, statements } = changedReportMetaLines(prev, next)
  return [...fields, ...statements].sort((x, y) => x.localeCompare(y, 'de'))
}

/**
 * Clears an «entfällt» flag the moment its answer arrives. «Entfällt» and a value are two
 * answers to the same question, and the sheet let both stand at once: type the Kontaktperson
 * after ticking «entfällt» and the record said «there is nobody to name — here is her name».
 *
 * Pure: takes the patch a save is about to apply and the state it applies to, and returns the
 * patch with the contradicted flags resolved — falsed when the flag was already ON (so the
 * Verlauf records the Widerruf), silently dropped when the same patch tried to set both.
 * The Mittel list lives outside ReportMeta, so its count comes in as context.
 */
export function normalizeReportMeta(
  patch: Partial<ReportMeta>,
  prev: ReportMeta,
  ctx: { mittelCount?: number } = {},
): Partial<ReportMeta> {
  const next = { ...prev, ...patch }
  const out = { ...patch }
  let changed = false
  const clear = (flag: 'kontaktpersonNone' | 'rueckmeldungNone' | 'mittelConfirmedNone' | 'geretteteNone') => {
    if (!next[flag]) return
    if (prev[flag]) { out[flag] = false; changed = true }
    else if (flag in out) { delete out[flag]; changed = true }
  }
  if (_hasText(next.kontaktperson) || _hasText(next.kontaktpersonTelefon)) clear('kontaktpersonNone')
  // a counted rescue and «keine» are the same contradiction the two above resolve
  const g = next.gerettete
  if ((g?.personen ?? 0) > 0 || (g?.tiere ?? 0) > 0) clear('geretteteNone')
  const rk = next.rueckmeldungElz
  if (rk && (_hasText(rk.name) || _hasText(rk.at))) clear('rueckmeldungNone')
  if ((ctx.mittelCount ?? 0) > 0) clear('mittelConfirmedNone')
  return changed ? out : patch
}

/** One stretch of the Einsatzleitung: who, and since when (`null` on a row without a usable
 *  timestamp). The «bis» of one span is the «ab» of the next — the caller renders that. */
export interface EinsatzleiterSpan {
  name: string
  fromTs: string | null
}

/** Matches the «Einsatzleiter «Name»» fragment a Rapportangaben row carries (the META_SHORT
 *  quoting above) — built from the LIVE metaValue template, so it reads rows in whatever locale
 *  wrote them, the same reasoning as startsWithTemplate. */
function _einsatzleiterPattern(): RegExp {
  const marker = '\u0000'
  const filled = fillTemplate(appConfig.copy.preflight.metaValue, { label: META_FIELD_LABELS.einsatzleiter, value: marker })
  const escaped = filled.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped.replace(marker, '(.+?)'), 'g')
}

/**
 * The Einsatzleiter SUCCESSION, read out of the incident's own Verlauf — the rapport field only
 * holds the latest name, but a handover mid-Einsatz is exactly the kind of fact a signed record
 * is later read for. Every Rapportangaben row that quotes an Einsatzleiter (tablet and QR poster
 * both write the same metaValue fragment) contributes a span; oldest first, and re-saving the
 * unchanged name is no handover, so consecutive repeats fold away. A later return of an earlier
 * name stays — that IS a handover. Structured data only; the caller renders
 * «Einsatzleitung: A (bis 14:20), B (ab 14:20)».
 */
export function einsatzleiterSuccession(events: TimelineEvent[], fallbackDate?: string): EinsatzleiterSpan[] {
  const pattern = _einsatzleiterPattern()
  const out: EinsatzleiterSpan[] = []
  // oldest → newest, same iteration as pendenzRows — the Verlauf array is newest-first
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    let name: string | undefined
    pattern.lastIndex = 0
    // the LAST mention in a row wins — one debounced row can carry several joined fields
    for (const m of e.text.matchAll(pattern)) name = m[1]?.trim() || name
    if (!name) continue
    if (out.length && out[out.length - 1].name === name) continue
    out.push({ name, fromTs: eventIso(e, fallbackDate) })
  }
  return out
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
  // …and the answer «es gab keine», which is a statement of its own and not an empty field
  if (k === 'geretteteNone') return [b ? P.metaGeretteteNone : P.metaGeretteteNoneOff]
  if (k === 'mittelConfirmedNone') return [b ? P.metaMittelNoneOn : P.metaMittelNoneOff]
  // «Entfällt» is a deliberate ANSWER, so it is recorded as one — a blank line in the record
  // looks like something forgotten, which is the whole reason these two fields exist.
  if (k === 'kontaktpersonNone') {
    return [fillTemplate(b ? P.metaNoneOn : P.metaNoneOff, { label: META_FIELD_LABELS.kontaktpersonNone })]
  }
  if (k === 'rueckmeldungNone') {
    return [fillTemplate(b ? P.metaNoneOn : P.metaNoneOff, { label: META_FIELD_LABELS.rueckmeldungNone })]
  }
  if (k === 'partnerContacts') return _partnerLines((a ?? []) as PartnerContact[], (b ?? []) as PartnerContact[])
  if (k === 'gruppen') return _gruppenLines((a ?? []) as GruppeZeit[], (b ?? []) as GruppeZeit[])
  if (k === 'fahrzeuge') return _fahrzeugLines((a ?? []) as FahrzeugZeit[], (b ?? []) as FahrzeugZeit[])
  return undefined
}

/** «2 Personen · 1 Tier» — journal text AND the printed rapport's «Gerettet» box (the payload
 *  sends this string pre-formatted), so the count agrees with its noun exactly once, here. */
function _geretteteText(g?: { personen?: number; tiere?: number }): string {
  const R = appConfig.copy.report
  if (!g || (g.personen == null && g.tiere == null)) return ''
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  return [
    g.personen != null ? count(g.personen, R.gerettetePerson, R.gerettetePersonen) : null,
    g.tiere != null ? count(g.tiere, R.geretteteTier, R.geretteteTiere) : null,
  ].filter(Boolean).join(' · ')
}

/** «Partnerorganisation {org} ergänzt – Bemerkung: {note}» — the arrival and its remark as ONE
 *  statement. Composed from the two existing templates (metaPartnerAdded + the part of
 *  metaPartnerNote after its {org}), so every locale that translated those two says this the
 *  same way; a locale whose note template carries no {org} falls back to two lines. */
function _partnerAddedWithNote(org: string, note: string): string[] {
  const P = appConfig.copy.preflight
  const tail = P.metaPartnerNote.split('{org}')[1]
  if (!tail) return [fillTemplate(P.metaPartnerAdded, { org }), fillTemplate(P.metaPartnerNote, { org, note })]
  return [fillTemplate(P.metaPartnerAdded, { org }) + fillTemplate(tail, { note })]
}

/** Partnerorganisationen, diffed BY ORGANISATION: who was added, who was removed, whose remark
 *  changed — in that order, adds first, so the lines tell the edit the way it happened rather
 *  than the way it alphabetises. Blank rows (the two the block always keeps ready) are not
 *  organisations and are skipped, or opening the sheet would log two arrivals nobody recorded. */
function _partnerLines(before: PartnerContact[], after: PartnerContact[]): string[] {
  const P = appConfig.copy.preflight
  const key = (p: PartnerContact) => (p.org ?? '').trim().toLowerCase()
  const named = (xs: PartnerContact[]) => xs.filter((p) => [p.org, p.name, p.phone, p.note].some((v) => v?.trim()))
  const A = new Map(named(before).map((p) => [key(p), p]))
  const B = new Map(named(after).map((p) => [key(p), p]))
  const adds: string[] = []
  const changes: string[] = []
  for (const [k, p] of B) {
    const org = (p.org ?? '').trim()
    const note = (p.note ?? '').trim()
    const was = (A.get(k)?.note ?? '').trim()
    // ⚠️ An organisation arriving WITH its remark used to log only the arrival: «Sanität ergänzt»,
    // while «Ölwehr avisiert, ETA 20 min» — the operational half — never reached the Verlauf and
    // therefore never reached the printed journal either. ONE merged statement (two rows for one
    // tap read as two events; it is one arrival, remark and all).
    if (!A.has(k)) {
      if (org && note) adds.push(..._partnerAddedWithNote(org, note))
      else adds.push(org ? fillTemplate(P.metaPartnerAdded, { org }) : P.metaPartnerUnnamed)
      continue
    }
    if (note === was) continue
    // …and CLEARING one is a change too. `&& note` skipped it, so deleting a remark was the one
    // edit on this block that left no trace at all.
    changes.push(note
      ? fillTemplate(P.metaPartnerNote, { org, note })
      : fillTemplate(P.metaPartnerNoteCleared, { org }))
  }
  const removals: string[] = []
  for (const [k, p] of A) {
    if (!B.has(k)) removals.push(fillTemplate(P.metaPartnerRemoved, { org: (p.org ?? '').trim() }))
  }
  return [...adds, ...changes, ...removals]
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
    // …and they are MARKED as such on the sheet, the way the Anwesenheit screen marks them
    .flatMap(({ name, a }) => rows(name, a).map((r) => ({ ...r, guest: true })))
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

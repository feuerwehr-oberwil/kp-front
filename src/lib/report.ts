import type { AttendanceState, BoardDoc, Drawing, Entity, LngLat, MittelEntry, PlanDocument, TimelineEvent, Trupp } from '../types'
import type { ReportMeta } from './workspace'
import { appConfig } from '../config/appConfig'
import { fmtDistance } from './geo'
import { fillTemplate, hhmm, restoreUmlauts } from './format'
import { fahrzeugRows, gruppenRows } from './alarmzeiten'
import { intervalsOf } from './attendanceIntervals'
import { getDeploymentConfig } from './deploymentConfig'
import { mittelReportRows } from './mittel'
import { rowPhotos } from './verlauf'

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
  /** row was appended AFTER the Einsatzende (closed_at) — printed under «Nachträge» */
  nachtrag?: boolean
}

export function journalArea(e: TimelineEvent, plans: PlanDocument[]): string {
  const r = appConfig.copy.report
  if (e.kind === 'audio' || e.kind === 'photo' || e.kind === 'journal' || e.pinned) return r.areaManual
  if (e.kind === 'team') return r.areaAtemschutz
  if (e.surface === 'plan') return planLabel(plans.find((p) => p.id === e.planId), e.floor)
  return r.kroki
}

export function journalRows(
  events: TimelineEvent[], plans: PlanDocument[], fallbackDate?: string, closedAt?: string | null,
  opts?: { includeBookkeeping?: boolean },
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
        text: e.text,
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

export function truppStatusLabel(status: Trupp['status']): string {
  return appConfig.copy.atemschutz.status[status] ?? status
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

export function readingKindLabel(kind: 'entry' | 'contact' | 'pressure'): string {
  const r = appConfig.copy.report
  return kind === 'entry' ? r.truppEntry : kind === 'contact' ? appConfig.copy.atemschutz.readingKind.contact : appConfig.copy.atemschutz.readingKind.pressure
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
export function metaExtrasForPdf(meta: ReportMeta): {
  gerettete?: string
  rueckmeldungElz?: string
  zeiten: [string, string][]
  erfasser?: string
} {
  const R = appConfig.copy.report
  const clock = (iso?: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return ''
    return hhmm(d)
  }
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
export interface PersonalPdfRow {
  name: string
  erfasst: boolean
  von?: string
  bis?: string
  vonDerived?: boolean
  bisDerived?: boolean
  note?: string
}

/** «07.08.» — the day in front of a clock reading, for an Einsatz that runs past midnight. */
const dayShort = (d: Date) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`

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

/**
 * Which Rapportangaben actually changed between two versions — the content of the printed
 * rapport (Einsatzleiter, Endezeit, Gerettete, Partnerorganisationen …) used to change with no
 * journal row and no audit event at all. Returns display labels, empty when nothing worth a
 * line moved, so the caller can stay silent rather than log «geändert: ».
 */
export function changedReportMetaFields(prev: ReportMeta, next: ReportMeta): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
  const out: string[] = []
  for (const k of keys) {
    if (META_QUIET.has(k)) continue
    const a = (prev as Record<string, unknown>)[k]
    const b = (next as Record<string, unknown>)[k]
    // structural compare: gruppen/fahrzeuge/partnerContacts are arrays of objects, and an
    // identity check would report a change on every re-render that rebuilt them
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue
    out.push(META_FIELD_LABELS[k] ?? k)
  }
  return out.sort((x, y) => x.localeCompare(y, 'de'))
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
  // Bare HH:MM is a lie on an Einsatz over midnight: «08:23 – 09:00» reads as 37 minutes when
  // it was 25 hours. The date rides along only when the incident actually spans days, so the
  // ordinary one-day sheet stays as narrow as it is now.
  const spansDays = (() => {
    const a = bounds.alarmedAt ? new Date(bounds.alarmedAt) : null
    const e = bounds.endedAt ? new Date(bounds.endedAt) : null
    if (!a || !e || !Number.isFinite(a.getTime()) || !Number.isFinite(e.getTime())) return false
    return a.toDateString() !== e.toDateString()
  })()
  const clock = (iso?: string | null) => {
    if (!iso) return undefined
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return undefined
    return spansDays ? `${dayShort(d)} ${hhmm(d)}` : hhmm(d)
  }
  const rows = (name: string, a?: AttendanceState[string]): PersonalPdfRow[] => {
    const blocks = intervalsOf(a)
    // the remark rides on the FIRST row of a person: repeating it on every block of a crew that
    // came back twice would print «Fahrer TLF» three times under one name
    if (!blocks.length) {
      const von = a ? clock(bounds.alarmedAt) : undefined
      const bis = a ? clock(bounds.endedAt) : undefined
      return [{ name, erfasst: !!a, von, bis, vonDerived: !!von, bisDerived: !!bis, note: a?.note }]
    }
    const alarmClock = clock(bounds.alarmedAt)
    return blocks.map((iv, i) => {
      const open = !iv.to
      const bis = open ? clock(bounds.endedAt) : clock(iv.to)
      const von = clock(iv.from)
      return {
        name, erfasst: true, von, bis,
        // Somebody who was there from the alarm is the ordinary case, and their start is the
        // incident's own — nothing to check against. Only a check-in that DIFFERS from the
        // alarm says something the paper has to be read for. (First block only: a return
        // later in the Einsatz that happens to fall on the alarm minute is a real arrival.)
        vonDerived: i === 0 && !!von && von === alarmClock,
        // only the LAST open block inherits the incident's end — an earlier open block would
        // mean a missing check-out mid-incident, and filling that in would invent hours
        bisDerived: open && !!bis,
        note: i === 0 ? a?.note : undefined,
      }
    })
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
    const unit = c.unit || 'Stk'
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

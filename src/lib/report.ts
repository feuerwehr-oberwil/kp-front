import type { AttendanceState, BoardDoc, Drawing, Entity, LngLat, MittelEntry, PlanDocument, TimelineEvent, Trupp } from '../types'
import type { ReportMeta } from './workspace'
import { appConfig } from '../config/appConfig'
import { fmtDistance } from './geo'
import { fillTemplate, formatSymbolName } from './format'
import { fahrzeugRows, gruppenRows } from './alarmzeiten'
import { getDeploymentConfig } from './deploymentConfig'
import { mittelReportRows } from './mittel'

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
  annotatedPlans: boolean
  allPlans: boolean
  atemschutz: boolean
  attendance: boolean
  mittel: boolean
  journal: boolean
  detailedAudit: boolean
}

export const defaultReportOptions: ReportOptions = {
  kroki: true,
  krokiView: null,
  annotatedPlans: true,
  allPlans: false,
  atemschutz: true,
  attendance: true,
  mittel: true,
  journal: true,
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

/** Report page orientation from rendered page aspect (height / width). */
export function pageOrientation(aspect: number): 'portrait' | 'landscape' {
  return aspect >= 1 ? 'portrait' : 'landscape'
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
  photoUrl?: string
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
        photoUrl: e.photoUrl,
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

export function shortHash(hash?: string): string {
  if (!hash) return '—'
  return hash.length <= 18 ? hash : `${hash.slice(0, 8)}…${hash.slice(-8)}`
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

export function entityLabel(e: Entity): string {
  return e.label || (e.symbol ? formatSymbolName(e.symbol) : appConfig.copy.entities.fallbackObjectName)
}

/** Pre-formatted meta extras for the SERVER-rendered PDF (facts rows are placed, not
 *  computed, by the composer): Gerettete, Rückmeldung ELZ
 *  and the Alarmierungs-/Ausrückzeiten grid as [label, value] pairs. Zeiten follow the
 *  field-classification decision (2026-07-17): digitally recorded times stay digital-only
 *  (no grid on the signed rapport); only when NOTHING was recorded does the grid print as
 *  `__:__` stubs, because the paper is then the capture medium. */
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
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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
  const anyRecorded = gRows.some(({ value: v }) => v?.alarmedAt) || vRows.some(({ value: v }) => v?.ausgerueckt)
  const zeiten: [string, string][] = anyRecorded
    ? []
    : [
        ...gRows.map(({ config: c }): [string, string] => [c.color ? `${c.label} (${c.color})` : c.label, '']),
        ...vRows.map(({ config: c }): [string, string] => [c.label, '']),
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
 *  deliberately absent: WinFAP computes them from von–bis. */
export function personalForPdf(
  roster: { id: string; name: string }[],
  attendance: AttendanceState,
): { personal: { name: string; erfasst: boolean; von?: string; bis?: string }[] } {
  const clock = (iso?: string) => {
    if (!iso) return undefined
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return undefined
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const row = (name: string, a?: AttendanceState[string]) => ({
    name, erfasst: !!a, von: clock(a?.checkedInAt), bis: clock(a?.leftAt),
  })
  const rosterIds = new Set(roster.map((p) => p.id))
  const guests = Object.entries(attendance)
    .filter(([id]) => !rosterIds.has(id))
    .map(([, a]) => row(a.displayNameSnapshot, a))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
  return {
    personal: [
      ...roster.map((p) => row(p.name, attendance[p.id])),
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
): { mittelForm: { label: string; menge?: string; unit: string }[] } {
  const noSource = appConfig.copy.mittel.noSource
  const recorded = mittelReportRows(mittel, noSource)
  const byKey = new Map(recorded.map((r) => [r.materialKey, r]))
  const rows: { label: string; menge?: string; unit: string }[] = []
  const sorted = [...catalogue].sort((a, b) => a.label.localeCompare(b.label, 'de-CH'))
  for (const c of sorted) {
    const unit = c.unit || 'Stk'
    const hit = byKey.get(`${c.id}|${unit.trim().toLowerCase()}`)
    if (hit) byKey.delete(hit.materialKey)
    rows.push({ label: c.label, menge: hit && hit.total > 0 ? String(hit.total) : undefined, unit })
  }
  for (const r of byKey.values()) {
    if (r.total <= 0) continue
    const sources = r.sources.filter((s) => s !== noSource)
    rows.push({ label: sources.length ? `${r.label} · ${sources.join(', ')}` : r.label, menge: String(r.total), unit: r.unit })
  }
  return { mittelForm: rows }
}

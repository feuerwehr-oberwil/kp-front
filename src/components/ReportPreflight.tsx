import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import { parseAlarmText } from '../lib/alarmText'
import { confirmDialog, openPhoto, toast } from '../lib/ui'
import { buildDirectReportPayload, downloadDirectReportPdf } from '../lib/reportPdfDirect'
import { KrokiFramingPanel } from './KrokiFramingPanel'
import { editorPrintTransport, enqueuePrint, fetchPrintStatus, prewarmPrint, type PrintRelayStatus } from '../lib/printRelay'
import { trackPrintJob } from '../lib/printJobToast'
import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm, dtLocalValue, dtLocalToIso, stripUnprintable } from '../lib/format'
import type { IncidentMeta } from '../lib/incidents'
import { getIncident, verifyChain } from '../lib/incidents'
import type { FahrzeugZeit, GruppeZeit, PartnerContact, ReportMeta } from '../lib/workspace'
import { deriveAusgerueckt, fahrzeugRows, gruppenRows, setFahrzeugZeit, setGruppeZeit, zeitFromClock, zeitIssues } from '../lib/alarmzeiten'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { activityMoments, loadReplay, stateAt, vehiclesAt, type ReplayBundle } from '../lib/replay'
import { autoRotation, vehicleSymbolSvg } from '../lib/useVehiclePositions'
import type { AuditProof, ReportDraft, ReportOptions } from '../lib/report'
import { defaultReportOptions, einsatzleiterFromScene, formatDateTime, krokiStandLabel, missingTranscriptCount, operationalExtentPoints, proofLabel } from '../lib/report'
import { applyTimeToIso, isoOnDay, missingSteps, stepDone, type AbschlussFacts } from '../lib/abschluss'
import { hoursRows, unresolvedHoursRows } from '../lib/attendanceHours'
import { incidentDays } from '../lib/zeitplanFormat'
import type { AttendanceState, BoardDoc, BuildingDoc, CaptionMode, Drawing, Entity, LayerDef, LngLat, MittelEntry, Person, PlanDocument, ReportAttachment, TimelineEvent, Trupp } from '../types'
import { visibleMittel } from '../lib/mittel'
import { PersonField } from './PersonField'
import { CaptureUsageChip, type CaptureUsage } from './CaptureUsageChip'
import { DateTimeField, TimeField } from './TimeField'
import { Stepper } from './Stepper'
import { Menu, Popover } from '../lib/overlays'

const NO_IDS = new Set<string>()

/** Shape of the operational extent — wider than tall means a landscape sheet. Latitude is
 *  scaled by cos(lat) so the comparison is in metres, not degrees: at 47° a degree of longitude
 *  is only ~68 km against 111 km, and the raw numbers would call almost every Lage «hoch».
 *  Read ONCE, to seed the orientation — from then on the value on screen is the choice. */
function autoLandscape(scene?: { center: LngLat; entities: Entity[]; drawings: Drawing[] }): boolean {
  if (!scene) return true
  const pts = operationalExtentPoints(scene.center, scene.entities, scene.drawings, false)
  if (pts.length < 2) return true
  const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1])
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const w = (Math.max(...lngs) - Math.min(...lngs)) * Math.cos((midLat * Math.PI) / 180)
  const h = Math.max(...lats) - Math.min(...lats)
  return w >= h
}

/** HH:MM display value for the compact time inputs of the Zeiten grid. */
function clockOf(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return hhmm(d)
}

function CheckRow({ done, label, sub, onGo, children }: {
  done: boolean
  label: string
  sub: string
  onGo?: () => void
  children?: ReactNode
}) {
  return (
    <div className="rp-check">
      <button type="button" className="rp-check-main" onClick={onGo} disabled={!onGo}>
        <span className={`rp-check-dot${done ? ' done' : ''}`}>
          <Icon id={done ? 'check' : 'minus'} />
        </span>
        <span className="rp-check-label">{label}</span>
        <span className="rp-check-sub">{sub}</span>
        {onGo && <Icon id="chevron" className="rp-check-go" />}
      </button>
      {children}
    </div>
  )
}


// The preflight UNMOUNTS while the operator hops to Anwesenheit / Mittel / Verlauf («Zurück
// zum Einsatzrapport» remounts it) — remember the body's scroll position per incident so the
// return lands where they left off, not back at the top. A deliberate close (X / overlay /
// Abbrechen / Abschliessen) resets it, so a later fresh open starts at the top again.
// (a mutated `.current` box, not a reassigned binding — the react-compiler lint forbids
// reassigning module variables inside the component)
const savedScroll: { current: { incidentId: string; top: number } | null } = { current: null }

export function ReportPreflight({
  incident, reportMeta, personnel = [], presentIds = NO_IDS, onRolePicked, events, annotatedPlanCount, truppCount, attendanceCount, mittelCount, mittel = [], mapContentCount = 1, pendingMediaCount = 0, attendance = {}, trupps = [], plans = [], scene, board, building, captureUsage, canEdit = true, attachments = [], onAddAttachments, onCaptionAttachment, onRemoveAttachment, onSaveMeta, onEditDispatch, onOpenAnwesenheit, onOpenMittel, onComplete, onFixTranscripts,
}: {
  incident: IncidentMeta
  reportMeta: ReportMeta
  /** Mannschaft roster + who is present — the Einsatzleiter picker offers present crew first */
  personnel?: Person[]
  presentIds?: Set<string>
  /** Naming somebody here puts them on the Anwesenheit list and, for the Einsatzleiter, writes
   *  the function into their Bemerkung. A rapport that names an Einsatzleiter the attendance
   *  sheet has never heard of contradicts itself on paper. Undefined = nothing to link (a typed
   *  guest name), which is exactly the case where nothing should happen. */
  onRolePicked?: (personId: string | undefined, role: 'el' | 'fahrer', note?: string) => void
  events: TimelineEvent[]
  annotatedPlanCount: number
  truppCount: number
  attendanceCount: number
  /** count of distinct visible Mittel lines — drives the section toggle + its label */
  mittelCount: number
  /** append-only Mittel entries — the quick-check list derives current lines from them */
  mittel?: MittelEntry[]
  /** entities+drawings on the Lage map — 0 seeds the Kroki page OFF (rapport-only incident) */
  mapContentCount?: number
  /** captures (photo/audio) still in the offline upload queue — warns they aren't on the
   *  server yet, so a report printed now won't include them from another device */
  pendingMediaCount?: number
  /** full attendance record — drives the collapsible Stunden (von–bis) editor */
  attendance?: AttendanceState
  trupps?: Trupp[]
  plans?: PlanDocument[]
  /** the Lage scene for the server-rendered Kroki (entities/drawings/layers/view) */
  scene?: {
    entities: Entity[]
    drawings: Drawing[]
    layers: LayerDef[]
    byName: Record<string, string>
    center: LngLat
    view: { center: LngLat; zoom: number }
    /** the map's Beschriftungen setting — the printed Kroki carries the same labels the
     *  screen it was framed on did (an Einsatzleiter symbol prints its name) */
    captionMode?: CaptionMode
  }
  /** plan whiteboard annotations — server-rendered annotated Objektplan pages */
  board?: BoardDoc
  /** the picked Gebäude (floor stack) — exports as blank-base plan pages when present */
  building?: BuildingDoc | null
  /** QR self-reporting in use — «QR: N Einträge · zuletzt HH:MM» chip (informational) */
  captureUsage?: CaptureUsage | null
  /** Beilagen: photos that belong to the REPORT (an ID document, a damage close-up), printed
   *  large enough to read at the end. Separate from Verlauf photos on purpose — see
   *  types · ReportAttachment. Omit the handlers on a read-only surface and the block reads. */
  attachments?: ReportAttachment[]
  onAddAttachments?: (files: File[]) => void
  onCaptionAttachment?: (id: string, caption: string) => void
  onRemoveAttachment?: (id: string) => void
  /** persist the inline Rapportangaben edits (after-arrival fields) into the workspace */
  onSaveMeta: (next: ReportMeta) => void
  /** may this session write the Rapportangaben? False for a viewer and for an ARCHIVED Einsatz
   *  (which is «nur ansehen – zum Bearbeiten reaktivieren»): the fields render, filled in and
   *  readable, but nothing in them can be changed. */
  canEdit?: boolean
  /** Stunden editor: correct one person's von–bis; omit to render the table read-only */
  /** open the Einsatzdaten panel to correct the dispatch facts; omit to hide the link
   *  (e.g. viewers / read-only) */
  onEditDispatch?: () => void
  /** checklist navigation into the REAL views (the practice rationale): these close the
   *  sheet and reveal the surface — same tools on every incident size */
  onOpenAnwesenheit?: () => void
  onOpenMittel?: () => void
  /** «Rapport abschliessen» — confirm already happened here; stamps report_done_at +
   *  archives. Omit for viewers / read-only. */
  onComplete?: () => void
  /** jump to the Verlauf to fill the still-missing audio transcripts */
  onFixTranscripts?: () => void
}) {
  // Defaults follow the data: a rapport-only incident (nothing drawn) prints without the
  // map/plan pages, no configuration needed; every toggle stays available as an override.
  // Personal + Material stay ON even with zero records: the rapport is a pre-filled
  // FORM (2026-07-17) — empty sections print as tick-off roster rows / amount stubs.
  const [options, setOptions] = useState<ReportOptions>({
    ...defaultReportOptions,
    kroki: mapContentCount > 0,
    annotatedPlans: annotatedPlanCount > 0,
    atemschutz: truppCount > 0,
    // The framing chosen for the LAST print of this Einsatz — the Kroki panel opens on it and
    // reports every settled pan back into this same field, so what the surface would print is
    // always what the crop on screen shows. Auto on first use: the operational extent decides
    // the shape, so a Lage that runs north–south opens upright without anyone asking for it.
    krokiView: reportMeta.krokiPrint?.view ?? null,
    krokiLandscape: reportMeta.krokiPrint?.landscape ?? autoLandscape(scene),
  })
  // Partnerorganisationen. The field existed in the model and PRINTED for months, but nothing
  // ever wrote it — so every rapport fell back to the config's tick-off row and «Polizei war da»
  // was all the paper ever said. The remark is the point of the block: which patrol, whose
  // number, what they took over.
  const [partners, setPartners] = useState<PartnerContact[]>(() => reportMeta.partnerContacts ?? [])
  const savePartners = (next: PartnerContact[]) => {
    // Bail BEFORE the local state: `persist` already refuses to write while read-only, so
    // accepting the edit on screen would show a viewer (or a closed Einsatz) a partner that
    // was never saved and vanishes on close — the silent-drop failure the read-only fieldset
    // exists to prevent. This block sits outside that fieldset, so it guards itself.
    if (!canEdit) return
    setPartners(next)
    // an all-empty row is nothing to record — dropped on the way to the blob, kept on screen
    const clean = next.filter((p) => [p.org, p.name, p.phone, p.note].some((v) => v?.trim()))
    persist({ partnerContacts: clean.length ? clean : undefined })
  }
  const patchPartner = (i: number, over: Partial<PartnerContact>) =>
    savePartners(partners.map((p, j) => (j === i ? { ...p, ...over } : p)))
  // WHEN the printed Kroki shows. The live picture is the default and the common case; a past
  // instant is what makes a rapport able to show the Rettung that has since left, or the moment
  // the Lage was at its worst. Reconstructed locally from the event journal (lib/replay), the
  // same fold the Wiedergabe uses — so the paper and the replay can never disagree.
  const [nowRef] = useState(() => Date.now())
  const [krokiAt, setKrokiAt] = useState<number | null>(
    () => (reportMeta.krokiPrint?.at ? Date.parse(reportMeta.krokiPrint.at) || null : null),
  )
  const [pastScene, setPastScene] = useState<{ entities: Entity[]; drawings: Drawing[] } | null>(null)
  const [krokiAtBusy, setKrokiAtBusy] = useState(false)
  // WHEN anything happened, for the Stand slider's tick marks. Derived from the SAME source the
  // replay bar uses, so the two surfaces cannot disagree about where the Einsatz has substance:
  // the recorded actions plus the Verlauf rows that carry an absolute time.
  const [krokiMoments, setKrokiMoments] = useState<number[]>([])
  const bundleRef = useRef<ReplayBundle | null>(null)
  useEffect(() => {
    if (krokiAt == null) { setPastScene(null); return }
    let alive = true
    setKrokiAtBusy(true)
    void (async () => {
      try {
        const startMs = Date.parse(meta.startedAt ?? incident.started_at)
        bundleRef.current ??= await loadReplay(incident.id, startMs, Date.now())
        const ws = await stateAt(bundleRef.current, krokiAt)
        if (!alive) return
        // vehicles come from the recorded GPS samples, like the Wiedergabe draws them
        const vehicles: Entity[] = vehiclesAt(bundleRef.current.samples, krokiAt).map((v) => ({
          id: `replay-veh-${v.deviceId}`, kind: 'vehicle', layer: appConfig.gps.layerId,
          coord: v.coord, symbolSvg: vehicleSymbolSvg(String(v.deviceId), autoRotation(v.course), v.course != null),
          label: `Fahrzeug ${v.deviceId}`, live: true, directed: v.course != null,
        }))
        setPastScene({ entities: [...(ws?.entities ?? []), ...vehicles], drawings: ws?.drawings ?? [] })
      } catch {
        if (alive) { setPastScene(null); toast(P.krokiAtFailed, { icon: 'warn', tone: 'warn' }) }
      } finally {
        if (alive) setKrokiAtBusy(false)
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- incident/meta are stable per sheet
  }, [krokiAt])

  /** the Lage the printed Kroki is built from: the reconstructed one when a moment is chosen */
  const effScene = pastScene && scene ? { ...scene, entities: pastScene.entities, drawings: pastScene.drawings } : scene

  const presetOrgs = getDeploymentConfig().report?.partnerOrgs ?? []
  /** One row per organisation: the station's list (ticked or not), then any recorded org that is
   *  not on it. Matching is case-insensitive on the name, so a list entry and a typed one are
   *  the same organisation and can never appear twice. */
  const partnerRows = useMemo(() => {
    const key = (o?: string) => (o ?? '').trim().toLowerCase()
    const rows: { org: string; i: number; custom: boolean }[] =
      presetOrgs.map((org) => ({ org, i: partners.findIndex((p) => key(p.org) === key(org)), custom: false }))
    partners.forEach((p, i) => {
      if (!presetOrgs.some((o) => key(o) === key(p.org))) rows.push({ org: p.org ?? '', i, custom: true })
    })
    return rows
  }, [presetOrgs, partners])
  const [proof, setProof] = useState<AuditProof>({ intact: null, checkedAt: new Date().toISOString(), offline: true })
  const [checking, setChecking] = useState(true)
  // the alarm text auto-fills from the incident's dispatch text when none was typed in the
  // Einsatzdaten panel — display + print fallback only, never persisted into the report blob.
  const [alarmFallback, setAlarmFallback] = useState('')

  // Rapportangaben = the after-arrival fields, edited inline here. Seeded once from the blob;
  // every change is persisted live (see persist) so nothing is lost if the sheet is closed.
  const [summary, setSummary] = useState(reportMeta.summary ?? '')
  const [kontaktperson, setKontaktperson] = useState(reportMeta.kontaktperson ?? '')
  // Seeded from the Kroki when the Rapport has none of its own: the EL was already named on the
  // map (Einsatzleiter glyph / KP Front), so typing it a second time is pure duplication. A
  // pre-fill only — the picker stays editable and the typed value wins from then on.
  const [einsatzleiter, setEinsatzleiter] = useState(reportMeta.einsatzleiter ?? einsatzleiterFromScene(scene?.entities) ?? '')
  const [endedAt, setEndedAt] = useState(dtLocalValue(reportMeta.endedAt ?? incident.closed_at ?? undefined))
  const [ausgerueckt, setAusgerueckt] = useState(dtLocalValue(reportMeta.ausgeruecktAt))
  const [remarks, setRemarks] = useState(reportMeta.remarks ?? '')
  const [lehren, setLehren] = useState(reportMeta.lehren ?? '')
  // Alarmierungs-/Ausrückzeiten grid (G1/G2) + the paper-form Details fields (G4).
  // Grid rows come from deployment config (empty config = grid hidden); values are
  // prefilled by the milestone webhook, edits here stamp `manual` (human beats machine).
  const [gruppen, setGruppen] = useState<GruppeZeit[]>(reportMeta.gruppen ?? [])
  const [fahrzeuge, setFahrzeuge] = useState<FahrzeugZeit[]>(reportMeta.fahrzeuge ?? [])
  const [geretteteP, setGeretteteP] = useState(reportMeta.gerettete?.personen?.toString() ?? '')
  const [geretteteT, setGeretteteT] = useState(reportMeta.gerettete?.tiere?.toString() ?? '')
  const [rueckName, setRueckName] = useState(reportMeta.rueckmeldungElz?.name ?? '')
  const [rueckAt, setRueckAt] = useState(clockOf(reportMeta.rueckmeldungElz?.at))

  useEffect(() => {
    let alive = true
    verifyChain(incident.id)
      .then((r) => {
        if (!alive) return
        setProof({ intact: r.intact, brokenAtSeq: r.broken_at_seq, count: r.count, head: r.head, checkedAt: new Date().toISOString() })
      })
      .catch(() => {
        if (!alive) return
        setProof({ intact: null, checkedAt: new Date().toISOString(), offline: true })
      })
      .finally(() => { if (alive) setChecking(false) })
    return () => { alive = false }
  }, [incident.id])

  useEffect(() => {
    if (reportMeta.alarmText) return
    let alive = true
    getIncident(incident.id)
      .then((full) => { if (alive && full.text) setAlarmFallback(full.text) })
      .catch(() => {})
    return () => { alive = false }
  }, [incident.id, reportMeta.alarmText])

  // Header «Ausgerückt» is DERIVED (first physical departure) once any per-vehicle time
  // exists; the manual field stays authoritative only while there is no vehicle data.
  const derivedAus = deriveAusgerueckt(fahrzeuge)

  const numOrU = (s: string): number | undefined => {
    const n = Number(s)
    return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
  }
  const rueckIso = (rueckAt ? applyTimeToIso(incident.started_at, rueckAt, { nextDayIfBefore: incident.started_at }) : null) ?? undefined
  const geretteteOver = (p: string, t: string): Partial<ReportMeta> => ({
    gerettete: numOrU(p) !== undefined || numOrU(t) !== undefined
      ? { personen: numOrU(p), tiere: numOrU(t) } : undefined,
  })
  // The Rückmeldung is often given LATER than it happened — «ah, die ELZ hab ich gestern um
  // 23:40 informiert». Without a day the clock could only land on the incident's own start day
  // (rolled forward when it read as earlier), which silently moved a yesterday to a today. The
  // picker offers the incident's days and starts on TODAY, the normal answer; `day` comes back
  // only when there is more than one to choose from, so a single-day Einsatz is unchanged.
  const rueckOver = (name: string, hhmm: string, day?: Date): Partial<ReportMeta> => {
    const at = (hhmm
      ? (day ? isoOnDay(day, hhmm) : applyTimeToIso(incident.started_at, hhmm, { nextDayIfBefore: incident.started_at }))
      : null) ?? undefined
    return { rueckmeldungElz: name.trim() || at ? { name: name.trim() || undefined, at } : undefined }
  }
  const editedMeta = (): Partial<ReportMeta> => ({
    summary: summary.trim() || undefined,
    kontaktperson: kontaktperson.trim() || undefined,
    einsatzleiter: einsatzleiter.trim() || undefined,
    endedAt: dtLocalToIso(endedAt),
    ausgeruecktAt: derivedAus ?? dtLocalToIso(ausgerueckt),
    remarks: remarks.trim() || undefined,
    lehren: lehren.trim() || undefined,
    gruppen: gruppen.length ? gruppen : undefined,
    fahrzeuge: fahrzeuge.length ? fahrzeuge : undefined,
    gerettete: numOrU(geretteteP) !== undefined || numOrU(geretteteT) !== undefined
      ? { personen: numOrU(geretteteP), tiere: numOrU(geretteteT) } : undefined,
    rueckmeldungElz: rueckName.trim() || rueckIso ? { name: rueckName.trim() || undefined, at: rueckIso } : undefined,
  })

  // Write the after-arrival fields back to the blob, preserving everything else (the dispatch
  // facts alarmText/alarmiertAt stay sourced from the incident — never persisted here). `over`
  // carries the just-changed field so we don't read stale state mid-event.
  const persist = (over: Partial<ReportMeta>) => canEdit && onSaveMeta({
    ...reportMeta,
    ...editedMeta(),
    ...over,
  })

  // Commit the Kroki-seeded Einsatzleiter to the blob once, so the Abschluss-Checkliste and a
  // rapport printed from another device see the same name this field shows — a value that only
  // lives in local state would leave the checklist nagging about an Einsatzleiter that is on
  // screen. Fills a BLANK field only, never overwrites, and only while the sheet is mounted.
  const seededEinsatzleiter = useRef(false)
  useEffect(() => {
    if (seededEinsatzleiter.current || reportMeta.einsatzleiter?.trim() || !einsatzleiter.trim()) return
    seededEinsatzleiter.current = true
    persist({ einsatzleiter: einsatzleiter.trim() })
    // `persist` is re-created every render (it closes over the live field state); depending on it
    // would re-run this on every keystroke — the ref guard is what makes it once-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportMeta.einsatzleiter, einsatzleiter])

  const meta: ReportMeta = {
    ...reportMeta,
    ...editedMeta(),
    alarmText: reportMeta.alarmText ?? (alarmFallback || undefined),
    // Alarmierung = the incident's start (= when we were alarmed); editable in Einsatzdaten
    alarmiertAt: reportMeta.alarmiertAt ?? incident.started_at,
  }
  const alarm = parseAlarmText(meta.alarmText)
  const alarmiert = meta.alarmiertAt
  // Plausibility of the three clocks, as a HINT under the field that is wrong. Never a block:
  // printing must not depend on what somebody typed, and an Einsatz over midnight is normal.
  // `nowRef` is read once per sheet — a live clock here would re-render the form every second
  // and is exactly the shape that once cost the phone its battery.
  const issues = zeitIssues(
    { alarmiertAt: alarmiert, ausgeruecktAt: derivedAus ?? dtLocalToIso(ausgerueckt), endedAt: dtLocalToIso(endedAt) },
    nowRef,
  )
  const issueFor = (kind: 'ausgerueckt' | 'ende') => {
    const i = issues.find((x) => x.kind === kind)
    if (!i) return null
    const t = i.ref ? formatDateTime(i.ref) : ''
    if (i.code === 'future') return P.zeitFuture
    return fillTemplate(i.code === 'beforeAusgerueckt' ? P.zeitBeforeAusgerueckt : P.zeitBeforeAlarm, { t })
  }
  // a plain call, not a component: one declared in the render body is re-created every pass
  const zeitWarn = (kind: 'ausgerueckt' | 'ende') => {
    const text = issueFor(kind)
    return text ? <span className="rz-warn"><Icon id="warn" />{text}</span> : null
  }
  const missTx = missingTranscriptCount(events)
  // No krokiView argument any more: the panel reports each settled crop into `options` while the
  // rapport is being filled in, so by the time a button is pressed the state IS the framing on
  // screen. It used to be threaded through the modal's onConfirm because that value and the
  // setState landed in the same tick.
  const buildDraft = (): ReportDraft => {
    const generatedAt = new Date().toISOString()
    return {
      meta, generatedAt,
      proof: { ...proof, checkedAt: proof.checkedAt || generatedAt },
      // krokiAt travels with the draft so the printed caption dates the PICTURE, not the print
      // Stamp the chosen instant ONLY when the reconstruction for it is actually what prints.
      // `effScene` falls back to the LIVE Lage while the reconstruction is in flight and after
      // one fails, and a caption saying «Stand 21:14» over a picture of 23:00 is a false
      // statement on a document that is a legal record. No caption is the honest fallback.
      options: { ...options, krokiAt: krokiAt != null && pastScene ? new Date(krokiAt).toISOString() : null },
    }
  }
  const [pdfBusy, setPdfBusy] = useState(false)
  // ONE button (decided 2026-07-18): the server composes the complete rapport — map
  // render included (app/kroki.py) — from pure data. No Druckansicht detour anymore.
  const downloadPdf = async () => {
    const draft = buildDraft()
    setPdfBusy(true)
    try {
      await downloadDirectReportPdf({
        incident, draft, trupps, attendance, events, plans, mittel, attachments, scene: effScene, board, building,
        roster: personnel.filter((p) => p.active).map((p) => ({ id: p.id, name: p.displayName })),
      })
      // success needs no banner — the downloaded/opened PDF IS the feedback
    } catch {
      toast(appConfig.copy.report.pdfFailed, { icon: 'warn', tone: 'warn' })
    } finally {
      setPdfBusy(false)
    }
  }
  // Station print relay: hidden unless the deployment runs one (fail-closed backend);
  // the dot mirrors the agent heartbeat, undo cancels while the job is still queued.
  const [printStatus, setPrintStatus] = useState<PrintRelayStatus | null>(null)
  const [printBusy, setPrintBusy] = useState(false)
  useEffect(() => {
    let alive = true
    void fetchPrintStatus(editorPrintTransport()).then((s) => { if (alive) setPrintStatus(s) })
    return () => { alive = false }
  }, [])
  // Opening this surface is a strong «about to print» signal: once we know the relay is
  // available and the report carries a Kroki, warm the server's map-tile cache so the real
  // enqueue render is near-instant. Fire once, best-effort — reframes reuse overlapping tiles.
  const warmedRef = useRef(false)
  useEffect(() => {
    if (warmedRef.current || !printStatus?.available || !options.kroki || mapContentCount === 0 || !scene) return
    warmedRef.current = true
    const payload = buildDirectReportPayload({
      incident, draft: buildDraft(), trupps, attendance, events, plans, mittel, attachments, scene: effScene, board, building,
      roster: personnel.filter((p) => p.active).map((p) => ({ id: p.id, name: p.displayName })),
    })
    void prewarmPrint(editorPrintTransport(), incident.id, payload)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printStatus?.available, options.kroki, mapContentCount])
  const R = appConfig.copy.printRelay
  const sendToPrinter = async () => {
    // ALWAYS confirm — «Ausdrucken» must never produce accidental paper; when the relay
    // is offline the modal doubles as the store-and-forward warning
    const ok = printStatus?.online
      ? await confirmDialog({ title: R.confirmTitle, message: R.confirmMsg, confirmLabel: R.confirmBtn })
      : await confirmDialog({ title: R.offlineConfirmTitle, message: R.offlineConfirmMsg, confirmLabel: R.offlineConfirmBtn })
    if (!ok) return
    setPrintBusy(true)
    try {
      const t = editorPrintTransport()
      const payload = buildDirectReportPayload({
        incident, draft: buildDraft(), trupps, attendance, events, plans, mittel, attachments, scene: effScene, board, building,
        roster: personnel.filter((p) => p.active).map((p) => ({ id: p.id, name: p.displayName })),
      })
      const jobId = await enqueuePrint(t, incident.id, payload)
      trackPrintJob(t, jobId)
    } catch {
      toast(R.failed, { icon: 'warn', tone: 'warn' })
    } finally {
      setPrintBusy(false)
    }
  }
  const patchOpt = (patch: Partial<ReportOptions>) => setOptions((o) => ({ ...o, ...patch }))
  /** Is there anything to frame? A rapport-only Einsatz (nothing drawn, nothing placed) seeds
   *  the Kroki section OFF and must not show an empty map pretending to be a picture — and
   *  switching the section off by hand means the same thing: nothing is going on the paper. */
  const krokiPanel = options.kroki && mapContentCount > 0 && !!effScene
  // The panel is a fold: on a wide screen it is open, because seeing the crop while the form is
  // typed is the whole reason it stopped being a modal; below the two-column breakpoint a map
  // crop is a postcard sitting between the operator and the fields, so it starts closed and
  // Loaded when the crop becomes visible, not on the first drag: the ticks exist to aim that
  // drag, so arriving after it would be arriving too late. Best-effort — a replay bundle that
  // will not load costs the marks, never the slider.
  const krokiShown = krokiPanel
  useEffect(() => {
    if (!krokiShown) return
    let alive = true
    void (async () => {
      try {
        const startMs = Date.parse(meta.startedAt ?? incident.started_at)
        bundleRef.current ??= await loadReplay(incident.id, startMs, Date.now())
        const ws = await stateAt(bundleRef.current, bundleRef.current.endMs)
        if (alive) setKrokiMoments(activityMoments(bundleRef.current.events, ws?.timeline ?? []))
      } catch { /* no marks; the slider still works */ }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the panel becoming visible
  }, [krokiShown, incident.id])
  const startOutput = async (action: 'pdf' | 'print') => {
    // ⚠️ A rapport that is still missing Mindestangaben may ALWAYS be produced — printing is
    // never blocked by what somebody has not typed yet, and a half-filled sheet taken to the
    // Magazin to be finished by hand is a real way of working. But a PDF that leaves the
    // building is the version that gets filed, so the gap is said out loud once, by name,
    // before it goes. Same words the Abschluss confirm uses; the only difference is that this
    // one is a warning and that one is a decision.
    if (missing.length) {
      const ok = await confirmDialog({
        title: P.exportIncompleteTitle,
        message: `${fillTemplate(A.confirmMissing, { steps: missing.map((st2) => A.steps[st2]).join(', ') })} ${P.exportIncompleteMsg}`,
        confirmLabel: action === 'print' ? R.send : P.pdfFull,
        cancelLabel: appConfig.copy.cancel,
      })
      if (!ok) return
    }
    // No framing step in front of the action any more — the crop has been on screen the whole
    // time. What is left of the old onConfirm is the REMEMBERING: the framing rides the workspace
    // blob so the second print comes out of the same window as the first, from any device. Written
    // here rather than on every pan, because «the last print's framing» is what it claims to be —
    // and a persist per map frame would be a workspace write per frame. Cleared for a read-only
    // surface by `persist` itself.
    if (krokiPanel && options.krokiView) {
      persist({
        krokiPrint: {
          view: options.krokiView,
          at: krokiAt != null && pastScene ? new Date(krokiAt).toISOString() : undefined,
          landscape: options.krokiLandscape,
        },
      })
    }
    if (action === 'pdf') void downloadPdf()
    else void sendToPrinter()
  }
  const P = appConfig.copy.preflight
  const A = appConfig.copy.abschluss

  // Derived closing checklist (lib/abschluss): the sheet is the ONE closing surface — the
  // status is recomputed from the data on every render, never stored as visited-state.
  // What the fold has to say without being opened: the sections that will actually print.
  // Personal and Material are always in it and that is deliberate — the Rapport is a pre-filled
  // FORM (field feedback 2026-07-17), so an incident with no records still wants the tick-off
  // roster and the amount stubs on paper. Everything else follows its content.

  const facts: AbschlussFacts = { reportMeta: meta, attendanceCount, mittelCount }
  const rows = hoursRows(attendance, { alarmedAt: alarmiert ?? null, endedAt: meta.endedAt ?? null })
  // People whose presence blocks cannot be turned into a duration — almost always a still-open
  // block borrowing an Einsatzende that lies BEFORE it. They fall out of BOTH Einsatzstunden
  // totals. It used to print on the paper as «N Person(en) ohne verwertbare Zeiten», a count of
  // an abstraction that named neither who nor why and that nobody could act on from a sheet.
  // It belongs here instead: beside the button that makes the paper, while it can still be fixed.
  // ⚠️ Filtered, not raw: while the Einsatz is RUNNING everybody still on scene totals to
  // nothing, and naming all of them under «Zeiten laufen rückwärts oder fehlen» is a warning
  // about the ordinary state of every open Einsatz (lib/attendanceHours · unresolvedHoursRows).
  const unresolvedNames = unresolvedHoursRows(rows, { endedAt: meta.endedAt ?? null }).map((r) => r.name)

  // «bereit» is a claim, so it is made only when nothing is outstanding — a fold that says all
  // is well while hiding a broken hash chain would be worse than no summary at all.
  const controlOk = !checking && proof.intact !== false && missTx === 0 && pendingMediaCount === 0
    && unresolvedNames.length === 0
  /** how many things are actually wrong — the chip counts them rather than saying «Kontrolle» */
  const warnCount = (missTx > 0 ? 1 : 0) + (pendingMediaCount > 0 ? 1 : 0) + (proof.intact === false ? 1 : 0)
    + (unresolvedNames.length > 0 ? 1 : 0)
  const [controlOpen, setControlOpen] = useState(false)

  // The head's one line, in the voice the other surfaces use («12 anwesend · 3 gegangen · 28
  // Mannschaft»): what is recorded, then the verdict. «Alle Angaben erfasst» is a claim, so it is
  // made only when the same Mindestangaben the Abschluss-Confirm checks are all in — and when
  // they are not, the line NAMES the missing ones instead of saying that something, somewhere, is
  // still open. It deliberately says nothing about the Prüfnachweis or the pending uploads: those
  // are warnings, they live beside the buttons they must be read before, and a header that also
  // mentioned them would be the second place to look for the same thing.
  const missing = missingSteps(facts)
  const headCounts = fillTemplate(P.headCounts, { n: attendanceCount, m: mittelCount })

  // «Einsatz abschliessen» is bookkeeping, not the artefact: it stamps report_done_at and
  // archives. The PDF is its own (primary) action — decoupled by decision 2026-07-08 after
  // auto-download-on-complete felt wrong in the field.
  const complete = async () => {
    if (!onComplete) return
    const message = missing.length
      ? `${fillTemplate(A.confirmMissing, { steps: missing.map((s) => A.steps[s]).join(', ') })} ${A.confirmMsg}`
      : A.confirmMsg
    if (await confirmDialog({ title: A.confirmTitle, message, confirmLabel: A.confirmBtn })) {
      savedScroll.current = null
      onComplete()
    }
  }

  // Scroll keep-alive across the Anwesenheit/Mittel/Verlauf round trip (see savedScroll):
  // Restore before paint on mount, capture on unmount. There is no «close» any more: leaving is
  // choosing another surface in the rail, which unmounts this one and captures the scroll — and
  // «Einsatz abschliessen» clears the saved position itself, because coming back to a completed
  // rapport should start at the top.
  const bodyRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && savedScroll.current?.incidentId === incident.id) el.scrollTop = savedScroll.current.top
    return () => { if (el) savedScroll.current = { incidentId: incident.id, top: el.scrollTop } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    /* A SURFACE, not a dialog. The Rapport is filled in across a whole Einsatz — a sentence
       here, a time there, jump to Anwesenheit because somebody arrived — and it wants the width
       its Zeiten grid and its two-up roster ask for. It is also the last screen here with no
       dialog left over it at all: the Kroki framing used to open on top of this, which put the
       operator two windows deep on the one screen that has to stay legible at 3am, and it is a
       panel in the page now. The head carries NO close button: a page is left by choosing
       another surface in the rail, and a ✕ on one of six surfaces asks «closed into what?». */
    <>
      {/* Opaque backdrop, exactly as Mittel and Atemschutz do it: the Lage showing through the
          gap around an inset card makes a form look like something floating over the map, and
          this surface is where somebody sits and writes. */}
      <div className="rp-backdrop" aria-hidden />
      <div className="report-preflight report-preflight-surface">
        {/* The same head every other surface wears (Anwesenheit, Mittel): a title, and under it
            one line of what is actually recorded. It carried a bare title and an ✕ — dialog
            chrome, which is what a page inherits when it used to be a sheet. No ✕ either: a
            page is left by choosing another surface in the rail, exactly like Anwesenheit and
            Mittel, and a close button on one of six surfaces asks «closed into what?». */}
        <header className="rp-head">
          <div className="rp-head-titles">
            <h2>{P.title}</h2>
            {/* ⚠️ NOT one sentence. As «5 Personen · 2 Positionen · noch offen: Kurzberi…» the
                line truncated away the only part of itself worth reading — what is still
                missing was the first thing to go, because it sits at the end. The counts are a
                read-out and stay one line; what is OPEN is a set, so it is a set of chips that
                wrap onto a second row and are named in full however many there are. */}
            <p className="rp-head-sum">
              <span className="rp-head-counts">{headCounts}</span>
              {missing.length > 0 ? (
                <span className="rp-head-open">
                  <span className="rp-head-open-k">{P.headStillOpen}</span>
                  {missing.map((s) => <em key={s}>{A.steps[s]}</em>)}
                </span>
              ) : (
                <span className="rp-head-done"><Icon id="check" />{P.headAllRecorded}</span>
              )}
            </p>
          </div>
          {/* The controls sit HERE, with the other surfaces' controls, and the readiness state
              rides with them — that pairing is not decoration. A warning about the record (a
              broken hash chain, an audio entry with no transcript, a photo still queued) has to
              be read before the paper exists, so it has to be in the same glance as the button
              that makes the paper. Putting the buttons up here and leaving the warnings at the
              bottom of a scrolling form would be exactly the failure the never-behind-a-fold rule
              prevents; they move together or not at all. */}
          <div className="rp-head-actions">
            {/* The chip appears ONLY when something is wrong. A green «Alles bereit» spent a
                control on the most contested row of the surface to announce that nothing had
                happened — and the line under the title already says whether the Angaben are
                complete, so it was also the second place to look for the same answer. Worse, a
                badge that is present and green on every ordinary Einsatz teaches the eye to skip
                exactly the spot the warning will appear in.
                Nothing actionable is lost: every state that needs a person is a warning, and a
                warning still lands here, amber, counted, in the same glance as the button that
                makes the paper. The Prüfnachweis read-out goes with it while it is intact —
                the signed paper is the record (report_pdf · decision E), and «intact» is not
                news. A BROKEN chain is, and that raises the chip.
                Not rendered while checking either: a spinner that resolves to nothing a moment
                later is a flicker on the row, and the check is the app's business, not the
                operator's. */}
            {/* The Kontrolle detail is a POPOVER on the chip that opens it, not a band across the
                page: it is a handful of lines about the record, and a full-width slab pushed the form
                down every time anything was amiss. Anchored to the chip, so «what is wrong» and «the
                thing that told me» are the same object. A warning still reaches the operator without
                it — the chip itself is amber and counts them.
                Through overlays · Popover, like the print menu beside it — NOT hand-rolled absolute
                positioning. The hand-rolled version anchored to the chip's own edge, and on a phone
                the wrapped action row pushes that chip far enough right that a 358px panel opening
                leftwards from it started at roughly x=−130: the names in the Einsatzstunden warning
                were cut off the left of the screen, hard-clipped by the surface's `overflow: hidden`.
                Portalled + collision-aware, the panel is clamped to the viewport instead of to the
                chip, so no breakpoint has to guess which way it should open. */}
            {!checking && !controlOk && (
              <Popover
                open={controlOpen}
                onOpenChange={setControlOpen}
                popupClassName="rp-control"
                ariaLabel={P.controlHead}
                trigger={(
                  <button type="button" className={cx('rp-state', 'warn')} title={P.controlHead}>
                    <Icon id="warn" />
                    <span>{fillTemplate(P.controlOpen, { n: warnCount })}</span>
                  </button>
                )}
              >
                {missTx > 0 && (
                  <p className="report-pre-warn">
                    <Icon id="warn" /> <span>{fillTemplate(P.missingTranscripts, { n: missTx })}</span>
                    {onFixTranscripts && <button type="button" className="report-pre-fix" onClick={onFixTranscripts}>{P.fixTranscripts}</button>}
                  </p>
                )}
                {pendingMediaCount > 0 && (
                  <p className="report-pre-warn">
                    <Icon id="warn" /> <span>{fillTemplate(P.pendingMedia, { n: pendingMediaCount })}</span>
                  </p>
                )}
                {/* names them and says WHY — a count of «ohne verwertbare Zeiten» was the version
                    that got printed and that nobody could do anything with. The fix is one tap
                    away, on the Anwesenheit these names come from. */}
                {unresolvedNames.length > 0 && (
                  <p className="report-pre-warn">
                    {/* joined on «·», not on a comma: the names read «Müller Hans», so every
                        name already contains a space, and a comma between them is a weaker
                        break than the one inside each pair — the run scanned as one long
                        smear of words. A middot outranks the space and the list falls apart
                        into people again. */}
                    <Icon id="warn" /> <span>{fillTemplate(P.unresolvedHours, { names: unresolvedNames.join(' · ') })}</span>
                    {onOpenAnwesenheit && <button type="button" className="report-pre-fix" onClick={onOpenAnwesenheit}>{A.steps.anwesenheit}</button>}
                  </p>
                )}
                <div className="report-fold-body">
                  <p><Icon id={proof.intact ? 'check' : 'warn'} /> {proofLabel(proof)}</p>
                  <p><Icon id="doc" /> {fillTemplate(P.annotatedDefault, { n: annotatedPlanCount })}</p>
                  <p><Icon id="snapshot" /> {fillTemplate(P.stateNote, { at: formatDateTime(new Date().toISOString()) })}</p>
                </div>
              </Popover>
            )}
            {/* ⚠️ Every label in this row is wrapped in `.rp-btn-label`, not left as a bare text
                node: on a phone the row goes icon-only (see app.css) and a bare text node cannot
                be hidden. The label survives as `aria-label` + `title`, so what is dropped is the
                pixels, never the naming. */}
            {onComplete && (
              <button className="ip-btn" onClick={() => void complete()} aria-label={A.complete} title={A.complete}>
                <Icon id="archive" /><span className="rp-btn-label">{A.complete}</span>
              </button>
            )}
            {printStatus?.available && (
              <button className={`ip-btn print-send${printStatus.online ? '' : ' offline'}`} disabled={printBusy}
                onClick={() => void startOutput('print')} aria-label={printBusy ? R.sending : R.send}
                title={printStatus.online ? R.online : R.offline}>
                <span className="print-send-main">
                  <Icon id="printer" />
                  <span className={`dot print-relay-dot${printStatus.online ? ' online' : ''}`} aria-hidden />
                  <span className="rp-btn-label">{printBusy ? R.sending : R.send}</span>
                </span>
                {/* the offline reason is the whole point of the taller button — it stays when the
                    label goes, because «it will print later» is not guessable from a printer icon */}
                {!printStatus.online && <span className="print-send-off">{R.offline}</span>}
              </button>
            )}
            {/* Press it and it prints, with whatever is set. The ▾ is the second door: the same
                print again (so the menu is never a dead end for the one who opened it looking
                for «drucken»), and the way into the section picker. Split rather than two
                buttons: the arrow belongs TO the PDF button — it modifies it — and a separate
                ⋮ beside it would have read as the surface's menu. The pair never wraps apart
                (it is one flex item), so at ≤720px it drops onto its own line intact. */}
            <span className="rp-split">
              <button className="ip-btn primary rp-split-main" disabled={pdfBusy} onClick={() => void startOutput('pdf')}
                aria-label={pdfBusy ? P.pdfBusy : P.pdfFull} title={pdfBusy ? P.pdfBusy : P.pdfFull}>
                <Icon id={pdfBusy ? 'rotate' : 'doc'} className={pdfBusy ? 'spin' : undefined} />
                <span className="rp-btn-label">{pdfBusy ? P.pdfBusy : P.pdfFull}</span>
              </button>
              <Menu
                trigger={
                  <button type="button" className="ip-btn primary rp-split-more" aria-label={P.printMenu} title={P.printMenu}>
                    <Icon id="chevron-down" />
                  </button>
                }
                popupClassName="rp-print-menu"
                itemClassName={() => 'rp-print-menu-item'}
                // «Abschnitte» used to be a fold ON the page — a section of the rapport that is
                // not part of the rapport: it is neither recorded nor printed, it is how the
                // printing is done, and it was scrolled past on every Einsatz whose defaults were
                // already right, which is nearly all of them (the seed follows the data).
                // The sections are IN this menu now, not behind it: «was kommt aufs Papier» is
                // several decisions in a row, and a dialog to open, tick and close for each one is
                // the long way round something done while looking at the button that prints. Base
                // UI keeps the menu open on a checkbox, so the row just flipped is still there.
                items={[
                  // No «Einsatzrapport (PDF)» row in here. It was meant as a second door for
                  // whoever opened the ▾ looking for «drucken», but the door it repeats is the
                  // button the ▾ is physically attached to — one press to the left, already
                  // pressed to get here. A menu whose first line is the control that opened it
                  // teaches that the two do different things, and they do not.
                  // The ticks need a name. Nine of them under «Einsatzrapport (PDF)» with nothing
                  // saying what they are is a menu that has to be experimented with.
                  { kind: 'head' as const, label: P.sectionsHead },
                  { kind: 'check' as const, label: P.toggleKroki, checked: options.kroki && mapContentCount > 0, disabled: mapContentCount === 0, onChange: (v: boolean) => patchOpt({ kroki: v }) },
                  // Pläne is three-way (mit Anmerkungen / alle / keine) and does not fit a
                  // checkbox, so the menu offers the two that are actually chosen between: the
                  // annotated ones, or all of them. Off is «neither ticked».
                  { kind: 'check' as const, label: fillTemplate(P.plansAnnotated, { n: annotatedPlanCount }), checked: options.annotatedPlans && !options.allPlans, onChange: (v: boolean) => patchOpt({ annotatedPlans: v, allPlans: false }) },
                  { kind: 'check' as const, label: P.plansAll, checked: options.allPlans, onChange: (v: boolean) => patchOpt({ allPlans: v, annotatedPlans: v ? false : options.annotatedPlans }) },
                  { kind: 'sep' as const },
                  { kind: 'check' as const, label: fillTemplate(P.toggleAtemschutz, { n: truppCount }), checked: options.atemschutz, onChange: (v: boolean) => patchOpt({ atemschutz: v }) },
                  { kind: 'check' as const, label: fillTemplate(P.toggleAttendance, { n: attendanceCount }), checked: options.attendance, onChange: (v: boolean) => patchOpt({ attendance: v }) },
                  { kind: 'check' as const, label: fillTemplate(P.toggleMittel, { n: mittelCount }), checked: options.mittel, onChange: (v: boolean) => patchOpt({ mittel: v }) },
                  { kind: 'check' as const, label: P.toggleJournal, checked: options.journal, onChange: (v: boolean) => patchOpt({ journal: v }) },
                  { kind: 'check' as const, label: fillTemplate(P.toggleAttachments, { n: attachments.length }), checked: options.attachments && attachments.length > 0, disabled: attachments.length === 0, onChange: (v: boolean) => patchOpt({ attachments: v }) },
                  { kind: 'sep' as const },
                  { kind: 'check' as const, label: P.toggleDetailedAudit, checked: options.detailedAudit, onChange: (v: boolean) => patchOpt({ detailedAudit: v }) },
                ]}
              />
            </span>
          </div>
        </header>
        <div className="ip-body report-preflight-body" ref={bodyRef}>
          {/* TWO columns on a wide screen (one below 1080px, see app.css), because the rapport is
              worked in two different ways and they interleave: the FORM is typed straight through
              — dispatch readout, Zusammenfassung, the Zeiten, Bemerkungen — while the ROUND-UP
              beside it (wer und was war da: Anwesenheit · Mittel · Partner · Beilagen, then what
              will print) is checked off after the fact and jumps to other surfaces. Stacked they
              made one column two screens tall on a page half of which was margin; side by side
              the Zeiten grid gets the width it was always asking for and the checklist stays
              visible while the form is being typed. The DOM order is untouched — it is the order
              of the printed rapport and of the paper Erfassungsblatt (report_pdf.py,
              admin/capturePdf.ts, both tested) — the columns only decide WHERE, never in which
              order things are read. */}
          <div className="rp-col rp-col-form">
          {/* ONE disabled fieldset rather than a `readOnly` on twenty controls: a viewer, and an
              archived Einsatz («nur ansehen – zum Bearbeiten reaktivieren»), can read every
              recorded value here and change none of it. `persist` refuses too, so a stray
              handler can't slip past the markup. */}
          <fieldset className="report-fieldset" disabled={!canEdit}>
          <section className="report-pre-section report-pre-meta">
            {/* No <h3> here: the dispatch block carries its own «Aus den Einsatzdaten» heading and
                the edit link that belongs to it, so a section title above it was the same words
                twice. The other three sections have one because they have nothing else to say
                what they are. */}
            <div className="report-meta-dispatch">
              <div className="report-meta-dispatch-head">
                <span>{P.fromDispatch}</span>
                {onEditDispatch && (
                  <button type="button" className="report-meta-editlink" onClick={onEditDispatch}><Icon id="pen" /> {P.edit}</button>
                )}
              </div>
              <dl className="report-meta-readout">
                {/* The gateway hands us one field holding four different things (see
                    lib/alarmText). Shown verbatim it is mostly machinery — a marching order,
                    an object's notes, and a 300-character link this app minted itself — under
                    a heading that promises a MESSAGE. Split, each part lands where it belongs
                    and «Alarmmeldung» says «nicht erfasst» when nobody wrote one, which is the
                    honest answer and the common one. */}
                <div>
                  <dt>{P.alarmMessage}</dt>
                  <dd>{alarm.message || <span className="report-meta-empty">{P.notRecorded}</span>}</dd>
                </div>
                {alarm.vehicleOrder && (
                  <div><dt>{P.vehicleOrder}</dt><dd>{alarm.vehicleOrder}</dd></div>
                )}
                {alarm.plan && (
                  <div>
                    <dt>{P.einsatzplan}</dt>
                    <dd>
                      {alarm.plan.header}
                      {/* Sofortmassnahmen are the safety-relevant half — they stay. The
                          Bemerkungen belong to the Einsatzobjekt and are one tap away there. */}
                      {alarm.plan.measures.length > 0 && (
                        <ul className="report-meta-list">
                          {alarm.plan.measures.map((m, i) => <li key={i}>{m}</li>)}
                        </ul>
                      )}
                    </dd>
                  </div>
                )}
                <div><dt>{P.alarmierung}</dt><dd>{alarmiert ? formatDateTime(alarmiert) : <span className="report-meta-empty">{P.notRecorded}</span>}</dd></div>
              </dl>
            </div>
          </section>

          {/* «Rapportangaben» was ONE heading over everything after the dispatch facts — a blob a
              screen and a half long in which nothing could be found by looking. It is four
              sections now, each named after the question it answers, in exactly the order they
              were already in (that order is the printed rapport's). */}
          <section className="report-pre-section report-pre-meta">
            <h3>{P.sectionBericht}</h3>
            {/* after-arrival — editable inline (replaces the old Bearbeiten modal) */}
            <label className="ip-field">
              <span>{P.summaryLabel}</span>
              <textarea className="ip-textarea" value={summary} rows={5} placeholder={P.summaryPlaceholder}
                onChange={(e) => { const v = stripUnprintable(e.target.value); setSummary(v); persist({ summary: v.trim() || undefined }) }} />
            </label>
            <div className="report-meta-grid">
              <PersonField
                label={P.einsatzleiterLabel} placeholder={P.einsatzleiterPlaceholder}
                value={{ name: einsatzleiter }} onChange={(slot) => {
                  setEinsatzleiter(slot.name)
                  persist({ einsatzleiter: slot.name.trim() || undefined })
                  // the slot's personId was thrown away here — which is why the EL named on the
                  // Rapport never reached the Anwesenheit list
                  onRolePicked?.(slot.personId, 'el', appConfig.copy.anwesenheit.roleEinsatzleiter)
                }}
                personnel={personnel} legacyRoster={[]} presentIds={presentIds}
                assignedIds={NO_IDS} usedIds={NO_IDS} usedNames={NO_IDS}
                rankFirst officerFilter
              />
              <label className="ip-field">
                <span>{P.kontaktpersonLabel}</span>
                <input value={kontaktperson} placeholder={P.kontaktpersonPlaceholder}
                  onChange={(e) => { const v = stripUnprintable(e.target.value); setKontaktperson(v); persist({ kontaktperson: v.trim() || undefined }) }} />
              </label>
            </div>
            {/* one Kontaktperson carries all contact/ownership details (2026-07-18 —
                the kantonale Eigentümer/Ursache/Verursacher trio was retired: cause is
                not the Feuerwehr's to judge, one contact suffices) */}
            <div className="report-meta-grid">
              <div className="ip-field">
                <span>{P.geretteteLabel}</span>
                {/* two labelled ±steppers (shared Stepper) — tap −/+ or the value to type; matches the
                    details-modal count control. over-object carries the fresh values (state set in the
                    same tick is stale). Empty = null (shows «0» placeholder, − disabled). */}
                <div className="rz-counts">
                  <div className="rz-count">
                    <span>{P.gerettetePersonen}</span>
                    <Stepper value={numOrU(geretteteP) ?? null} min={0} max={999} seed={1} placeholder="0" ariaLabel={P.gerettetePersonen}
                      onChange={(v) => { setGeretteteP(String(v)); persist(geretteteOver(String(v), geretteteT)) }}
                      onClear={() => { setGeretteteP(''); persist(geretteteOver('', geretteteT)) }} canClear={geretteteP !== ''} />
                  </div>
                  <div className="rz-count">
                    <span>{P.geretteteTiere}</span>
                    <Stepper value={numOrU(geretteteT) ?? null} min={0} max={999} seed={1} placeholder="0" ariaLabel={P.geretteteTiere}
                      onChange={(v) => { setGeretteteT(String(v)); persist(geretteteOver(geretteteP, String(v))) }}
                      onClear={() => { setGeretteteT(''); persist(geretteteOver(geretteteP, '')) }} canClear={geretteteT !== ''} />
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="report-pre-section report-pre-meta">
            <h3>{P.sectionZeiten}</h3>
            {/* Ausgerückt: derived from the vehicle grid when it exists; the manual field
                only appears on deployments WITHOUT configured vehicles (nothing else to
                derive from). With vehicles configured but no times yet, the grid below is
                the entry point — a duplicate manual field would just contradict it. */}
            {derivedAus ? (
              <label className="ip-field">
                <span>{A.ausgerueckt}</span>
                <div className="report-meta-end rz-derived">
                  <b>{clockOf(derivedAus)}</b>
                  <span className="rz-sub">{P.ausgeruecktDerived}</span>
                </div>
              </label>
            ) : (getDeploymentConfig().fleet?.vehicles ?? []).length === 0 ? (
              <label className="ip-field">
                <span>{A.ausgerueckt}</span>
                <div className="report-meta-end dtrow">
                  <DateTimeField ariaLabel={A.ausgerueckt} value={dtLocalToIso(ausgerueckt)}
                    onCommit={(iso) => { setAusgerueckt(dtLocalValue(iso ?? undefined)); persist({ ausgeruecktAt: iso ?? undefined }) }} />
                </div>
                {zeitWarn('ausgerueckt')}
              </label>
            ) : null}
            {/* Alarmierungs-/Ausrückzeiten grid — rows from deployment config (empty config
                hides it); webhook-prefilled values, edits stamp `manual` (human wins). */}
            {(() => {
              const gRows = gruppenRows(getDeploymentConfig().alarms?.groups ?? [], gruppen)
              const vRows = fahrzeugRows(getDeploymentConfig().fleet?.vehicles ?? [], fahrzeuge)
              // The grid shows a bare clock, so the calendar day is resolved against the alarm —
              // an Ausrückzeit of 00:15 after an Alarmierung um 23:50 is the NEXT day, and used
              // to land 23h35 before the alarm. Same rule and same day wheel as the Rückmeldung
              // ELZ field below; `day` arrives only on an incident that spans more than one.
              const zeitDays = incidentDays(meta.startedAt ?? incident.started_at, nowRef)
              const onGruppe = (id: string, hhmm: string, day?: Date) => {
                const iso = zeitFromClock(incident.started_at, hhmm, day)
                const next = setGruppeZeit(gruppen, id, iso)
                setGruppen(next)
                persist({ gruppen: next.length ? next : undefined })
              }
              const onFahrzeug = (id: string, hhmm: string, day?: Date) => {
                const iso = zeitFromClock(incident.started_at, hhmm, day)
                const next = setFahrzeugZeit(fahrzeuge, id, 'ausgerueckt', iso)
                setFahrzeuge(next)
                persist({ fahrzeuge: next.length ? next : undefined, ausgeruecktAt: deriveAusgerueckt(next) ?? dtLocalToIso(ausgerueckt) })
              }
              return (
                <>
                  {gRows.length > 0 && (
                    <div className="ip-field">
                      <span>{P.gruppenLabel}</span>
                      <div className="rz-grid">
                        {gRows.map(({ config: c, value: v }) => (
                          <label key={c.id} className="rz-row">
                            <span className="rz-name">{c.label}{c.color ? ` (${c.color})` : ''}</span>
                            <TimeField ariaLabel={c.label} value={clockOf(v?.alarmedAt)} days={zeitDays}
                              onCommit={(hhmm, day) => onGruppe(c.id, hhmm ?? '', day)} />
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  {vRows.length > 0 && (
                    <div className="ip-field">
                      <span>{P.fahrzeugeLabel}</span>
                      <div className="rz-grid">
                        {vRows.map(({ config: c, value: v }) => (
                          <label key={c.id} className="rz-row">
                            <span className="rz-name">
                              {c.label}
                              {(v?.vorOrt || v?.zurueck) && (
                                <span className="rz-sub">
                                  {v?.vorOrt ? ` ${P.vorOrtShort} ${clockOf(v.vorOrt)}` : ''}
                                  {v?.zurueck ? ` · ${P.zurueckShort} ${clockOf(v.zurueck)}` : ''}
                                </span>
                              )}
                            </span>
                            <TimeField ariaLabel={c.label} value={clockOf(v?.ausgerueckt)} days={zeitDays}
                              onCommit={(hhmm, day) => onFahrzeug(c.id, hhmm ?? '', day)} />
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )
            })()}
            <label className="ip-field">
              <span>{P.incidentEndLabel}</span>
              <div className="report-meta-end dtrow">
                <DateTimeField ariaLabel={P.incidentEndLabel} value={dtLocalToIso(endedAt)}
                  onCommit={(iso) => { setEndedAt(dtLocalValue(iso ?? undefined)); persist({ endedAt: iso ?? undefined }) }} />
                <button type="button" className="ip-btn" onClick={() => { const v = dtLocalValue(new Date().toISOString()); setEndedAt(v); persist({ endedAt: dtLocalToIso(v) }) }}>{P.now}</button>
              </div>
              {zeitWarn('ende')}
            </label>
          </section>

          <section className="report-pre-section report-pre-meta">
            <h3>{P.sectionNachbearbeitung}</h3>
            <label className="ip-field">
              <span>{P.remarksLabel}</span>
              <textarea className="ip-textarea" value={remarks} rows={3} placeholder={P.remarksPlaceholder}
                onChange={(e) => { const v = stripUnprintable(e.target.value); setRemarks(v); persist({ remarks: v.trim() || undefined }) }} />
            </label>
            <label className="ip-field">
              <span>{P.lehrenLabel}</span>
              <textarea className="ip-textarea" value={lehren} rows={3} placeholder={P.lehrenPlaceholder}
                onChange={(e) => { const v = stripUnprintable(e.target.value); setLehren(v); persist({ lehren: v.trim() || undefined }) }} />
            </label>
            <div className="report-meta-grid rz-rueck-grid">
              {/* who reported back to the ELZ — a roster pick like Einsatzleiter, free text allowed */}
              <PersonField
                label={P.rueckmeldungLabel} placeholder={P.rueckmeldungName}
                value={{ name: rueckName }} onChange={(slot) => {
                  setRueckName(slot.name)
                  persist(rueckOver(slot.name, rueckAt))
                  // whoever reported back to the ELZ was on scene to have something to report
                  onRolePicked?.(slot.personId, 'el')
                }}
                personnel={personnel} legacyRoster={[]} presentIds={presentIds}
                assignedIds={NO_IDS} usedIds={NO_IDS} usedNames={NO_IDS}
                rankFirst
              />
              <div className="ip-field">
                <span>{P.rueckmeldungZeit}</span>
                <TimeField ariaLabel={P.rueckmeldungZeit} value={rueckAt} nowLabel={P.now}
                  days={incidentDays(meta.startedAt ?? incident.started_at, nowRef)}
                  onCommit={(hhmm, day) => { setRueckAt(hhmm ?? ''); persist(rueckOver(rueckName, hhmm ?? '', day)) }} />
              </div>
            </div>
            {/* Partnerorganisationen: WHO was there, from whom, reachable how — and the remark,
                which is the whole reason to write a partner down at all («Wm. Keller, übernimmt
                Verkehr ab Kreisel»). The organisation is offered from the station's list and
                stays free text, because the one that turns up is never the one on the list. */}
          </section>


          </fieldset>
          </div>

          <div className="rp-col rp-col-side">
          {/* Four SECTIONS, not four cards inside a fifth. They used to sit in an unnamed
              `.report-pre-section` wrapper — a box round a box, headed by nothing, while the
              column opposite carried named cards at the top level. Each of these already says
              what it is and how much of it there is, so the wrapper was pure nesting: a border
              weight, a padding, and a rhythm that did not match the form beside it.
              They still belong together and still read in this order (it is the printed one):
              all four answer «wer und was war da», and all four are filled in after the fact. */}
          <div className="rp-checks">
            <CaptureUsageChip usage={captureUsage} />
            <CheckRow
              done={stepDone('anwesenheit', facts)}
              label={A.steps.anwesenheit}
              sub={fillTemplate(A.personen, { n: attendanceCount })}
              onGo={onOpenAnwesenheit}
            >
              {/* quick double-check, not an editor: everyone recorded, early leavers
                  flagged inline — corrections go through the row's arrow (Anwesenheit) */}
              {attendanceCount > 0 && (
                <div className="rp-check-extra">
                  <div className="rp-people">
                    {rows.map((r) => (
                      <span key={r.personId} className="rp-person">
                        {r.name}
                        {/* the job they had — «Einsatzleiter», «Fahrer TLF» — read straight off
                            their Bemerkung, the same string the printed Personal-/Anwesenheits-
                            blatt puts under the name. At the end of an Einsatz this list IS the
                            check «wer war da, und als was», so the function belongs on it. */}
                        {(attendance[r.personId]?.note ?? '').trim()
                          && <i>{` · ${(attendance[r.personId]!.note ?? '').trim()}`}</i>}
                        {/* only somebody who actually LEFT gets a time. hoursRows fills an open
                            block with the Einsatzende, which put «· bis 09:00» behind every name
                            on the list — the exception it exists to flag then read as the rule. */}
                        {r.leftEarly && <em>{fillTemplate(A.leftEarly, { t: dtLocalValue(r.to!).slice(11) })}</em>}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </CheckRow>
            <CheckRow done={stepDone('mittel', facts)} label={A.steps.mittel} sub={fillTemplate(A.mittelCount, { n: mittelCount })} onGo={onOpenMittel}>
              {mittelCount > 0 && (
                <div className="rp-check-extra">
                  <div className="rp-people">
                    {/* one line, three weights, same shape as the Anwesenheit list beside it:
                        the amount is the value (bold), the unit and the material are the thing,
                        and where it came from is the dim qualifier — «3 Sack Bindemittel · TLF».
                        It used to set amount AND unit bold and print the Quelle in full ink, so
                        four items read as one wall of equally loud text. */}
                    {visibleMittel(mittel).map((l) => (
                      <span key={l.key} className="rp-person">
                        <b>{l.menge}</b> {l.unit} {l.label}
                        {l.sourceLabel && <i>{` · ${l.sourceLabel}`}</i>}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {mittelCount === 0 && onComplete && (
                <div className="rp-check-extra">
                  <button
                    type="button"
                    className={`ip-btn${meta.mittelConfirmedNone ? ' primary' : ''}`}
                    onClick={() => persist({ mittelConfirmedNone: !meta.mittelConfirmedNone })}
                  >
                    {meta.mittelConfirmedNone ? A.mittelNoneOn : A.mittelNone}
                  </button>
                </div>
              )}
            </CheckRow>
            {/* Partnerorganisationen sit with Anwesenheit and Mittel: all three answer «who and
                what was here», and all three are the parts of the rapport that get filled in
                after the fact. The station's own list is the choice (free text stays possible —
                the one that turns up is not always on it), and one free line beside it carries
                whatever is worth saying: «Wm. Keller, übernimmt Verkehr ab Kreisel». */}
            <CheckRow
              done={partners.length > 0}
              label={P.partnersLabel}
              sub={partners.length ? partners.map((p) => p.org).filter(Boolean).join(' · ') : P.partnersNone}
            >
              <div className="rp-check-extra">
                {/* own gate: the sheet's main fieldset ends above the checklist, so a viewer or
                    a closed Einsatz would otherwise get fully live controls here */}
                <fieldset className="report-fieldset rp-check-gate" disabled={!canEdit}>
                  {/* A CHECKLIST, not a picker: every organisation the station works with is
                      already on the list, so the question is «war die da?» — one tap per row,
                      nothing to search, and an unticked row still proves it was considered.
                      Ticking reveals the one free line («Wm. Keller, Verkehr ab Kreisel»). */}
                  <div className="report-partners">
                    {partnerRows.map((r) => {
                      const on = r.i >= 0
                      return (
                        <div className={cx('report-partner', on && 'on')} key={r.custom ? `c${r.i}` : r.org}>
                          {/* a free row NAMES itself in its own field — repeating the label beside
                              that field cost 170px the row did not have, and the delete button
                              wrapped onto a line of its own */}
                          <button
                            type="button" className={cx('report-partner-tick', r.custom && 'bare')}
                            role="checkbox" aria-checked={on} aria-label={r.org || P.partnerOrgShort}
                            onClick={() => (on
                              ? savePartners(partners.filter((_, j) => j !== r.i))
                              : savePartners([...partners, { org: r.org }]))}
                          >
                            <span className="report-partner-box">{on && <Icon id="check" />}</span>
                            {!r.custom && <span className="report-partner-org">{r.org}</span>}
                          </button>
                          {/* a free-typed organisation names itself; a listed one is already named */}
                          {on && r.custom && (
                            <input
                              className="ip-input report-partner-name" value={partners[r.i].org ?? ''}
                              placeholder={P.partnerOrgShort} aria-label={P.partnerOrgShort}
                              onChange={(e) => patchPartner(r.i, { org: stripUnprintable(e.target.value) })} maxLength={80}
                            />
                          )}
                          {on && (
                            <input
                              className="ip-input" value={partners[r.i].note ?? ''} placeholder={P.partnerNote}
                              aria-label={`${r.org || P.partnerOrgShort} – ${P.partnerNote}`}
                              onChange={(e) => patchPartner(r.i, { note: stripUnprintable(e.target.value) })} maxLength={240}
                            />
                          )}
                          {on && r.custom && (
                            <button
                              type="button" className="report-att-x" aria-label={appConfig.copy.delete}
                              title={appConfig.copy.delete}
                              onClick={() => savePartners(partners.filter((_, j) => j !== r.i))}
                            ><Icon id="trash" /></button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  {/* the list covers the usual partners; the one that turns up anyway still has
                      to be recordable, so a free row stays available underneath it */}
                  <button type="button" className="report-row-add" onClick={() => savePartners([...partners, { org: '' }])}>
                    <Icon id="plus" /><span>{P.partnerAdd}</span>
                  </button>
                </fieldset>
              </div>
            </CheckRow>
            {/* Beilagen sit right under Partnerorganisationen: same family, same question —
                what else belongs to this rapport. Tapping a thumbnail opens the picture full-size
                (lib/ui · openPhoto), because a 52px square is not something you can check. */}
            <CheckRow
              done={attachments.length > 0}
              label={P.attachmentsHead}
              sub={attachments.length ? fillTemplate(P.attachmentsCount, { n: attachments.length }) : P.attachmentsNone}
            >
              <div className="rp-check-extra">
                <p className="report-att-hint">{P.attachmentsHint}</p>
                {attachments.length > 0 && (
                  <ul className="report-att-list">
                    {attachments.map((a) => (
                      <li key={a.id} className="report-att">
                        <button
                          type="button" className="report-att-thumb" title={P.attachmentsOpen}
                          aria-label={P.attachmentsOpen}
                          onClick={() => openPhoto(a.url, { caption: a.caption, filename: `beilage-${a.id}.jpg` })}
                        >
                          <img src={a.url} alt="" />
                        </button>
                        <div className="report-att-body">
                          <input
                            className="ip-input" value={a.caption ?? ''} placeholder={P.attachmentsCaption}
                            aria-label={P.attachmentsCaption} disabled={!onCaptionAttachment}
                            // typed value goes in untouched (trimming on change eats the space
                            // you just pressed); the tidy-up happens once, on leaving the field
                            onChange={(e) => onCaptionAttachment?.(a.id, stripUnprintable(e.target.value))}
                            onBlur={(e) => {
                              const v = e.target.value.trim()
                              if (v !== e.target.value) onCaptionAttachment?.(a.id, v)
                            }}
                          />
                          {a.url.startsWith('blob:') && <span className="report-att-pending">{P.attachmentsPending}</span>}
                        </div>
                        {onRemoveAttachment && (
                          <button type="button" className="report-att-x" aria-label={appConfig.copy.delete}
                            title={appConfig.copy.delete} onClick={() => onRemoveAttachment(a.id)}><Icon id="trash" /></button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {onAddAttachments && (
                  <label className="report-row-add report-att-add">
                    <Icon id="photo" /><span>{P.attachmentsAdd}</span>
                    <input type="file" accept="image/*" multiple
                      onChange={(e) => {
                        const files = [...(e.target.files ?? [])]
                        if (files.length) onAddAttachments(files)
                        e.target.value = ''
                      }} />
                  </label>
                )}
              </div>
            </CheckRow>
          </div>

          {/* The Kroki, on the page. It was a modal that opened on the press of PDF / Ausdrucken,
              so the crop was chosen blind for the whole time the rapport was being written and
              then decided in a hurry, on top of a surface that had itself just stopped being a
              dialog. It sits at the END of the checklist column, below the rows worked most
              (Anwesenheit, Mittel), which it would otherwise push down by the height of a map.
              Whether a Kroki prints at all is a section, and sections live on the print action
              now — switching it off takes this panel away with it (see krokiPanel).
              No confirm step: whatever the crop shows when PDF or Ausdrucken is pressed is what
              prints, and `startOutput` remembers it as this Einsatz's framing. */}
          {/* No fold. The panel is the only thing on this page that shows what the picture will
              be, and a section that is open every time it is looked at is a section with a
              chevron in front of it for nothing. */}
          {krokiPanel && (
            <section className="report-pre-section rp-kroki">
              <h3>{P.krokiHead}</h3>
              <KrokiFramingPanel
                  scene={effScene}
                  initial={options.krokiView}
                  // WHEN the picture shows. One picture is one Lage at one time; naming the
                  // moment is the honest answer to «die Rettung ist weg», and the map redraws
                  // under the crop as it is reconstructed.
                  atMs={krokiAt}
                  atBusy={krokiAtBusy}
                  onAtChange={setKrokiAt}
                  moments={krokiMoments}
                  startedAtMs={Date.parse(meta.startedAt ?? incident.started_at) || null}
                  landscape={options.krokiLandscape}
                  onLandscapeChange={(v) => patchOpt({ krokiLandscape: v })}
                  // the preview has to show what the sheet will show: the Trupp in a hose's end
                  // tag and the same Beschriftungen setting the export resolves captions under
                  trupps={trupps}
                  captionMode={scene?.captionMode ?? 'auto'}
                  onViewChange={(v) => patchOpt({ krokiView: v })}
                />
            </section>
          )}

          </div>
        </div>

        {/* Pinned to the bottom of the surface instead of scrolling away at the end of the form.
            As a sheet the buttons WERE the end of a thing you filled in top to bottom; a page is
            not read that way — the rapport is opened mid-Einsatz to correct one time and print,
            and «PDF» sitting two screens below was the reason for every scroll to the bottom.
            Kontrolle comes with it (it is the row directly above the actions in the print order
            anyway): a warning must be read BEFORE paper is made, and pinning the button without
            pinning the warning would have made it possible to print past one without ever having
            seen it — the same failure the «never behind a fold» rule exists to prevent. */}
      </div>
    </>
  )
}

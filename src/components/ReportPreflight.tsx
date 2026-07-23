import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { confirmDialog, toast } from '../lib/ui'
import { buildDirectReportPayload, downloadDirectReportPdf } from '../lib/reportPdfDirect'
import { KrokiFramingModal } from './KrokiFramingModal'
import { Overlay } from '../lib/overlays'
import { cancelPrint, editorPrintTransport, enqueuePrint, fetchPrintStatus, type PrintRelayStatus } from '../lib/printRelay'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import type { IncidentMeta } from '../lib/incidents'
import { getIncident, verifyChain } from '../lib/incidents'
import type { FahrzeugZeit, GruppeZeit, ReportMeta } from '../lib/workspace'
import { deriveAusgerueckt, fahrzeugRows, gruppenRows, setFahrzeugZeit, setGruppeZeit } from '../lib/alarmzeiten'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import type { AuditProof, KrokiView, ReportDraft, ReportOptions } from '../lib/report'
import { defaultReportOptions, formatDateTime, missingTranscriptCount, proofLabel } from '../lib/report'
import { applyTimeToIso, missingSteps, stepDone, type AbschlussFacts } from '../lib/abschluss'
import { hoursRows } from '../lib/attendanceHours'
import type { AttendanceState, BoardDoc, BuildingDoc, Drawing, Entity, LayerDef, LngLat, MittelEntry, Person, PlanDocument, TimelineEvent, Trupp } from '../types'
import { visibleMittel } from '../lib/mittel'
import { PersonField } from './AtemschutzView'
import { CaptureUsageChip, type CaptureUsage } from './CaptureUsageChip'
import { DateTimeField, TimeField } from './TimeField'
import { Segmented } from './Segmented'
import { Stepper } from './Stepper'

const NO_IDS = new Set<string>()

function localValue(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function isoValue(local: string): string | undefined {
  if (!local) return undefined
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** HH:MM display value for the compact time inputs of the Zeiten grid. */
function clockOf(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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

function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`report-toggle${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
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
  incident, reportMeta, personnel = [], presentIds = NO_IDS, events, annotatedPlanCount, truppCount, attendanceCount, mittelCount, mittel = [], mapContentCount = 1, pendingMediaCount = 0, attendance = {}, trupps = [], plans = [], scene, board, building, captureUsage, onSaveMeta, onEditDispatch, onOpenAnwesenheit, onOpenMittel, onComplete, onClose, onFixTranscripts,
}: {
  incident: IncidentMeta
  reportMeta: ReportMeta
  /** Mannschaft roster + who is present — the Einsatzleiter picker offers present crew first */
  personnel?: Person[]
  presentIds?: Set<string>
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
  }
  /** plan whiteboard annotations — server-rendered annotated Objektplan pages */
  board?: BoardDoc
  /** the picked Gebäude (floor stack) — exports as blank-base plan pages when present */
  building?: BuildingDoc | null
  /** QR self-reporting in use — «QR: N Einträge · zuletzt HH:MM» chip (informational) */
  captureUsage?: CaptureUsage | null
  /** persist the inline Rapportangaben edits (after-arrival fields) into the workspace */
  onSaveMeta: (next: ReportMeta) => void
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
  onClose: () => void
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
  })
  const [proof, setProof] = useState<AuditProof>({ intact: null, checkedAt: new Date().toISOString(), offline: true })
  const [checking, setChecking] = useState(true)
  // the alarm text auto-fills from the incident's dispatch text when none was typed in the
  // Einsatzdaten panel — display + print fallback only, never persisted into the report blob.
  const [alarmFallback, setAlarmFallback] = useState('')

  // Rapportangaben = the after-arrival fields, edited inline here. Seeded once from the blob;
  // every change is persisted live (see persist) so nothing is lost if the sheet is closed.
  const [summary, setSummary] = useState(reportMeta.summary ?? '')
  const [kontaktperson, setKontaktperson] = useState(reportMeta.kontaktperson ?? '')
  const [einsatzleiter, setEinsatzleiter] = useState(reportMeta.einsatzleiter ?? '')
  const [endedAt, setEndedAt] = useState(localValue(reportMeta.endedAt ?? incident.closed_at ?? undefined))
  const [ausgerueckt, setAusgerueckt] = useState(localValue(reportMeta.ausgeruecktAt))
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
  const rueckOver = (name: string, hhmm: string): Partial<ReportMeta> => {
    const at = (hhmm ? applyTimeToIso(incident.started_at, hhmm, { nextDayIfBefore: incident.started_at }) : null) ?? undefined
    return { rueckmeldungElz: name.trim() || at ? { name: name.trim() || undefined, at } : undefined }
  }
  const editedMeta = (): Partial<ReportMeta> => ({
    summary: summary.trim() || undefined,
    kontaktperson: kontaktperson.trim() || undefined,
    einsatzleiter: einsatzleiter.trim() || undefined,
    endedAt: isoValue(endedAt),
    ausgeruecktAt: derivedAus ?? isoValue(ausgerueckt),
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
  const persist = (over: Partial<ReportMeta>) => onSaveMeta({
    ...reportMeta,
    ...editedMeta(),
    ...over,
  })

  const meta: ReportMeta = {
    ...reportMeta,
    ...editedMeta(),
    alarmText: reportMeta.alarmText ?? (alarmFallback || undefined),
    // Alarmierung = the incident's start (= when we were alarmed); editable in Einsatzdaten
    alarmiertAt: reportMeta.alarmiertAt ?? incident.started_at,
  }
  const alarmiert = meta.alarmiertAt
  const missTx = missingTranscriptCount(events)
  // krokiView arrives fresh from the framing modal — options state is set in parallel,
  // so it's passed explicitly instead of read back (setState is async)
  const buildDraft = (krokiView?: KrokiView | null): ReportDraft => {
    const generatedAt = new Date().toISOString()
    return { meta, generatedAt, proof: { ...proof, checkedAt: proof.checkedAt || generatedAt }, options: { ...options, krokiView: krokiView ?? options.krokiView } }
  }
  const [pdfBusy, setPdfBusy] = useState(false)
  // ONE button (decided 2026-07-18): the server composes the complete rapport — map
  // render included (app/kroki.py) — from pure data. No Druckansicht detour anymore.
  const downloadPdf = async (krokiView?: KrokiView | null) => {
    const draft = buildDraft(krokiView)
    setPdfBusy(true)
    try {
      await downloadDirectReportPdf({
        incident, draft, trupps, attendance, events, plans, mittel, scene, board, building,
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
  const R = appConfig.copy.printRelay
  const sendToPrinter = async (krokiView?: KrokiView | null) => {
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
        incident, draft: buildDraft(krokiView), trupps, attendance, events, plans, mittel, scene, board, building,
        roster: personnel.filter((p) => p.active).map((p) => ({ id: p.id, name: p.displayName })),
      })
      const jobId = await enqueuePrint(t, incident.id, payload)
      toast(R.queued, {
        icon: 'check',
        action: {
          label: R.undo,
          onClick: () => {
            void cancelPrint(t, jobId).then((ok) =>
              toast(ok ? R.cancelled : R.undoTooLate, ok ? {} : { icon: 'warn', tone: 'warn' }))
          },
        },
      })
    } catch {
      toast(R.failed, { icon: 'warn', tone: 'warn' })
    } finally {
      setPrintBusy(false)
    }
  }
  const patchOpt = (patch: Partial<ReportOptions>) => setOptions((o) => ({ ...o, ...patch }))
  // Kroki in the output → ALWAYS pick the framing first (WYSIWYG modal, seeded with the
  // auto-fit or the last chosen crop); without a Kroki the action runs directly.
  const [framingFor, setFramingFor] = useState<null | 'pdf' | 'print'>(null)
  const startOutput = (action: 'pdf' | 'print') => {
    if (options.kroki && mapContentCount > 0 && scene) { setFramingFor(action); return }
    if (action === 'pdf') void downloadPdf()
    else void sendToPrinter()
  }
  const P = appConfig.copy.preflight
  const A = appConfig.copy.abschluss

  // Derived closing checklist (lib/abschluss): the sheet is the ONE closing surface — the
  // status is recomputed from the data on every render, never stored as visited-state.
  const facts: AbschlussFacts = { reportMeta: meta, attendanceCount, mittelCount }
  const rows = hoursRows(attendance, { alarmedAt: alarmiert ?? null, endedAt: meta.endedAt ?? null })

  // «Einsatz abschliessen» is bookkeeping, not the artefact: it stamps report_done_at and
  // archives. The PDF is its own (primary) action — decoupled by decision 2026-07-08 after
  // auto-download-on-complete felt wrong in the field.
  const complete = async () => {
    if (!onComplete) return
    const missing = missingSteps(facts)
    const message = missing.length
      ? `${fillTemplate(A.confirmMissing, { steps: missing.map((s) => A.steps[s]).join(', ') })} ${A.confirmMsg}`
      : A.confirmMsg
    if (await confirmDialog({ title: A.confirmTitle, message, confirmLabel: A.confirmBtn })) { savedScroll.current = null; onComplete() }
  }

  // Scroll keep-alive across the Anwesenheit/Mittel/Verlauf round trip (see savedScroll):
  // restore before paint on mount, capture on unmount. Deliberate closes go through close().
  const bodyRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && savedScroll.current?.incidentId === incident.id) el.scrollTop = savedScroll.current.top
    return () => { if (el) savedScroll.current = { incidentId: incident.id, top: el.scrollTop } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const close = () => { savedScroll.current = null; onClose() }

  return (
    <>
      <Overlay open onClose={close} className="ip-sheet ip-wide report-preflight ui-dialog" ariaLabel={P.title}>
        <div className="ip-head">
          <h2>{P.title}</h2>
          <button className="ip-x" onClick={close} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
        </div>
        <div className="ip-body report-preflight-body" ref={bodyRef}>
          <section className="report-pre-section report-pre-meta">
            <h3>{P.rapportHead}</h3>
            {/* dispatch facts — read-only here; the link jumps to Einsatzdaten where they live */}
            <div className="report-meta-dispatch">
              <div className="report-meta-dispatch-head">
                <span>{P.fromDispatch}</span>
                {onEditDispatch && (
                  <button type="button" className="report-meta-editlink" onClick={onEditDispatch}><Icon id="pen" /> {P.edit}</button>
                )}
              </div>
              <dl className="report-meta-readout">
                <div><dt>{P.alarmMessage}</dt><dd>{meta.alarmText || <span className="report-meta-empty">{P.notRecorded}</span>}</dd></div>
                <div><dt>{P.alarmierung}</dt><dd>{alarmiert ? formatDateTime(alarmiert) : <span className="report-meta-empty">{P.notRecorded}</span>}</dd></div>
              </dl>
            </div>
            {/* after-arrival — editable inline (replaces the old Bearbeiten modal) */}
            <label className="ip-field">
              <span>{P.summaryLabel}</span>
              <textarea className="ip-textarea" value={summary} rows={5} placeholder={P.summaryPlaceholder}
                onChange={(e) => { setSummary(e.target.value); persist({ summary: e.target.value.trim() || undefined }) }} />
            </label>
            <div className="report-meta-grid">
              <PersonField
                label={P.einsatzleiterLabel} placeholder={P.einsatzleiterPlaceholder}
                value={{ name: einsatzleiter }} onChange={(slot) => { setEinsatzleiter(slot.name); persist({ einsatzleiter: slot.name.trim() || undefined }) }}
                personnel={personnel} legacyRoster={[]} presentIds={presentIds}
                assignedIds={NO_IDS} usedIds={NO_IDS} usedNames={NO_IDS}
                rankFirst officerFilter
              />
              <label className="ip-field">
                <span>{P.kontaktpersonLabel}</span>
                <input value={kontaktperson} placeholder={P.kontaktpersonPlaceholder}
                  onChange={(e) => { setKontaktperson(e.target.value); persist({ kontaktperson: e.target.value.trim() || undefined }) }} />
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
                  <DateTimeField ariaLabel={A.ausgerueckt} value={isoValue(ausgerueckt)}
                    onCommit={(iso) => { setAusgerueckt(localValue(iso ?? undefined)); persist({ ausgeruecktAt: iso ?? undefined }) }} />
                </div>
              </label>
            ) : null}
            {/* Alarmierungs-/Ausrückzeiten grid — rows from deployment config (empty config
                hides it); webhook-prefilled values, edits stamp `manual` (human wins). */}
            {(() => {
              const gRows = gruppenRows(getDeploymentConfig().alarms?.groups ?? [], gruppen)
              const vRows = fahrzeugRows(getDeploymentConfig().fleet?.vehicles ?? [], fahrzeuge)
              const onGruppe = (id: string, hhmm: string) => {
                const iso = hhmm ? applyTimeToIso(incident.started_at, hhmm) : null
                const next = setGruppeZeit(gruppen, id, iso)
                setGruppen(next)
                persist({ gruppen: next.length ? next : undefined })
              }
              const onFahrzeug = (id: string, hhmm: string) => {
                const iso = hhmm ? applyTimeToIso(incident.started_at, hhmm) : null
                const next = setFahrzeugZeit(fahrzeuge, id, 'ausgerueckt', iso)
                setFahrzeuge(next)
                persist({ fahrzeuge: next.length ? next : undefined, ausgeruecktAt: deriveAusgerueckt(next) ?? isoValue(ausgerueckt) })
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
                            <TimeField ariaLabel={c.label} value={clockOf(v?.alarmedAt)} onCommit={(hhmm) => onGruppe(c.id, hhmm ?? '')} />
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
                            <TimeField ariaLabel={c.label} value={clockOf(v?.ausgerueckt)} onCommit={(hhmm) => onFahrzeug(c.id, hhmm ?? '')} />
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
                <DateTimeField ariaLabel={P.incidentEndLabel} value={isoValue(endedAt)}
                  onCommit={(iso) => { setEndedAt(localValue(iso ?? undefined)); persist({ endedAt: iso ?? undefined }) }} />
                <button type="button" className="ip-btn" onClick={() => { const v = localValue(new Date().toISOString()); setEndedAt(v); persist({ endedAt: isoValue(v) }) }}>{P.now}</button>
              </div>
            </label>
            <label className="ip-field">
              <span>{P.remarksLabel}</span>
              <textarea className="ip-textarea" value={remarks} rows={3} placeholder={P.remarksPlaceholder}
                onChange={(e) => { setRemarks(e.target.value); persist({ remarks: e.target.value.trim() || undefined }) }} />
            </label>
            <label className="ip-field">
              <span>{P.lehrenLabel}</span>
              <textarea className="ip-textarea" value={lehren} rows={3} placeholder={P.lehrenPlaceholder}
                onChange={(e) => { setLehren(e.target.value); persist({ lehren: e.target.value.trim() || undefined }) }} />
            </label>
            <div className="report-meta-grid rz-rueck-grid">
              {/* who reported back to the ELZ — a roster pick like Einsatzleiter, free text allowed */}
              <PersonField
                label={P.rueckmeldungLabel} placeholder={P.rueckmeldungName}
                value={{ name: rueckName }} onChange={(slot) => { setRueckName(slot.name); persist(rueckOver(slot.name, rueckAt)) }}
                personnel={personnel} legacyRoster={[]} presentIds={presentIds}
                assignedIds={NO_IDS} usedIds={NO_IDS} usedNames={NO_IDS}
                rankFirst
              />
              <div className="ip-field">
                <span>{P.rueckmeldungZeit}</span>
                <TimeField ariaLabel={P.rueckmeldungZeit} value={rueckAt} nowLabel={P.now}
                  onCommit={(hhmm) => { setRueckAt(hhmm ?? ''); persist(rueckOver(rueckName, hhmm ?? '')) }} />
              </div>
            </div>
          </section>

          {/* the closing checklist: ONLY the two rows that navigate somewhere (Anwesenheit /
              Mittel). Zeiten + Zusammenfassung are ordinary fields above — the missing-steps
              confirm still guards them; Verlauf dropped (system rows made it always-green).
              Sits below Rapportangaben so the sheet lands on a clean title + the report facts. */}
          <section className="report-pre-section rp-checks">
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
                        {r.to && <em>{fillTemplate(A.leftEarly, { t: localValue(r.to).slice(11) })}</em>}
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
                    {visibleMittel(mittel).map((l) => (
                      <span key={l.key} className="rp-person">
                        <b>{l.menge} {l.unit}</b> {l.label}{l.sourceLabel ? ` · ${l.sourceLabel}` : ''}
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
          </section>

          <section className="report-pre-section">
            <h3>{P.sectionsHead}</h3>
            {/* grouped, not one flat checkbox list: map material, then the data sections; the
                two expert options fold behind «Erweitert» (field feedback 2026-07-09). The
                plans choice is a 3-way segment mapping onto the annotatedPlans/allPlans pair
                (all wins over annotated in the print derivation, see lib/report). */}
            <div className="report-toggles">
              <div className="report-toggle-grouphead">{P.groupMap}</div>
              {/* framing is chosen visually in the KrokiFramingModal right before PDF /
                  Ausdrucken — no «aktuelle Ansicht» / extent toggles needed anymore */}
              <Toggle label={P.toggleKroki} checked={options.kroki && mapContentCount > 0} onChange={(v) => patchOpt({ kroki: v })} disabled={mapContentCount === 0} />
              <div className="report-plans-row">
                <span>{P.plansLabel}</span>
                <Segmented<'annotated' | 'all' | 'none'>
                  ariaLabel={P.plansLabel}
                  value={options.allPlans ? 'all' : options.annotatedPlans ? 'annotated' : 'none'}
                  options={[
                    { value: 'annotated', label: fillTemplate(P.plansAnnotated, { n: annotatedPlanCount }), disabled: annotatedPlanCount === 0 },
                    { value: 'all', label: P.plansAll },
                    { value: 'none', label: P.plansNone },
                  ]}
                  onChange={(id) => patchOpt(id === 'all' ? { allPlans: true } : id === 'annotated' ? { annotatedPlans: true, allPlans: false } : { annotatedPlans: false, allPlans: false })}
                />
              </div>
              <div className="report-toggle-grouphead">{P.groupContents}</div>
              <Toggle label={fillTemplate(P.toggleAtemschutz, { n: truppCount })} checked={options.atemschutz && truppCount > 0} onChange={(v) => patchOpt({ atemschutz: v })} disabled={truppCount === 0} />
              {/* Personal + Material are form sheets: printable with zero records (stubs) */}
              <Toggle label={fillTemplate(P.toggleAttendance, { n: attendanceCount })} checked={options.attendance} onChange={(v) => patchOpt({ attendance: v })} />
              <Toggle label={fillTemplate(P.toggleMittel, { n: mittelCount })} checked={options.mittel} onChange={(v) => patchOpt({ mittel: v })} />
              <Toggle label={P.toggleJournal} checked={options.journal} onChange={(v) => patchOpt({ journal: v })} />
              <details className="report-adv">
                <summary><Icon id="chevron-down" /> {P.groupAdvanced}</summary>
                <div className="report-adv-body">
                  <Toggle label={P.toggleDetailedAudit} checked={options.detailedAudit} onChange={(v) => patchOpt({ detailedAudit: v })} />
                </div>
              </details>
            </div>
          </section>

          <section className="report-pre-section report-pre-hints">
            <h3>{P.controlHead}</h3>
            <p><Icon id={checking ? 'rotate' : proof.intact ? 'check' : 'warn'} /> {checking ? P.proofChecking : proofLabel(proof)}</p>
            <p><Icon id="doc" /> {fillTemplate(P.annotatedDefault, { n: annotatedPlanCount })}</p>
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
            <p><Icon id="snapshot" /> {fillTemplate(P.stateNote, { at: formatDateTime(new Date().toISOString()) })}</p>
          </section>

          <div className="ip-actions">
            <button className="ip-btn" onClick={close}>{P.cancel}</button>
            {/* ONE output (2026-07-18): the server composes the complete rapport incl.
                Kroki + Pläne from data. «Einsatz abschliessen» = bookkeeping, secondary. */}
            {onComplete && (
              <button className="ip-btn" onClick={() => void complete()}><Icon id="check" />{A.complete}</button>
            )}
            {printStatus?.available && (
              <button className="ip-btn" disabled={printBusy} onClick={() => startOutput('print')}
                title={printStatus.online ? R.online : R.offline}>
                <span className={`dot print-relay-dot${printStatus.online ? ' online' : ''}`} aria-hidden />
                {printBusy ? R.sending : R.send}
              </button>
            )}
            <button className="ip-btn primary" disabled={pdfBusy} onClick={() => startOutput('pdf')}>
              <Icon id={pdfBusy ? 'rotate' : 'doc'} className={pdfBusy ? 'spin' : undefined} />{pdfBusy ? P.pdfBusy : P.pdfFull}
            </button>
          </div>
        </div>
      </Overlay>

      {framingFor && scene && (
        <KrokiFramingModal
          scene={scene}
          initial={options.krokiView}
          onCancel={() => setFramingFor(null)}
          onConfirm={(v) => {
            patchOpt({ krokiView: v }) // remembered: reopening seeds with this crop
            const action = framingFor
            setFramingFor(null)
            if (action === 'pdf') void downloadPdf(v)
            else void sendToPrinter(v)
          }}
        />
      )}
    </>
  )
}

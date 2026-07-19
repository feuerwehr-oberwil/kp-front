// Station capture view (/e/<token>) — what the Erfassungs-Poster opens. Deliberately NOT
// the field app: no login, no map, no training surface. Two phone-first screens: pick the
// incident (the list carries the fresh ones plus the unreported backlog; a single fresh
// incident skips the picker — autoOpenTarget), then THREE clearly separated
// sections behind collapsed headers — Personen · Material · Allgemein — so nothing hides
// below a long scroll (feedback 2026-07-08). «Wer erfasst?» is deferred (2026-07-18): the
// page opens editable, and the question rides in the modal that fronts Rapport-PDF and
// Ausdrucken — which also makes every print an explicit two-step. Everything writes
// into the same incident workspace the KP tablet syncs (task-scoped merge, second-editor
// semantics). Untrained-operator rails (2026-07-10): the one destructive tap (gegangen →
// frei) gets confirm-with-undo, material lines get ± steppers so a fat-fingered amount is
// fixable in place, saves give toast feedback.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { fillTemplate } from '../lib/format'
import { Icon, IconSprite } from '../lib/icons'
import { Splash } from '../components/Splash'
import { currentLineFor, visibleMittel } from '../lib/mittel'
import { applyTimeToIso } from '../lib/abschluss'
import { Overlays, toast } from '../lib/ui'
import { cancelPrint, capturePrintTransport, enqueuePrint, fetchPrintStatus, type PrintRelayStatus } from '../lib/printRelay'
import type { AttendanceEntry, MittelEntry } from '../types'
import type { ReportMeta } from '../lib/workspace'
import { Combo } from '../components/Combo'
import { TimeField } from '../components/TimeField'
import { fahrzeugRows, gruppenRows, setFahrzeugZeit, setGruppeZeit } from '../lib/alarmzeiten'
import type { IncidentMeta, Workspace } from '../lib/incidents'
import {
  CaptureError, autoOpenTarget, captureApi, isNetworkFailure, onServerTime, saveAction, withTimeout,
  type CaptureAction, type CapturePerson,
} from '../lib/captureClient'
import {
  clearDraft, makeDebouncedFlush, restoreDraft, saveDraft, serverSkewMinutes, type DebouncedFlush,
} from '../lib/captureDraft'

const tokenFromPath = (): string | null => {
  const m = /^\/e\/([A-Za-z0-9_-]{8,})\/?$/.exec(window.location.pathname)
  return m ? m[1] : null
}

// clock for today, date + clock otherwise — the list now carries unreported incidents of
// any age, and «Alarm 14:32» on a row from last Tuesday would read as "today, 14:32"
const fmtWhen = (iso: string): string => {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const clock = d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString()
    ? clock
    : `${d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })} ${clock}`
}

const toTime = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// per-INCIDENT: who records is a fresh question on every Einsatz (a stale name from the
// last emergency must never pre-fill), but a mid-capture reload of the SAME incident may
// restore it — hence sessionStorage keyed by incident id, not a device-wide value.
const RECORDER_KEY = (incidentId: string) => `kp.capture.recorder.${incidentId}`
// cross-visibility poll cadence: only runs while the KP latch is still false (once true it's
// latched for good), and skips hidden tabs — the common case needs zero polls (initial list)
const KP_POLL_MS = 45_000
type Section = 'personen' | 'material' | 'zeiten' | 'angaben'

type MatProbe = { materialId?: string; label: string; unit: string; sourceId?: string; sourceLabel?: string }

// a network hiccup, a real backend verdict, and a broken token read differently under
// stress — only the truly token-shaped failure falls back to the generic «Link ungültig»
const loadErrorMsg = (e: unknown): string => {
  const c = appConfig.copy.capture
  if (e instanceof CaptureError && e.message) return e.message
  if (!(e instanceof CaptureError) && (!navigator.onLine || isNetworkFailure(e))) return c.loadFailedOffline
  return c.invalid
}

function AccHead({ open, label, sub, onToggle }: { open: boolean; label: string; sub: string; onToggle: () => void }) {
  return (
    <button type="button" className={`cv-acc-head${open ? ' on' : ''}`} aria-expanded={open} onClick={onToggle}>
      <span className="cv-acc-label">{label}</span>
      <span className="cv-acc-sub">{sub}</span>
      <Icon id={open ? 'chevron-up' : 'chevron-down'} />
    </button>
  )
}

// Text fields save on blur AND ~1s after typing pauses, plus a sessionStorage draft per
// incident+field (same spirit as RECORDER_KEY) — a phone lock mid-sentence must not lose
// the Kurzbericht. The draft clears once the server accepted the text; a restored draft
// is unsaved by definition (drafts clear on success), so it flushes right after mount.
function DraftField({ incidentId, field, saved, commit, textarea, number, className, placeholder, ariaLabel, autoCapitalize, enterKeyHint }: {
  incidentId: string
  field: string
  /** current server value ('' = unset) */
  saved: string
  /** flush the raw text; resolves true when the server (or a no-op) accepted it */
  commit: (raw: string) => Promise<boolean>
  textarea?: boolean
  number?: boolean
  className: string
  placeholder: string
  ariaLabel: string
  autoCapitalize?: string
  enterKeyHint?: 'done' | 'search'
}) {
  const [text, setText] = useState(() => restoreDraft(sessionStorage, incidentId, field, saved))
  const commitRef = useRef(commit)
  useEffect(() => { commitRef.current = commit }) // the flusher outlives renders — call the fresh closure
  const [flusher] = useState(() => makeDebouncedFlush<string>(1000, async (raw) => {
    if (await commitRef.current(raw)) clearDraft(sessionStorage, incidentId, field)
  }))
  useEffect(() => {
    if (text !== saved) flusher.push(text) // restored draft → persist it
    return () => { void flusher.flushNow() } // unmount (accordion collapse) must not drop text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const onChange = (v: string) => {
    setText(v)
    saveDraft(sessionStorage, incidentId, field, v)
    flusher.push(v)
  }
  const shared = {
    className, placeholder, value: text, 'aria-label': ariaLabel,
    onBlur: () => { void flusher.flushNow() },
  }
  if (textarea) {
    return <textarea {...shared} rows={3} autoCapitalize={autoCapitalize} enterKeyHint={enterKeyHint}
      onChange={(e) => onChange(e.target.value)} />
  }
  return (
    <input {...shared} type={number ? 'number' : 'text'} min={number ? 0 : undefined}
      inputMode={number ? 'numeric' : undefined}
      autoCapitalize={autoCapitalize} autoCorrect="off" autoComplete="off" spellCheck={false}
      enterKeyHint={enterKeyHint} onChange={(e) => onChange(e.target.value)} />
  )
}

export default function CaptureApp() {
  const C = appConfig.copy.capture
  // the shared stylesheet locks body scroll for the map app; this page is a plain
  // scrolling document (long roster/material lists) — unlock for the capture route and
  // pin the bg gradient to the viewport (scrolling past 100vh showed a color seam)
  useEffect(() => {
    document.body.style.overflowY = 'auto'
    document.body.style.backgroundAttachment = 'fixed'
    document.documentElement.style.backgroundAttachment = 'fixed'
  }, [])
  const token = tokenFromPath()
  const [incidents, setIncidents] = useState<IncidentMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [incident, setIncident] = useState<IncidentMeta | null>(null)
  const [roster, setRoster] = useState<CapturePerson[]>([])
  const [recorder, setRecorder] = useState<string>('')
  const [ws, setWs] = useState<Workspace | null>(null)
  const [busy, setBusy] = useState(false)
  // offline vs. server error read differently under stress ("wait for signal" vs "try again");
  // the failed action is kept so the banner's retry button re-runs exactly what was lost
  const [saveError, setSaveError] = useState<null | 'offline' | 'error'>(null)
  const [lastFailed, setLastFailed] = useState<CaptureAction | null>(null)
  // Anwesenheit starts OPEN — the first action on this page is ticking people off, so the
  // page should already show it instead of asking for a decision (first-action cue)
  const [open, setOpen] = useState<Section | null>('personen')
  const [search, setSearch] = useState('')
  const [matSearch, setMatSearch] = useState('')
  // the tap-cycle explanation lives behind an ⓘ toggle — inline it crowded the section
  const [showTapHelp, setShowTapHelp] = useState(false)
  // workspace fetch after picking an Einsatz — splash instead of a frozen picker
  const [opening, setOpening] = useState(false)
  // --cv-head-h mirrors the sticky page header's real height (varies with the KP-aktiv
  // line + safe area) so the open section's own sticky header pins directly underneath
  useEffect(() => {
    if (!incident) return
    const head = document.querySelector<HTMLElement>('.cv-head')
    if (!head) return
    const set = () => document.documentElement.style.setProperty('--cv-head-h', `${head.offsetHeight}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(head)
    return () => ro.disconnect()
  }, [incident])
  // device-vs-server clock skew in minutes (from X-Server-Time), only when > 3min
  const [skewMin, setSkewMin] = useState<number | null>(null)
  // cross-visibility: the KP tablet has opened this incident (editor_opened_at latch) — the
  // full rapport (incl. Lageskizze) will come from there, so printing here is optional
  const [kpActive, setKpActive] = useState(false)
  // opening a section while another (taller) one collapses above can land the new content
  // offscreen — after the layout settles, bring the opened card's top into view
  const sectionRefs = useRef<Partial<Record<Section, HTMLElement | null>>>({})
  const toggleSection = (s: Section) => {
    setOpen((o) => {
      const next = o === s ? null : s
      if (next) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const el = sectionRefs.current[s]
          if (!el) return
          // the sticky header covers the top of the scroll viewport — without a matching
          // scroll margin the opened card's title lands hidden underneath it
          const head = document.querySelector<HTMLElement>('.cv-head')
          el.style.scrollMarginTop = `${(head?.offsetHeight ?? 0) + 8}px`
          el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }))
      }
      return next
    })
  }

  const load = useCallback(async () => {
    if (!token) { setError(appConfig.copy.capture.invalid); return }
    try {
      const [list, people] = await Promise.all([captureApi.incidents(token), captureApi.roster(token)])
      setIncidents(list)
      setRoster(people)
      setError(null)
    } catch (e) {
      setError(loadErrorMsg(e))
    }
  }, [token])
  useEffect(() => { void load() }, [load])

  // clock-skew watch: any /api/capture/* response may carry X-Server-Time — a device clock
  // minutes off silently corrupts every erfasste Zeit, so say it (non-blocking, header
  // absent → silent, graceful before the backend ships it)
  useEffect(() => {
    onServerTime((iso) => {
      const m = serverSkewMinutes(iso, Date.now())
      setSkewMin(m !== null && Math.abs(m) > 3 ? m : null)
    })
    return () => onServerTime(null)
  }, [])

  const openIncident = useCallback(async (i: IncidentMeta) => {
    if (!token) return
    setOpening(true) // splash while the workspace fetches — a tapped row must react at once
    try {
      const { workspace } = await captureApi.workspace(token, i.id)
      setWs(workspace)
      setIncident(i)
      // seed from the list response — the common case (KP already on it) needs zero polls
      setKpActive(i.editor_opened_at != null)
      setOpen('personen') // first action on an Einsatz is ticking people off — show it
      // restore who-records only for THIS incident (reload survival); a different Einsatz
      // starts blank and asks again
      setRecorder(sessionStorage.getItem(RECORDER_KEY(i.id)) ?? '')
    } catch (e) { setError(loadErrorMsg(e)) }
    finally { setOpening(false) }
  }, [token])

  // the overwhelmingly common case is "we just came back from THE incident" — skip the
  // picker screen entirely (one less decision); Zurück still reaches the list. The list
  // may now carry stale unreported backlog rows, so the pick is the single FRESH incident
  // (autoOpenTarget), not simply the single listed one.
  const autoOpened = useRef(false)
  useEffect(() => {
    if (autoOpened.current || incident || !incidents) return
    const target = autoOpenTarget(incidents, Date.now())
    if (!target) return
    autoOpened.current = true
    void openIncident(target)
  }, [incidents, incident, openIncident])

  // freshness poll for the KP latch — ONLY while it's still false (latched forever once
  // true), paused while the tab is hidden; a transient failure just waits for the next tick
  const kpIncidentId = incident?.id
  useEffect(() => {
    if (!token || !kpIncidentId || kpActive) return
    let alive = true
    const check = async () => {
      if (document.hidden) return
      try {
        const { kp_active } = await captureApi.status(token, kpIncidentId)
        if (alive && kp_active) setKpActive(true)
      } catch { /* transient — the next tick retries */ }
    }
    const t = setInterval(() => void check(), KP_POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [token, kpIncidentId, kpActive])

  // every mutation: fresh-read + apply + PUT (409-safe) via saveAction, then mirror locally.
  // Returns the saved blob so callers can toast the ACTUAL saved state, or null on failure.
  const run = async (action: CaptureAction): Promise<Workspace | null> => {
    if (!token || !incident || busy) return null
    setBusy(true)
    setSaveError(null)
    try {
      const { workspace } = await saveAction(token, incident.id, action)
      setWs(workspace)
      setLastFailed(null)
      return workspace
    } catch (e) {
      // a timed-out/aborted request reads like no signal, not like a server fault
      setSaveError(!navigator.onLine || isNetworkFailure(e) ? 'offline' : 'error')
      setLastFailed(action)
      return null
    } finally { setBusy(false) }
  }

  const attendance = (ws?.attendance as Record<string, AttendanceEntry> | undefined) ?? {}
  const mittel = (ws?.mittel as MittelEntry[] | undefined) ?? []
  const rm = (ws?.reportMeta as ReportMeta | undefined)
  const endedAt = rm?.endedAt
  const kontaktperson = rm?.kontaktperson
  const presentCount = Object.values(attendance).filter((a) => a.status === 'present').length

  const savedToast = () => toast(C.savedOk, { icon: 'check', tone: 'success', duration: 1600 })

  const retryLast = async () => {
    if (!lastFailed) return
    if (await run(lastFailed)) savedToast()
  }

  // meta saves from the debounced text fields bypass run()'s global busy gate: a flush
  // must neither drop text nor disable the field mid-typing (per-field ordering comes
  // from each DraftField's chained flusher)
  const flushMeta = async (patch: Partial<ReportMeta>): Promise<boolean> => {
    if (!token || !incident) return false
    try {
      const { workspace } = await saveAction(token, incident.id, { kind: 'setMeta', patch })
      setWs(workspace)
      setSaveError(null)
      return true
    } catch (e) {
      setSaveError(!navigator.onLine || isNetworkFailure(e) ? 'offline' : 'error')
      setLastFailed({ kind: 'setMeta', patch })
      return false
    }
  }

  // attendance tap: frei → anwesend → gegangen are visibly reflected on the row itself; the
  // third tap DELETES the entry incl. its recorded times — that one gets confirm-with-undo
  const tapPerson = async (p: CapturePerson) => {
    if (!incident) return
    const prev = attendance[p.id]
    // «von» = Alarmzeit (Vorschlag ab Alarmzeit) — retro ticking at the magazine must
    // not stamp everyone's arrival with the tap moment near the incident's end
    const saved = await run({ kind: 'cycleAttendance', personId: p.id, name: p.display_name, vonIso: incident.started_at })
    if (!saved) return
    if (prev?.status === 'left') {
      toast(fillTemplate(C.removedEntry, { name: p.display_name }), {
        icon: 'warn',
        action: {
          label: C.undo,
          onClick: () => {
            void run({ kind: 'restoreAttendance', personId: p.id, entry: prev }).then((ok) => { if (ok) savedToast() })
          },
        },
      })
    }
  }

  const catalogue = getDeploymentConfig().mittel?.catalogue ?? appConfig.mittel.catalogue
  const lines = useMemo(() => visibleMittel(mittel), [mittel])
  // catalogue for the picker: grouped by category, alphabetical inside — config order is
  // load-out order, which reads as random in a dropdown
  const catalogueGroups = useMemo(() => {
    const sorted = [...catalogue].sort((a, b) => a.label.localeCompare(b.label, 'de-CH'))
    const by = new Map<string, typeof sorted>()
    for (const c of sorted) {
      const k = c.category ?? ''
      const arr = by.get(k) ?? []
      arr.push(c)
      by.set(k, arr)
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b, 'de-CH'))
  }, [catalogue])
  // catalogue search mirrors the Personen filter — filters across groups by label
  const shownGroups = useMemo(() => {
    const q = matSearch.trim().toLowerCase()
    if (!q) return catalogueGroups
    return catalogueGroups
      .map(([cat, items]) => [cat, items.filter((i) => i.label.toLowerCase().includes(q))] as const)
      .filter(([, items]) => items.length > 0)
  }, [catalogueGroups, matSearch])
  const filteredRoster = useMemo(
    () => roster.filter((p) => p.display_name.toLowerCase().includes(search.toLowerCase())),
    [roster, search],
  )

  // --- material: the WHOLE catalogue as a stepper list (no picker — recognition over
  // recall; a 0 next to every item is faster and safer than a dropdown for the untrained
  // operator). ± on any row; going back to 0 tombstones with undo. Non-catalogue lines
  // (custom/tablet-sourced) append below so nothing recorded is ever hidden.
  // Steppers are OPTIMISTIC (2026-07-18): the count moves with the tap, the network flush
  // debounces ~600ms per line (chained, never concurrent per line), and a failed flush
  // reconciles the display back to the server value via the retry banner.
  const [matPending, setMatPending] = useState<Record<string, number>>({})
  const matFlushers = useRef(new Map<string, DebouncedFlush<{ probe: MatProbe; menge: number }>>())
  const flushMittel = async (key: string, probe: MatProbe, menge: number): Promise<boolean> => {
    if (!token || !incident) return false
    const base = { kind: 'setMittel' as const, ...probe, by: recorder }
    const prev = currentLineFor(mittel, { ...probe })?.menge ?? 0
    try {
      const { workspace } = await saveAction(token, incident.id, { ...base, menge })
      setWs(workspace)
      setSaveError(null)
      setMatPending((p) => {
        if (p[key] !== menge) return p // newer taps queued — keep the optimistic count
        const rest = { ...p }; delete rest[key]; return rest
      })
      if (menge === 0 && prev > 0) {
        toast(fillTemplate(C.mittelRemoved, { label: probe.label }), {
          icon: 'warn',
          action: { label: C.undo, onClick: () => { void run({ ...base, menge: prev }).then((ok) => { if (ok) savedToast() }) } },
        })
      } else if (menge !== prev) {
        toast(fillTemplate(C.mittelSet, { label: probe.label, n: menge, unit: probe.unit }), { icon: 'check', tone: 'success', duration: 1600 })
      }
      return true
    } catch (e) {
      setSaveError(!navigator.onLine || isNetworkFailure(e) ? 'offline' : 'error')
      setLastFailed({ ...base, menge })
      setMatPending((p) => { const rest = { ...p }; delete rest[key]; return rest }) // reconcile to server truth
      return false
    }
  }
  const flushMittelRef = useRef(flushMittel)
  useEffect(() => { flushMittelRef.current = flushMittel }) // flushers outlive renders — call the fresh closure
  const stepMittel = (key: string, probe: MatProbe, displayed: number, delta: number) => {
    const next = Math.max(0, displayed + delta)
    if (next === displayed) return
    setMatPending((p) => ({ ...p, [key]: next }))
    let f = matFlushers.current.get(key)
    if (!f) {
      f = makeDebouncedFlush(600, (v: { probe: MatProbe; menge: number }) => flushMittelRef.current(key, v.probe, v.menge))
      matFlushers.current.set(key, f)
    }
    f.push({ probe, menge: next })
  }
  // a different incident starts from ITS server counts — drop optimistic leftovers
  // (cancel, not flush: a late flush would write into the NEWLY opened incident)
  const incidentId = incident?.id
  useEffect(() => {
    const flushers = matFlushers.current
    return () => {
      flushers.forEach((f) => f.cancel())
      flushers.clear()
      setMatPending({})
      setMatSearch('')
    }
  }, [incidentId])
  // recorded lines that are NOT a plain catalogue row (sourced from the tablet, or free labels)
  const extraLines = useMemo(() => {
    const ids = new Set(catalogue.map((c) => c.id))
    return lines.filter((l) => l.sourceId || l.sourceLabel || !l.materialId || !ids.has(l.materialId))
  }, [lines, catalogue])

  // data-only Rapport-PDF straight from the capture view: with no power user there was no
  // Kroki/plan anyway, so the direct PDF (personal/material/journal/meta) IS the rapport.
  // The heavy composer chunk loads on demand.
  const [pdfBusy, setPdfBusy] = useState(false)
  // printing NEVER blocks (form model 2026-07-17): whatever is still empty prints as a
  // labeled write-in field. The hint just says so, as a nudge, not a gate.
  const pdfMissing = [
    !endedAt ? C.ende : null,
    Object.values(attendance).length === 0 ? C.sectionPersonen : null,
    !rm?.summary?.trim() ? C.kurzberichtHead : null,
  ].filter((x): x is Exclude<typeof x, null> => !!x)
  const printRapport = async () => {
    if (!token || !incident || pdfBusy) return
    setPdfBusy(true)
    try {
      const [{ downloadDirectReportPdf }, { defaultReportOptions }] = await Promise.all([
        import('../lib/reportPdfDirect'), import('../lib/report'),
      ])
      let events: import('../types').TimelineEvent[] = []
      try { events = (await captureApi.journal(token, incident.id)).entries.map((e) => e.row) } catch { /* PDF without Verlauf beats no PDF */ }
      // the render fetch lives in reportPdfDirect — race it so a stall clears pdfBusy
      // into the toast instead of freezing the button (server render may take a while: 30s)
      await withTimeout(downloadDirectReportPdf({
        incident,
        draft: {
          meta: { ...rm, alarmiertAt: rm?.alarmiertAt ?? incident.started_at },
          generatedAt: new Date().toISOString(),
          proof: { intact: null, checkedAt: new Date().toISOString(), offline: true },
          options: { ...defaultReportOptions, kroki: false, annotatedPlans: false, allPlans: false, atemschutz: false },
        },
        trupps: [], attendance, events, plans: [], mittel,
        roster: roster.map((p) => ({ id: p.id, name: p.display_name })),
        // no kiosk cookie on this surface — the poster token authenticates the composer
        transport: { url: `/api/capture/incidents/${incident.id}/report/pdf`, headers: { 'X-Capture-Token': token } },
      }), 30_000)
    } catch { toast(C.pdfFailed, { icon: 'warn', tone: 'warn' }) } finally { setPdfBusy(false) }
  }

  // Station print relay: the same rapport straight onto the station printer — the phone
  // needs no printer setup. Hidden unless the deployment runs a relay (fail-closed).
  const R = appConfig.copy.printRelay
  const [printStatus, setPrintStatus] = useState<PrintRelayStatus | null>(null)
  const [printBusy, setPrintBusy] = useState(false)
  useEffect(() => {
    if (!token || !incident) { setPrintStatus(null); return }
    let alive = true
    void fetchPrintStatus(capturePrintTransport(token)).then((s) => { if (alive) setPrintStatus(s) })
    return () => { alive = false }
  }, [token, incident])
  // «Wer erfasst?» is asked HERE, not up front (decided 2026-07-18): the page opens
  // editable, and the question rides in the modal that fronts PDF + Ausdrucken — which
  // also makes every print an explicit two-step, so no accidental paper.
  const [askWho, setAskWho] = useState<null | 'pdf' | 'print'>(null)
  const [whoDraft, setWhoDraft] = useState('')
  const openWho = (what: 'pdf' | 'print') => { setWhoDraft(recorder); setAskWho(what) }
  // the page is a scrolling document (mount effect above) — freeze it behind the modal,
  // compensating the vanished scrollbar's width so the layout doesn't shift (desktop)
  useEffect(() => {
    const sw = window.innerWidth - document.documentElement.clientWidth
    document.body.style.overflowY = askWho ? 'hidden' : 'auto'
    document.body.style.paddingRight = askWho && sw > 0 ? `${sw}px` : ''
    return () => { document.body.style.overflowY = 'auto'; document.body.style.paddingRight = '' }
  }, [askWho])
  const commitRecorder = (v: string) => {
    if (!incident) return
    sessionStorage.setItem(RECORDER_KEY(incident.id), v)
    setRecorder(v)
    // the Erfasser belongs on the record: collect every distinct recorder into
    // reportMeta.erfasser (shows on the Rapport-PDF facts)
    const cur = (rm?.erfasser ?? '').split(', ').filter(Boolean)
    if (v && !cur.includes(v)) {
      void saveAction(token!, incident.id, { kind: 'setMeta', patch: { erfasser: [...cur, v].join(', ') } })
        .then(({ workspace }) => setWs(workspace)).catch(() => {})
    }
  }
  const confirmWho = () => {
    const what = askWho
    if (!what || !whoDraft) return
    commitRecorder(whoDraft)
    setAskWho(null)
    if (what === 'pdf') void printRapport()
    else void sendToPrinter()
  }

  const sendToPrinter = async () => {
    if (!token || !incident || printBusy) return
    setPrintBusy(true)
    try {
      const [{ buildDirectReportPayload }, { defaultReportOptions }] = await Promise.all([
        import('../lib/reportPdfDirect'), import('../lib/report'),
      ])
      let events: import('../types').TimelineEvent[] = []
      try { events = (await captureApi.journal(token, incident.id)).entries.map((e) => e.row) } catch { /* PDF without Verlauf beats no PDF */ }
      const payload = buildDirectReportPayload({
        incident,
        draft: {
          meta: { ...rm, alarmiertAt: rm?.alarmiertAt ?? incident.started_at },
          generatedAt: new Date().toISOString(),
          proof: { intact: null, checkedAt: new Date().toISOString(), offline: true },
          options: { ...defaultReportOptions, kroki: false, annotatedPlans: false, allPlans: false, atemschutz: false },
        },
        trupps: [], attendance, events, plans: [], mittel,
        roster: roster.map((p) => ({ id: p.id, name: p.display_name })),
      })
      const t = capturePrintTransport(token)
      // stalled enqueue must clear printBusy into the failed-toast, never freeze the button
      const jobId = await withTimeout(enqueuePrint(t, incident.id, payload), 15_000)
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
    } catch { toast(R.failed, { icon: 'warn', tone: 'warn' }) } finally { setPrintBusy(false) }
  }

  // Zeiten grid (Gruppen/Fahrzeuge) — same rows as the EL's Rapport form, prefilled by
  // the milestone webhook; a capture edit stamps `manual` (human beats machine)
  const rankOf = (name: string) => roster.find((p) => p.display_name === name)?.rank ?? undefined

  const gruppenCfg = getDeploymentConfig().alarms?.groups ?? []
  const fahrzeugeCfg = getDeploymentConfig().fleet?.vehicles ?? []
  const onGruppeZeit = (id: string, hhmm: string | null) => {
    const iso = hhmm ? applyTimeToIso(incident?.started_at ?? new Date().toISOString(), hhmm) : null
    const next = setGruppeZeit(rm?.gruppen, id, iso)
    void run({ kind: 'setMeta', patch: { gruppen: next.length ? next : undefined } }).then((ok) => { if (ok) savedToast() })
  }
  const onFahrzeugZeit = (id: string, hhmm: string | null) => {
    const iso = hhmm ? applyTimeToIso(incident?.started_at ?? new Date().toISOString(), hhmm) : null
    const next = setFahrzeugZeit(rm?.fahrzeuge, id, 'ausgerueckt', iso)
    void run({ kind: 'setMeta', patch: { fahrzeuge: next.length ? next : undefined } }).then((ok) => { if (ok) savedToast() })
  }

  // shown on both screens right under the header — wrong device time corrupts every
  // erfasste Zeit, so warn (non-blocking) while everything keeps working
  const skewLine = skewMin !== null ? (
    <p className="cv-skew" role="status">
      <Icon id="warn" /> {fillTemplate(C.clockSkew, { n: Math.abs(skewMin) })}
    </p>
  ) : null

  if (error) {
    return (
      <div className="cv-shell"><IconSprite /><div className="cv-card cv-center">
        <Icon id="warn" /><p>{error}</p>
        <button type="button" className="cv-btn" onClick={() => { setError(null); void load() }}>{C.retry}</button>
      </div></div>
    )
  }
  // data still loading (incidents + roster): keep the SAME branded splash the chunk load
  // shows, so scan → chunk → data reads as one continuous boot, never an empty shell
  if (incidents === null || opening) return <Splash />

  // --- screen 1: incident picker ---
  if (!incident) {
    return (
      <div className="cv-shell"><IconSprite />
        <header className="cv-head"><h1>{C.title}</h1></header>
        {skewLine}
        {incidents.length === 0 && (
          <div className="cv-card cv-center">
            <p>{C.noIncidents}</p>
            <p className="cv-hint">{C.noIncidentsHint}</p>
          </div>
        )}
        <div className="cv-list">
          {incidents.map((i) => (
            <button key={i.id} className="cv-item" onClick={() => void openIncident(i)}>
              <span className="cv-item-main">
                <span className="cv-item-title">{i.title}</span>
                <span className="cv-item-sub">{i.address ?? ''} · {fmtWhen(i.started_at)}</span>
              </span>
              <Icon id="chevron" />
            </button>
          ))}
        </div>
      </div>
    )
  }

  // --- screen 2: the capture sections (Personen · Material · Zeiten · Angaben) ---
  return (
    <div className="cv-shell"><IconSprite /><Overlays />
      <header className="cv-head">
        <button className="cv-back" onClick={() => setIncident(null)} aria-label={C.back}><Icon id="chevron" /></button>
        <div className="cv-head-main">
          <h1>{incident.title}</h1>
          <p>{incident.address ?? ''} · {fillTemplate(C.alarmedAt, { t: fmtWhen(incident.started_at) })}</p>
          {/* reassurance, not an alarm: the KP tablet has this incident — the full rapport
              (incl. Lageskizze) comes from there */}
          {kpActive && (
            <p className="cv-kp-live" role="status"><span className="cv-kp-dot" aria-hidden /> {C.kpActive}</p>
          )}
        </div>
      </header>

      {skewLine}
      {/* the autosave reassurance sits at the TOP (moved from the footer 2026-07-18):
          first-time operators looked for a save button before daring to tap anything */}
      <p className="cv-hint">{C.footNote}</p>

      {saveError && (
        <div className="cv-error" role="alert">
          <Icon id="warn" />
          <span className="cv-error-text">{saveError === 'offline' ? C.saveFailedOffline : C.saveFailed}</span>
          {lastFailed && <button type="button" className="cv-btn cv-retry" disabled={busy} onClick={() => void retryLast()}>{C.retry}</button>}
        </div>
      )}

      <div className="cv-acc">
        <section className="cv-card cv-acc-card" ref={(el) => { sectionRefs.current.personen = el }}>
          <AccHead open={open === 'personen'} label={C.sectionPersonen} sub={fillTemplate(C.presentCount, { n: presentCount })} onToggle={() => toggleSection('personen')} />
          {open === 'personen' && (
            <div className="cv-acc-body">
              <div className="cv-search-row">
                <input className="cv-input" placeholder={C.searchName} value={search} onChange={(e) => setSearch(e.target.value)}
                  autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint="search" />
                <button type="button" className={`cv-info${showTapHelp ? ' on' : ''}`} aria-label={C.tapHelp}
                  aria-expanded={showTapHelp} onClick={() => setShowTapHelp((v) => !v)}><Icon id="info" /></button>
              </div>
              {showTapHelp && <p className="cv-hint">{C.tapHint}</p>}
              <div className="cv-people">
                {filteredRoster.map((p) => {
                  const a = attendance[p.id]
                  const state = a?.status === 'present' ? 'on' : a?.status === 'left' ? 'left' : ''
                  const vonBase = a?.checkedInAt ?? incident.started_at
                  return (
                    <div key={p.id} className="cv-person-row">
                      <button className={`cv-person ${state}`} disabled={busy}
                        onClick={() => void tapPerson(p)}>
                        <span className="cv-person-name">{p.display_name}</span>
                        {/* state as a glyph chip (✓ / exit-arrow) — the word lives on as the
                            aria-label and in the ⓘ help; the von/bis tag disambiguates */}
                        {a && (
                          <span className="cv-person-state" role="img"
                            aria-label={a.status === 'left' ? C.stateLeft : C.statePresent}>
                            <Icon id={a.status === 'left' ? 'arrow' : 'check'} />
                          </span>
                        )}
                      </button>
                      {/* ONE inline time, same model as the Anwesenheit view: arrival while
                          anwesend, leave time once gegangen — the flipping meaning is SAID
                          with a von/bis tag, not implied (feedback 2026-07-18) */}
                      {a && <span className="cv-time-tag">{a.status === 'left' ? C.bis : C.von}</span>}
                      {a && (
                        <TimeField
                          className="cv-person-time"
                          ariaLabel={a.status === 'left' ? C.bis : C.von}
                          value={toTime(a.status === 'left' ? a.leftAt : a.checkedInAt)}
                          disabled={busy}
                          onCommit={(hhmm) => {
                            if (!hhmm) return
                            if (a.status === 'left') {
                              const iso = applyTimeToIso(a.leftAt ?? vonBase, hhmm, { nextDayIfBefore: a.checkedInAt ?? undefined })
                              if (iso) void run({ kind: 'setTimes', personId: p.id, leftAt: iso }).then((ok) => { if (ok) savedToast() })
                            } else {
                              const iso = applyTimeToIso(vonBase, hhmm)
                              if (iso) void run({ kind: 'setTimes', personId: p.id, checkedInAt: iso }).then((ok) => { if (ok) savedToast() })
                            }
                          }}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </section>

        <section className="cv-card cv-acc-card" ref={(el) => { sectionRefs.current.material = el }}>
          <AccHead open={open === 'material'} label={C.sectionMaterial} sub={fillTemplate(C.mittelCount, { n: lines.length })} onToggle={() => toggleSection('material')} />
          {open === 'material' && (
            <div className="cv-acc-body">
              <input className="cv-input" placeholder={C.searchMaterial} value={matSearch} onChange={(e) => setMatSearch(e.target.value)}
                autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint="search" />
              {shownGroups.map(([cat, items]) => (
                <div key={cat || '_'} className="cv-matgroup">
                  {cat && <div className="cv-matgroup-head">{cat}</div>}
                  <ul className="cv-mittel">
                    {items.map((item) => {
                      const key = `mat:${item.id}`
                      const probe = { materialId: item.id, label: item.label, unit: item.unit || 'Stk' }
                      const serverCur = currentLineFor(mittel, { ...probe, sourceId: undefined, sourceLabel: undefined })?.menge ?? 0
                      const cur = matPending[key] ?? serverCur
                      return (
                        <li key={item.id} className={cur > 0 ? 'used' : ''}>
                          <span className="cv-mittel-label">{item.label}</span>
                          <span className="cv-step">
                            <button type="button" className="cv-stepbtn" aria-label={C.stepLess} disabled={cur === 0} onClick={() => stepMittel(key, probe, cur, -1)}><Icon id="minus" /></button>
                            <b>{cur} {probe.unit}</b>
                            <button type="button" className="cv-stepbtn" aria-label={C.stepMore} onClick={() => stepMittel(key, probe, cur, 1)}><Icon id="plus" /></button>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
              {extraLines.length > 0 && (
                <div className="cv-matgroup">
                  <div className="cv-matgroup-head">{C.mittelExtra}</div>
                  <ul className="cv-mittel">
                    {extraLines.map((l) => {
                      const probe = { materialId: l.materialId, label: l.label, unit: l.unit, sourceId: l.sourceId, sourceLabel: l.sourceLabel }
                      const cur = matPending[l.key] ?? l.menge
                      return (
                        <li key={l.key} className="used">
                          <span className="cv-mittel-label">{l.label}{l.sourceLabel ? ` · ${l.sourceLabel}` : ''}</span>
                          <span className="cv-step">
                            <button type="button" className="cv-stepbtn" aria-label={C.stepLess} disabled={cur === 0} onClick={() => stepMittel(l.key, probe, cur, -1)}><Icon id="minus" /></button>
                            <b>{cur} {l.unit}</b>
                            <button type="button" className="cv-stepbtn" aria-label={C.stepMore} onClick={() => stepMittel(l.key, probe, cur, 1)}><Icon id="plus" /></button>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="cv-card cv-acc-card" ref={(el) => { sectionRefs.current.zeiten = el }}>
          <AccHead open={open === 'zeiten'} label={C.sectionZeiten} sub={fillTemplate(C.zeitenFilled, { n: (rm?.gruppen ?? []).filter((g) => g.alarmedAt).length + (rm?.fahrzeuge ?? []).filter((f) => f.ausgerueckt).length })} onToggle={() => toggleSection('zeiten')} />
          {open === 'zeiten' && (
            <div className="cv-acc-body">
              {gruppenRows(gruppenCfg, rm?.gruppen).length > 0 && (
                <>
                  <div className="cv-subhead">{C.gruppenHead}</div>
                  <div className="cv-zgrid">
                    {gruppenRows(gruppenCfg, rm?.gruppen).map(({ config: c, value: v }) => (
                      <span key={c.id} className="cv-zrow">
                        <span className="cv-zname">{c.label}{c.color ? ` (${c.color})` : ''}</span>
                        <TimeField ariaLabel={c.label} value={toTime(v?.alarmedAt)} disabled={busy}
                          onCommit={(hhmm) => onGruppeZeit(c.id, hhmm)} />
                      </span>
                    ))}
                  </div>
                </>
              )}
              {fahrzeugRows(fahrzeugeCfg, rm?.fahrzeuge).length > 0 && (
                <>
                  <div className="cv-subhead">{C.fahrzeugeHead}</div>
                  <div className="cv-zgrid">
                    {fahrzeugRows(fahrzeugeCfg, rm?.fahrzeuge).map(({ config: c, value: v }) => (
                      <span key={c.id} className="cv-zrow">
                        <span className="cv-zname">{c.label}</span>
                        <TimeField ariaLabel={c.label} value={toTime(v?.ausgerueckt)} disabled={busy}
                          onCommit={(hhmm) => onFahrzeugZeit(c.id, hhmm)} />
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        <section className="cv-card cv-acc-card" ref={(el) => { sectionRefs.current.angaben = el }}>
          <AccHead open={open === 'angaben'} label={C.sectionAngaben} sub={rm?.einsatzleiter ?? '—'} onToggle={() => toggleSection('angaben')} />
          {open === 'angaben' && (
            <div className="cv-acc-body">
              <div className="cv-row">
                <span>{C.einsatzleiter}</span>
                <div className="cv-rueck-name">
                  <Combo
                    value={rm?.einsatzleiter ?? ''}
                    options={roster.map((p) => p.display_name)}
                    placeholder={C.rueckName}
                    allowCustom
                    officerFilter
                    rankOf={rankOf}
                    onChange={(v) => { void run({ kind: 'setMeta', patch: { einsatzleiter: v || undefined } }).then((ok) => { if (ok) savedToast() }) }}
                  />
                </div>
              </div>
              <div className="cv-row">
                <span>{C.kontaktperson}</span>
                <DraftField key={`${incident.id}:kontaktperson`} incidentId={incident.id} field="kontaktperson"
                  saved={kontaktperson ?? ''} className="cv-input" placeholder={C.kontaktpersonPlaceholder}
                  ariaLabel={C.kontaktperson} autoCapitalize="words" enterKeyHint="done"
                  commit={async (raw) => {
                    const v = raw.trim()
                    if (v === (kontaktperson ?? '')) return true
                    const ok = await flushMeta({ kontaktperson: v })
                    if (ok) savedToast()
                    return ok
                  }} />
              </div>
              <div className="cv-row">
                <span>{C.gerettete}</span>
                <div className="cv-row-controls">
                  <DraftField key={`${incident.id}:gerettetePersonen`} incidentId={incident.id} field="gerettetePersonen"
                    number saved={rm?.gerettete?.personen !== undefined ? String(rm.gerettete.personen) : ''}
                    className="cv-input cv-count" placeholder={C.gerettetePersonen} ariaLabel={C.gerettetePersonen}
                    commit={async (raw) => {
                      const n = raw.trim() === '' ? undefined : Math.max(0, Math.round(Number(raw) || 0))
                      if (n === rm?.gerettete?.personen) return true
                      const ok = await flushMeta({ gerettete: { ...rm?.gerettete, personen: n } })
                      if (ok) savedToast()
                      return ok
                    }} />
                  <DraftField key={`${incident.id}:geretteteTiere`} incidentId={incident.id} field="geretteteTiere"
                    number saved={rm?.gerettete?.tiere !== undefined ? String(rm.gerettete.tiere) : ''}
                    className="cv-input cv-count" placeholder={C.geretteteTiere} ariaLabel={C.geretteteTiere}
                    commit={async (raw) => {
                      const n = raw.trim() === '' ? undefined : Math.max(0, Math.round(Number(raw) || 0))
                      if (n === rm?.gerettete?.tiere) return true
                      const ok = await flushMeta({ gerettete: { ...rm?.gerettete, tiere: n } })
                      if (ok) savedToast()
                      return ok
                    }} />
                </div>
              </div>
              {/* Kurzbericht lives HERE (moved from its own Bericht section 2026-07-18 —
                  one section fewer; Bemerkungen dropped: it only duplicated confusion) */}
              <div className="cv-row top">
                <span>{C.kurzberichtHead}</span>
                <DraftField key={`${incident.id}:summary`} incidentId={incident.id} field="summary"
                  textarea saved={rm?.summary ?? ''} className="cv-input cv-textarea" placeholder={C.kurzberichtPlaceholder}
                  ariaLabel={C.kurzberichtHead} autoCapitalize="sentences"
                  commit={async (raw) => {
                    const v = raw.trim()
                    if (v === (rm?.summary ?? '')) return true
                    const ok = await flushMeta({ summary: v || undefined })
                    if (ok) savedToast()
                    return ok
                  }} />
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Abschluss: Einsatzende + Rückmeldung ELZ live right before the PDF — they are
          the LAST actions of an Einsatz, not something to hunt for inside a section */}
      <section className="cv-card cv-abschluss">
        <div className="cv-matgroup-head">{C.abschlussHead}</div>
              <div className="cv-row">
                <span>{C.ende}</span>
                <TimeField ariaLabel={C.ende} value={toTime(endedAt)} disabled={busy}
                  onCommit={(hhmm) => {
                    const iso = hhmm ? applyTimeToIso(endedAt ?? incident.started_at, hhmm, { nextDayIfBefore: incident.started_at }) : null
                    if (iso) void run({ kind: 'setMeta', patch: { endedAt: iso } }).then((ok) => { if (ok) savedToast() })
                  }} />
              </div>
              <div className="cv-row">
                <span>{C.rueckmeldung}</span>
                <div className="cv-row-controls">
                  <div className="cv-rueck-name">
                    <Combo
                      value={rm?.rueckmeldungElz?.name ?? ''}
                      options={roster.map((p) => p.display_name)}
                      placeholder={C.rueckName}
                      allowCustom
                      officerFilter
                      rankOf={rankOf}
                      onChange={(v) => { void run({ kind: 'setMeta', patch: { rueckmeldungElz: { ...rm?.rueckmeldungElz, name: v || undefined } } }).then((ok) => { if (ok) savedToast() }) }}
                    />
                  </div>
                  <TimeField ariaLabel={C.rueckZeit} value={toTime(rm?.rueckmeldungElz?.at)} disabled={busy}
                    onCommit={(hhmm) => {
                      const iso = hhmm ? applyTimeToIso(rm?.rueckmeldungElz?.at ?? incident.started_at, hhmm, { nextDayIfBefore: incident.started_at }) : null
                      if (iso) void run({ kind: 'setMeta', patch: { rueckmeldungElz: { ...rm?.rueckmeldungElz, at: iso } } }).then((ok) => { if (ok) savedToast() })
                    }} />
                </div>
              </div>
      </section>

      <div className="cv-pdfbar">
        {/* KP active → the buttons step back to quiet secondary styling (never hidden or
            disabled — a phone print must stay possible, it's just no longer the main path) */}
        <button className={`cv-btn cv-pdf${kpActive ? ' cv-quiet' : ''}`} disabled={busy || pdfBusy} onClick={() => openWho('pdf')}>
          <Icon id="doc" /> {pdfBusy ? R.sending : C.rapportPdf}
        </button>
        {printStatus?.available && (
          <button className={`cv-btn${kpActive ? ' cv-quiet' : ''}`} disabled={busy || printBusy} onClick={() => openWho('print')}
            title={printStatus.online ? R.online : R.offline}>
            <span className={`dot print-relay-dot${printStatus.online ? ' online' : ''}`} aria-hidden />
            {printBusy ? R.sending : R.send}
          </button>
        )}
        {pdfMissing.length > 0 && (
          <span className="cv-hint">{fillTemplate(C.pdfMissing, { fields: pdfMissing.join(', ') })}</span>
        )}
      </div>

      {/* «Wer erfasst?» + confirm in ONE modal — fronts both outputs, so a stray tap on
          Ausdrucken can never reach the printer, and the Erfasser lands on the record */}
      {askWho && (
        <div className="cv-modal-ovl" onClick={() => setAskWho(null)}>
          <div className="cv-card cv-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>{askWho === 'print' ? R.confirmTitle : C.rapportPdf}</h2>
            {/* the KP-aktiv notice lives HERE, at the print/PDF decision — not in the bar */}
            {kpActive && (
              <p className="cv-modal-kp"><span className="cv-kp-dot" aria-hidden /> {C.kpActiveHint}</p>
            )}
            <div className="cv-modal-who">
              <span>{C.whoTitle}</span>
              <Combo
                value={whoDraft}
                options={roster.map((p) => p.display_name)}
                placeholder={C.selectPerson}
                clearable={false}
                onChange={setWhoDraft}
              />
            </div>
            <p className="cv-hint">{C.whoHint}</p>
            {/* the title + Ausdrucken button ARE the confirmation — no filler sentence;
                only the offline store-and-forward warning earns a line */}
            {askWho === 'print' && !printStatus?.online && (
              <p className="cv-hint cv-modal-warn"><Icon id="warn" /> {R.offlineConfirmMsg}</p>
            )}
            <div className="cv-modal-actions">
              <button className="cv-btn" onClick={() => setAskWho(null)}>{C.cancel}</button>
              <button className="cv-btn cv-primary" disabled={!whoDraft} onClick={confirmWho}>
                {askWho === 'print'
                  ? (printStatus?.online ? R.confirmBtn : R.offlineConfirmBtn)
                  : C.rapportPdf}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

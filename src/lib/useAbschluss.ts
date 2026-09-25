import { useCallback, useMemo } from 'react'
import { appConfig } from '../config/appConfig'
import type { AttendanceState, MittelEntry, Trupp } from '../types'
import { isIncidentRunning, type IncidentMeta } from './api/incidents'
import type { ReportMeta } from './workspace'
import type { MediaQueueApi } from './useMediaQueue'
import { missingSteps, type AbschlussStep } from './abschluss'
import { abschlussOpenItems, abschlussOpenPoints, countsAsOpen } from './abschlussOpen'
import { truppStillDeployed } from './atemschutz'
import { mittelLineCount } from './mittel'
import { confirmDialog } from './ui'

interface Args {
  reportMeta: ReportMeta
  attendance: AttendanceState
  mittel: MittelEntry[]
  /** the board's Trupps (removed ones already filtered out) */
  trupps: Trupp[]
  incidentMeta: Pick<IncidentMeta, 'is_archived' | 'status' | 'closed_at'>
  replayActive: boolean
  media: MediaQueueApi
  /** App's handover: stamp report_done_at + close. TRUE only when the close really happened. */
  onCompleteRapport: () => Promise<boolean>
  /** the confirm's rows are links — to the Rapport step, the Trupps, the offline media sheet */
  setMode: (mode: 'rapport' | 'atemschutz') => void
  setPanel: (panel: null) => void
  setOfflineReadyOpen: (open: boolean) => void
  /** open the Rapport ON one Mindestangabe (IncidentWorkspace · requestReportStep, a stable
   *  module-level loader of the lazy ReportPreflight chunk) */
  requestReportStep: (step: AbschlussStep) => void
}

/**
 * The ONE «Einsatz abschliessen» (IncidentWorkspace, lifted out 23.09.2026): what is still open
 * (the Mindestangaben, the Trupps nobody reported out, the media still on this device), the
 * moment the Atemschutz clocks freeze at, whether the Atemschutz alarm still runs — and the one
 * confirm both doors (the Rapport and the Einsatz-Menü row) go through before the handover.
 *
 * Moved verbatim, memo and callback deps included (the one addition is the stable
 * `requestReportStep`, which used to be read off module scope), and called where the block
 * used to stand, so the hook order and every identity downstream are unchanged.
 */
export function useAbschluss({
  reportMeta, attendance, mittel, trupps, incidentMeta, replayActive, media, onCompleteRapport,
  setMode, setPanel, setOfflineReadyOpen, requestReportStep,
}: Args) {
  const abschlussMissing = useMemo(
    () => missingSteps({ reportMeta, attendanceCount: Object.keys(attendance).length, mittelCount: mittelLineCount(mittel) }),
    [reportMeta, attendance, mittel],
  )
  /** How many Trupps are still recorded as being out there (lib/atemschutz · truppStillDeployed).
   *  NOT an ABSCHLUSS_STEP: those are the Rapport's Mindestangaben, and this is a state of the
   *  Einsatz rather than an empty field — it rides beside them in the confirm, the way pending
   *  media does. */
  const truppsStillOut = useMemo(() => trupps.filter(truppStillDeployed).length, [trupps])
  /** The moment every Trupp clock is read against once the Einsatz is abgeschlossen — after that
   *  no more time passes on this Einsatz, and a board that kept counting was describing a
   *  situation that had ended (see AtemschutzView · `frozenAt`).
   *
   *  ⚠️ The EINSATZENDE, not `closed_at`: the record is often closed the morning after, and
   *  freezing on that would have counted the night as Einsatzzeit — the very number this fixes.
   *  `closed_at` is the fallback for an Einsatz archived without one ever being entered. */
  // ⚠️ «closed» is `isIncidentRunning`, the backend's `is_open` — and it flips LIVE when another
  // device closes the Einsatz (N3, 25.09.2026): the clocks freeze and the alarm stops on every
  // device, not only on the one that pressed «Abschliessen».
  const running = isIncidentRunning(incidentMeta)
  const azFrozenAt = useMemo(() => {
    if (running) return undefined
    const at = Date.parse(reportMeta.endedAt ?? incidentMeta.closed_at ?? '')
    return Number.isFinite(at) ? at : undefined
  }, [running, incidentMeta.closed_at, reportMeta.endedAt])
  /* ⚠️ …and the ALARM stops with the clocks. It is not a display: it plays a tone and posts an OS
     notification, and it ran off the live clock regardless of the Einsatz's state — so opening a
     closed Akte with a Trupp that was never reported out started an überfällig alarm about a
     crew that went home hours ago. `active: false` stops the tone and reports a silent state, so
     the TopBar chip and the NavRail dot go quiet with it. Replay was already excluded for the
     same reason: a read-only past does not alarm. */
  const azMonitoring = !replayActive && running
  /** Resolves TRUE when the Einsatz was actually handed over for closing — the Rapport uses that
   *  to decide whether to forget its scroll position, and a cancelled confirm must not. */
  const confirmAndComplete = useCallback(async (): Promise<boolean> => {
    const A = appConfig.copy.abschluss
    const P = appConfig.copy.preflight
    // ⚠️ Pending media belongs in this list. The Abschluss closes the incident, and a Foto or a
    // Sprachnotiz that never got a connection is still sitting on THIS device — the operator is
    // about to walk away, so that is part of what they are confirming.
    /* ⚠️ A Trupp that was never reported out belongs on this list (04.09.). It is not a missing
       Angabe — that is what `abschlussMissing` collects — but a fact about the Einsatz being
       closed over it: nobody said the crew came back, and from here on the board freezes at the
       Einsatzende, so this is the last moment anybody is asked. The Abschluss still goes through
       («Trotzdem abschliessen»), and it writes nothing by itself: closing an Einsatz must never
       put an Austritt on the record that nobody reported.
       ⚠️ Pending media belongs here too. The Abschluss closes the incident, and a Foto or a
       Sprachnotiz that never got a connection is still sitting on THIS device — the operator is
       about to walk away, so that is part of what they are confirming. */
    const points = abschlussOpenPoints(abschlussMissing, truppsStillOut, media.pendingCount)
    // …and it counts as an open point for the WORDING, the way a missing Angabe does: the message
    // and the button both have to say that something is being closed over.
    const anyOpen = points.some(countsAsOpen)
    const ok = await confirmDialog({
      title: A.confirmTitle,
      message: anyOpen ? P.exportIncompleteLead : A.confirmMsg,
      // ⚠️ Every row is a LINK, exactly as the print warning's rows are (lib/abschlussOpen).
      // Naming a gap on the last screen before the Akte closes and leaving the operator to hunt
      // for it is the same failure the «noch offen» chips fixed on the sheet itself. Tapping one
      // resolves the ask false — going there is not going ahead.
      items: abschlussOpenItems(points, {
        step: (st) => { setMode('rapport'); setPanel(null); requestReportStep(st) },
        trupps: () => { setMode('atemschutz'); setPanel(null) },
        media: () => setOfflineReadyOpen(true),
      }),
      note: anyOpen ? A.confirmMsg : undefined,
      // the button names what is actually about to happen — closing an Einsatz with open points
      // is allowed, and the label is where that is said out loud
      confirmLabel: anyOpen ? A.confirmAnyway : A.confirmBtn,
    })
    if (!ok) return false
    // ⚠️ Drain the media queue FIRST, from here. The Abschluss closes the incident and App then
    // drops what has already gone up (clearUploadedMedia) — and an upload also has to patch its
    // Verlauf row's blob: URL to the server one (useMediaQueue · onUploaded), which needs this
    // workspace and its journal store, both gone after the handover.
    await media.flush().catch(() => {})
    // …and the answer is the REAL outcome, not the firing of the request: App reports whether
    // the close went through, so the Rapport's kept scroll position survives a failed Abschluss
    // (offline, server error) instead of being forgotten for an Einsatz that is still open.
    return onCompleteRapport()
  // requestReportStep is a module-level loader of the caller's — stable, so naming it changes nothing
  }, [abschlussMissing, truppsStillOut, media, onCompleteRapport, setMode, setPanel, setOfflineReadyOpen, requestReportStep])

  return { abschlussMissing, truppsStillOut, azFrozenAt, azMonitoring, confirmAndComplete }
}

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { listIncidentsShared, type IncidentMeta } from './incidents'
import { freshAlarmCandidate, loadDismissedIncidents, saveDismissedIncident } from './incidentAlerts'
import { markAlarmPoll } from './alarmPollHealth'
import { useResumingPoll, WATCH_POLL_MS, WATCH_RESUME_GAP_MS } from './useResumingPoll'

/** no boot decided from another list: the first round is the baseline */
const NO_BASIS: RefObject<IncidentMeta[] | null> = { current: null }

/**
 * Always-on incident-list watch. With alarm auto-open, a new Einsatz can appear with no
 * human in the loop (Divera auto-take, generic /api/alarms intake, or a colleague's take
 * on another device) — this hook keeps the open-incident list fresh on a 30 s tick and
 * surfaces the newest such arrival for the «Neuer Einsatz» banner. It never switches the
 * active incident itself: announcing is this hook's job, switching is the user's.
 */
export function useIncidentWatch(
  enabled: boolean,
  activeId: string | null,
  /** every round's list; `offline` = the device's cached copy, not the server's */
  onList: (list: IncidentMeta[], offline: boolean) => void,
  /** the list the boot's pick was made from, when that was not the first round's: a boot that
   *  stopped waiting decided from the device's copy (lib/bootWait), and an alarm Einsatz the late
   *  list brings is a mid-session arrival for it */
  decidedFrom: RefObject<IncidentMeta[] | null> = NO_BASIS,
): { fresh: IncidentMeta | null; dismiss: () => void } {
  const [fresh, setFresh] = useState<IncidentMeta | null>(null)
  // ids seen on the first poll of this session: pre-existing incidents never banner (the
  // cold-start pick already handled them), only mid-session arrivals do.
  const baseline = useRef<Set<string> | null>(null)
  // A round can settle after this watch unmounted (sign-out remounts the app): its answer must not
  // reach the shared readiness sign, which the next session's watches own (as in useDiveraWatch).
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Read through a ref: as a dependency of `refresh` it rebuilt the poll on every Einsatz open or
  // switch, and a rebuilt poll starts with a round of its own (09.11.2026).
  const activeIdRef = useRef(activeId)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])

  // The cadence, the foreground resume and the one-round-at-a-time guard are useResumingPoll's;
  // this is only what a round does. The first round shares the boot's request (listIncidentsShared).
  // Every round reports to the readiness sign (lib/alarmPollHealth · «Bereit für Alarme»): the
  // device's cached list is no answer from the server.
  const refresh = useCallback(async () => {
    const { list, offline } = await listIncidentsShared().catch((e: unknown) => {
      if (mounted.current) markAlarmPoll(false)
      throw e
    })
    if (!mounted.current) return
    markAlarmPoll(!offline)
    onList(list, offline)
    if (baseline.current === null) {
      const basis = decidedFrom.current
      baseline.current = new Set((basis ?? list).map((i) => i.id))
      if (!basis) return
    }
    setFresh(
      freshAlarmCandidate(list, {
        activeId: activeIdRef.current,
        baselineIds: baseline.current,
        dismissed: loadDismissedIncidents(),
        now: Date.now(),
      }),
    )
  }, [onList, decidedFrom])

  useResumingPoll(enabled, refresh, { pollMs: WATCH_POLL_MS, resumeGapMs: WATCH_RESUME_GAP_MS })

  // a watch that is off announces nothing
  useEffect(() => { if (!enabled) setFresh(null) }, [enabled])

  // switching to the announced incident (banner tap or any other way) retires the banner
  useEffect(() => {
    if (fresh && fresh.id === activeId) setFresh(null)
  }, [fresh, activeId])

  const dismiss = useCallback(() => {
    setFresh((f) => {
      if (f) saveDismissedIncident(f.id)
      return null
    })
  }, [])

  return { fresh, dismiss }
}

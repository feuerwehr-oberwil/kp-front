import { useCallback, useEffect, useRef, useState } from 'react'
import { listIncidentsResilient, type IncidentMeta } from './incidents'
import { freshAlarmCandidate, loadDismissedIncidents, saveDismissedIncident } from './incidentAlerts'

const POLL_MS = 30_000
const RESUME_MIN_GAP_MS = 10_000 // same foreground-refresh floor as useDiveraWatch

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
  onList: (list: IncidentMeta[]) => void,
): { fresh: IncidentMeta | null; dismiss: () => void } {
  const [fresh, setFresh] = useState<IncidentMeta | null>(null)
  // ids seen on the first poll of this session: pre-existing incidents never banner (the
  // cold-start pick already handled them), only mid-session arrivals do.
  const baseline = useRef<Set<string> | null>(null)
  const busy = useRef(false)
  const lastAt = useRef(0)

  const refresh = useCallback(async () => {
    if (!enabled || busy.current) return
    busy.current = true
    try {
      const { list } = await listIncidentsResilient()
      onList(list)
      if (baseline.current === null) {
        baseline.current = new Set(list.map((i) => i.id))
        return
      }
      setFresh(
        freshAlarmCandidate(list, {
          activeId,
          baselineIds: baseline.current,
          dismissed: loadDismissedIncidents(),
          now: Date.now(),
        }),
      )
    } catch {
      /* transient failure — keep the last-known state */
    } finally {
      lastAt.current = Date.now()
      busy.current = false
    }
  }, [enabled, activeId, onList])

  useEffect(() => {
    if (!enabled) { setFresh(null); return }
    void refresh()
    const t = setInterval(() => void refresh(), POLL_MS)
    const onVis = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastAt.current >= RESUME_MIN_GAP_MS) void refresh()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [enabled, refresh])

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

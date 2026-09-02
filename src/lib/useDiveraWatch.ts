import { useCallback, useEffect, useState } from 'react'
import { getDiveraPool, refreshDiveraPool, type DiveraAlarm } from './incidents'
import { useResumingPoll, WATCH_POLL_MS, WATCH_RESUME_GAP_MS } from './useResumingPoll'

/**
 * Always-on Divera watch (editor only). On an interval — and whenever the tab regains
 * focus — it actively re-polls Divera (backstopping the backend's slow ~2 min background
 * poll) and reads the untaken-alarm pool, so a fresh dispatch surfaces within seconds
 * wherever the EL is: the empty state OR over a live incident. Returns the current pool
 * (newest-first, as the backend sorts it) plus a manual refresh used after a take.
 */
export function useDiveraWatch(enabled: boolean): { alarms: DiveraAlarm[]; refresh: () => Promise<void> } {
  const [alarms, setAlarms] = useState<DiveraAlarm[]>([])

  // The cadence, the foreground resume and the one-round-at-a-time guard are useResumingPoll's
  // (which also keeps the last-known pool on a transient failure — never blank the banner).
  const refresh = useCallback(async () => {
    // Actively poll Divera first; swallow 503 "nicht konfiguriert" / network errors so we
    // still read whatever is already mirrored in the pool.
    await refreshDiveraPool().catch(() => {})
    setAlarms(await getDiveraPool())
  }, [])

  const run = useResumingPoll(enabled, refresh, { pollMs: WATCH_POLL_MS, resumeGapMs: WATCH_RESUME_GAP_MS })

  // a watch that is off shows no pool
  useEffect(() => { if (!enabled) setAlarms([]) }, [enabled])

  return { alarms, refresh: run }
}

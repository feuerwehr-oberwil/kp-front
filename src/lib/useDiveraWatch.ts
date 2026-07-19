import { useCallback, useEffect, useRef, useState } from 'react'
import { getDiveraPool, refreshDiveraPool, type DiveraAlarm } from './incidents'

const POLL_MS = 30_000
// A tablet gets picked up / put down constantly; without a floor, every foreground fired a
// Divera + backend round-trip. Skip the resume-refresh if we polled within this window (the 30 s
// interval keeps the pool fresh anyway).
const RESUME_MIN_GAP_MS = 10_000

/**
 * Always-on Divera watch (editor only). On an interval — and whenever the tab regains
 * focus — it actively re-polls Divera (backstopping the backend's slow ~2 min background
 * poll) and reads the untaken-alarm pool, so a fresh dispatch surfaces within seconds
 * wherever the EL is: the empty state OR over a live incident. Returns the current pool
 * (newest-first, as the backend sorts it) plus a manual refresh used after a take.
 */
export function useDiveraWatch(enabled: boolean): { alarms: DiveraAlarm[]; refresh: () => Promise<void> } {
  const [alarms, setAlarms] = useState<DiveraAlarm[]>([])
  const busy = useRef(false)
  const lastAt = useRef(0)

  const refresh = useCallback(async () => {
    if (!enabled || busy.current) return
    busy.current = true
    try {
      // Actively poll Divera first; swallow 503 "nicht konfiguriert" / network errors so we
      // still read whatever is already mirrored in the pool.
      await refreshDiveraPool().catch(() => {})
      setAlarms(await getDiveraPool())
    } catch {
      /* keep the last-known pool on a transient failure — never blank the banner */
    } finally {
      lastAt.current = Date.now()
      busy.current = false
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) { setAlarms([]); return }
    void refresh()
    const t = setInterval(() => void refresh(), POLL_MS)
    const onVis = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastAt.current >= RESUME_MIN_GAP_MS) void refresh()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [enabled, refresh])

  return { alarms, refresh }
}

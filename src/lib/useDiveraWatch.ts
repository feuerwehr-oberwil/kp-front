import { useCallback, useEffect, useRef, useState } from 'react'
import { getDiveraPool, type DiveraAlarm } from './incidents'
import { markAlarmPoll } from './alarmPollHealth'
import { useResumingPoll, WATCH_POLL_MS, WATCH_RESUME_GAP_MS } from './useResumingPoll'

/**
 * Always-on Divera watch (editor only). On an interval — and whenever the tab regains focus — it
 * READS the untaken-alarm pool, so a fresh dispatch surfaces within seconds wherever the EL is:
 * the empty state OR over a live incident. Returns the current pool (newest-first, as the backend
 * sorts it) plus a manual re-read used after a take.
 *
 * ⚠️ It never asks the server to poll Divera (24.09.2026, D2). It used to `POST
 * /divera/pool/refresh` on every round, so every editor device made the server call Divera every
 * 30 s, Einsatz or not — 469 Divera calls in one Übung, and a 429 risk on the one integration an
 * alarm depends on. The pool is filled by the webhook (primary) and by the server's own poll:
 * 30 s while no Einsatz runs, 120 s while one does, backing off on 429 (backend ·
 * scheduler._divera_tick). A device only reads what is there. «Aktualisieren» in /admin › Daten
 * still asks for a poll on purpose, by hand.
 */
export function useDiveraWatch(enabled: boolean): { alarms: DiveraAlarm[]; refresh: () => Promise<void> } {
  const [alarms, setAlarms] = useState<DiveraAlarm[]>([])
  // the pool on screen, as text: what a round's answer is compared with
  const shown = useRef('[]')
  // A round can settle after this watch unmounted (sign-out remounts the app): its answer must not
  // reach the shared readiness sign, which the next session's watches own.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // The cadence, the foreground resume and the one-round-at-a-time guard are useResumingPoll's
  // (which also keeps the last-known pool on a transient failure — never blank the banner).
  // Every round reports to the readiness sign (lib/alarmPollHealth · «Bereit für Alarme»).
  // An answer equal to the pool on screen sets nothing: a new (usually empty) array every 30 s
  // rendered App and the whole workspace for nothing (perf sweep 26.11.2026). Not a functional
  // update that returns `prev` – React can still render once before it bails out.
  const refresh = useCallback(async () => {
    try {
      const pool = await getDiveraPool()
      if (!mounted.current) return
      const text = JSON.stringify(pool)
      if (text !== shown.current) { shown.current = text; setAlarms(pool) }
      markAlarmPoll(true)
    } catch (e) {
      if (mounted.current) markAlarmPoll(false)
      throw e
    }
  }, [])

  const run = useResumingPoll(enabled, refresh, { pollMs: WATCH_POLL_MS, resumeGapMs: WATCH_RESUME_GAP_MS })

  // a watch that is off shows no pool
  useEffect(() => { if (!enabled) { shown.current = '[]'; setAlarms([]) } }, [enabled])

  return { alarms, refresh: run }
}

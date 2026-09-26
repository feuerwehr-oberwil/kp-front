import { useCallback, useEffect, useState } from 'react'
import { getDiveraPool, type DiveraAlarm } from './incidents'
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

  // The cadence, the foreground resume and the one-round-at-a-time guard are useResumingPoll's
  // (which also keeps the last-known pool on a transient failure — never blank the banner).
  const refresh = useCallback(async () => {
    setAlarms(await getDiveraPool())
  }, [])

  const run = useResumingPoll(enabled, refresh, { pollMs: WATCH_POLL_MS, resumeGapMs: WATCH_RESUME_GAP_MS })

  // a watch that is off shows no pool
  useEffect(() => { if (!enabled) setAlarms([]) }, [enabled])

  return { alarms, refresh: run }
}

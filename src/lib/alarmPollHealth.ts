import { useEffect, useState, useSyncExternalStore } from 'react'

// Does this device still hear the server's alarms? The answer behind the Karte head's «Bereit für
// Alarme» (owner pick UX journeys B3·6, 25.11.2026 – karte/AlarmReadiness · AlarmReadyPill).
// The two always-on watches that bring an alarm to the screen report every round here: the
// incident list (useIncidentWatch – an Einsatz that opened by itself, every account) and the
// Divera pool (useDiveraWatch – an untaken dispatch, editors). Both ask the same server, so the
// last answer of either one is the device's answer. Nothing is stored: a reload starts unknown.

/** Green only while the last good answer is younger than this – two rounds of the 30 s watch. */
export const READY_MAX_AGE_MS = 60_000

export interface AlarmPollHealth {
  /** when a watch round last reached the server */
  okAt: number | null
  /** whether the last round reached the server (`false` = it failed or was served from the
   *  device's cache); kept as the outcome, not a time – two rounds can end in the same millisecond */
  lastOk: boolean | null
}

let health: AlarmPollHealth = { okAt: null, lastOk: null }
const listeners = new Set<() => void>()

/** A watch round ended: `ok` = the server answered. */
export function markAlarmPoll(ok: boolean, now = Date.now()): void {
  health = ok ? { okAt: now, lastOk: true } : { ...health, lastOk: false }
  for (const fn of listeners) fn()
}

/** `ready` while the last round reached the server less than 60 s ago, `down` once a round failed
 *  after it or it is older, `null` before any round has answered (the sign shows nothing). */
export function pollReadiness(h: AlarmPollHealth, now: number): 'ready' | 'down' | null {
  if (h.lastOk == null) return null
  if (!h.lastOk || h.okAt == null) return 'down'
  return now - h.okAt < READY_MAX_AGE_MS ? 'ready' : 'down'
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const read = () => health

/** The health and its readiness, re-read every 5 s so a watch that stopped answering turns the
 *  sign red without a round of its own. */
export function useAlarmPollHealth(): AlarmPollHealth & { state: 'ready' | 'down' | null } {
  const h = useSyncExternalStore(subscribe, read, read)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(t)
  }, [])
  // a good answer newer than the last tick is fresh at once, not 5 s later
  return { ...h, state: pollReadiness(h, Math.max(now, h.okAt ?? 0)) }
}

// Per-device dismissal of the Meldeleiste's «Neuer Alarm» row (localStorage `kp.divera.dismissed`).
// Its ✕ puts THE ROW away on this device, nothing else (owner, 17.11.2026: «Just list it, no hidden
// state»): it NEVER archives/removes the dispatch for the crew (that would be a server-side,
// everyone-sees-it delete), and the alarm stays listed in the «Einsätze» lists – home's and the
// Einsatz menu – as an alarm nobody opened (`waitingAlarms`) until it is taken or 3 h old.
import type { DiveraAlarm } from './incidents'

const KEY = 'kp.divera.dismissed'
const CAP = 50 // keep the tiny pref bounded

export function loadDismissedAlarms(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as number[])
  } catch {
    return new Set()
  }
}

/** Add `id` to this device's dismissed set (bounded) and return the new set. */
export function dismissAlarm(id: number): Set<number> {
  const ids = [...loadDismissedAlarms().add(id)].slice(-CAP)
  try {
    localStorage.setItem(KEY, JSON.stringify(ids))
  } catch {
    /* private mode — dismissal is best-effort, session-only then */
  }
  return new Set(ids)
}

const ALARM_MAX_AGE_MS = 3 * 60 * 60 * 1000 // only surface dispatches < 3h old
/** Is an alarm that arrived at `at` (ISO) still inside the 3-h window its row stands in? Also the
 *  window of a hidden «Alarm aktualisiert»'s menu row (lib/alarmUpdate · alarmUpdateHidden). */
export function inAlarmWindow(at: string, now = Date.now()): boolean {
  // age < 3h; no lower bound so minor server/device clock skew can't hide a fresh alarm
  const age = now - new Date(at).getTime()
  return Number.isFinite(age) && age < ALARM_MAX_AGE_MS
}
/** The alarms waiting to be opened, as the «Einsätze» lists carry them: younger than 3 h (the pool
 *  holds only untaken ones, but keeps them for ever), whether or not the row was ✕-ed here. */
export function waitingAlarms(alarms: DiveraAlarm[], now = Date.now()): DiveraAlarm[] {
  return alarms.filter((a) => inAlarmWindow(a.received_at, now))
}

/** The pool alarms the Meldeleiste row can actually show: not dismissed on this device, younger than 3 h.
 *  ⚠️ Whoever asks «is the alarm row busy» asks THIS, never the raw pool – the pool endpoint has
 *  no age limit, and one stale or ×-ed alarm used to hide the «Neuer Einsatz» row for good
 *  (sweep 09.11.2026, UX.6). */
export function shownAlarms(alarms: DiveraAlarm[], dismissed: ReadonlySet<number>, now = Date.now()): DiveraAlarm[] {
  return waitingAlarms(alarms, now).filter((a) => !dismissed.has(a.divera_id))
}

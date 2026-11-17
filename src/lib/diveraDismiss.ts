// Per-device dismissal of Divera pool alarms (localStorage `kp.divera.dismissed`). This is a purely
// LOCAL "hide it on my tablet" action; it NEVER archives/removes the dispatch for the crew (that
// would be a server-side, everyone-sees-it delete). Shared by the incoming-alarm row, the home
// list and the «Einsätze» menu so all three behave the same.
// ✕ is not «gone for good» (rare-user round M3 = C, 17.11.2026): a hidden alarm folds to a grey
// strip in the row's own place – «Ausgeblendet · <Stichwort> · Zeigen» – for as long as it would
// have shown (untaken, younger than 3 h; `hiddenAlarms`), and «Zeigen» takes it out of the set
// again (`undismissAlarm`). No toast: the strip is the way back.
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

/** «Zeigen» on the strip: take `id` out of this device's dismissed set and return the new set. */
export function undismissAlarm(id: number): Set<number> {
  const ids = [...loadDismissedAlarms()].filter((x) => x !== id)
  try {
    localStorage.setItem(KEY, JSON.stringify(ids))
  } catch {
    /* private mode — see dismissAlarm */
  }
  return new Set(ids)
}

const ALARM_MAX_AGE_MS = 3 * 60 * 60 * 1000 // only surface dispatches < 3h old
/** Is an alarm that arrived at `at` (ISO) still inside the 3-h window a row – or a strip – stands
 *  in? Also the «Alarm aktualisiert» strip's window (panels/Banners · AlarmUpdateBanner). */
export function inAlarmWindow(at: string, now = Date.now()): boolean {
  // age < 3h; no lower bound so minor server/device clock skew can't hide a fresh alarm
  const age = now - new Date(at).getTime()
  return Number.isFinite(age) && age < ALARM_MAX_AGE_MS
}
const young = (a: DiveraAlarm, now: number) => inAlarmWindow(a.received_at, now)

/** The pool alarms the row can actually show: not dismissed on this device, younger than 3 h.
 *  ⚠️ Whoever asks «is the alarm row busy» asks THIS, never the raw pool – the pool endpoint has
 *  no age limit, and one stale or ×-ed alarm used to hide the «Neuer Einsatz» row for good
 *  (sweep 09.11.2026, UX.6). */
export function shownAlarms(alarms: DiveraAlarm[], dismissed: ReadonlySet<number>, now = Date.now()): DiveraAlarm[] {
  return alarms.filter((a) => !dismissed.has(a.divera_id) && young(a, now))
}

/** The alarms hidden on this device that still stand as a strip: the same window as `shownAlarms`
 *  (the pool holds only untaken ones), so a taken or 3-h-old alarm leaves no strip behind. */
export function hiddenAlarms(alarms: DiveraAlarm[], dismissed: ReadonlySet<number>, now = Date.now()): DiveraAlarm[] {
  return alarms.filter((a) => dismissed.has(a.divera_id) && young(a, now))
}

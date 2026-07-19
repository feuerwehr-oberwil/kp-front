// Per-device dismissal of Divera pool alarms (localStorage `kp.divera.dismissed`). A given
// alarm nags only once on THIS device — across reloads, and whether it was X'd or taken. This
// is a purely LOCAL "hide it on my tablet" action; it NEVER archives/removes the dispatch for
// the crew (that would be a server-side, everyone-sees-it delete). Shared by the incoming-alarm
// banner and the landing launch list so both behave the same.
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
